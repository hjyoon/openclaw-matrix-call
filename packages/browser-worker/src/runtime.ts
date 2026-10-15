import { ClientEvent, EventType, type MatrixClient, type ReceivedToDeviceMessage } from "matrix-js-sdk";
import { MatrixRTCSessionEvent, type MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/index.js";
import type { IRTCNotificationContent } from "matrix-js-sdk/lib/matrixrtc/types.js";
import { RoomEvent, Track } from "livekit-client";
import type { ParticipantReference, PcmAudio } from "@matrix-call/core";
import { MatrixMediaKeyProvider, VerifiedMatrixRtcKeys, MatrixRtcParticipantVerifier, membershipSnapshot, OpenIdFocusAuthorizer, FocusAuthorizationError, type FocusAuthorizationPort, type FocusAuthorizationSource, type OutboundKeySource } from "../../matrixrtc/src/index.js";
import { createMatrixClient, enrollPinnedDevices, initializeMatrixClient, joinedEncryptedRoom } from "./client.js";
import { createBrowserMedia, type BrowserMedia } from "./media.js";
import { MatrixPublicationGuard, MatrixPublicationChangedError } from "./guard.js";
import type { BrowserDial, BrowserSetup } from "./types.js";
import { VerifiedAudioInbox } from "./inbox.js";
import { retainCapture } from "./capture-authority.js";
import { cancelable } from "../../voice/src/cancellation.js";

type ActiveCall = {
  roomId: string;
  session: MatrixRTCSession;
  media: BrowserMedia;
  keys: VerifiedMatrixRtcKeys;
  guard: MatrixPublicationGuard;
  controller: AbortController;
  connected: boolean;
  receive: (message: ReceivedToDeviceMessage) => void;
  changed: () => void;
  stateFailed: () => void;
  mediaFailed: () => void;
  encryptionFailed: (error: Error) => void;
  subscribe: () => void;
  notified: (notice: { event_id: string } & IRTCNotificationContent) => void;
  timer: ReturnType<typeof setInterval> | undefined;
  closing: Promise<void> | undefined;
  input: VerifiedAudioInbox;
  playing: boolean;
  outbound: Readonly<{ recipientId: string; expiresAtMs: number }> | undefined;
};

export async function waitUntil(predicate: () => boolean, signal: AbortSignal): Promise<void> {
  while (!predicate()) {
    signal.throwIfAborted();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  signal.throwIfAborted();
}

export async function refreshPublication(guard: MatrixPublicationGuard, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    try {
      await guard.refresh();
      signal.throwIfAborted();
      if (guard.permits(guard.revision)) return;
    } catch (error) { if (!(error instanceof MatrixPublicationChangedError)) throw error; }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

export async function authorizeFocus(authorizer: FocusAuthorizationPort, source: FocusAuthorizationSource, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    try { return await authorizer.authorize(source, signal); }
    catch (error) { if (!(error instanceof FocusAuthorizationError) || error.code !== "membership-changed") throw error; }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

export function publicationFailure(error: unknown): string {
  const reasons: readonly (readonly [string, string])[] = [
    ["MatrixRTC local membership is unavailable", "local-membership"],
    ["MatrixRTC listener is not authorized", "listener-policy"],
    ["MatrixRTC listener device is not verified", "listener-trust"],
    ["MatrixRTC crypto is unavailable", "crypto"],
  ];
  return error instanceof Error ? reasons.find(([message]) => error.message === message)?.[1] ?? "listeners" : "listeners";
}

export class BrowserMatrixRuntime {
  readonly #setup: BrowserSetup;
  readonly #client: MatrixClient;
  readonly #mediaFactory: typeof createBrowserMedia;
  readonly #authorizer: FocusAuthorizationPort;
  #initialized = false;
  #prepared = false;
  #stopped = false;
  #call: ActiveCall | undefined;

  constructor(setup: BrowserSetup, client = createMatrixClient(setup.credentials), mediaFactory = createBrowserMedia,
    authorizer: FocusAuthorizationPort = new OpenIdFocusAuthorizer(setup.policy)) {
    this.#setup = setup;
    this.#client = client;
    this.#mediaFactory = mediaFactory;
    this.#authorizer = authorizer;
  }

  async initialize() {
    if (this.#initialized || this.#stopped) throw new Error("Matrix runtime cannot initialize again");
    this.#initialized = true;
    try { return await initializeMatrixClient(this.#client, this.#setup); }
    catch (error) { this.#stopped = true; this.#client.stopClient(); throw error; }
  }

  async prepare(): Promise<void> {
    if (!this.#initialized || this.#stopped) throw new Error("Matrix runtime is unavailable");
    const signal = AbortSignal.timeout(30_000);
    await waitUntil(() => this.#setup.policy.rooms.every((id) => Boolean(joinedEncryptedRoom(this.#client, id))), signal);
    await cancelable(Promise.all(this.#setup.policy.rooms.map((id) => this.#client.getRoom(id)!.loadMembersIfNeeded())), signal);
    await enrollPinnedDevices(this.#client, this.#setup, signal);
    this.#prepared = true;
  }

  status() {
    return Object.freeze({ initialized: this.#initialized, prepared: this.#prepared && !this.#stopped,
      roomId: this.#call?.roomId ?? null, connected: this.#call?.connected === true && !this.#call.controller.signal.aborted });
  }

  async recipientRoom(recipientId: string, preferredRoomId?: string): Promise<string> {
    if (!this.#prepared || this.#stopped || !this.#setup.policy.selfCalls || recipientId === this.#setup.credentials.userId || !/^@[^:\s]+:[^\s]+$/.test(recipientId)) throw new Error("Self calling is unavailable");
    const rooms = this.#client.getRooms();
    if (rooms.length > 256) throw new Error("Room discovery capacity exceeded");
    const candidates = rooms.filter((room) => joinedEncryptedRoom(this.#client, room.roomId) && room.getJoinedMemberCount() === 2)
      .sort((a, b) => Number(b.roomId === preferredRoomId) - Number(a.roomId === preferredRoomId) || a.roomId.localeCompare(b.roomId));
    const signal = AbortSignal.timeout(30_000);
    for (const room of candidates) {
      await cancelable(room.loadMembersIfNeeded(), signal);
      const members = room.getMembersWithMembership("join");
      if (members.length !== 2 || !members.some((member) => member.userId === recipientId) || !members.some((member) => member.userId === this.#setup.credentials.userId)) continue;
      const cryptoApi = this.#client.getCrypto()!;
      cryptoApi.prepareToEncrypt(room);
      const devices = await cancelable(cryptoApi.getUserDeviceInfo([recipientId], true), signal);
      for (const deviceId of devices.get(recipientId)?.keys() ?? []) {
        const proof = await cancelable(cryptoApi.getDeviceVerificationStatus(recipientId, deviceId), signal);
        if (proof?.isVerified()) return room.roomId;
      }
      throw new Error("Recipient device verification required");
    }
    throw new Error("Private encrypted two-person room required");
  }

  async connect(roomId: string, outbound?: BrowserDial): Promise<void> {
    if (!this.#prepared || this.#stopped || this.#call) throw new Error("Matrix runtime is unavailable or busy");
    if (!(outbound?.selfCall && this.#setup.policy.selfCalls) && !this.#setup.policy.rooms.includes(roomId)) throw new Error("Matrix room is not configured");
    const room = joinedEncryptedRoom(this.#client, roomId);
    if (!room) throw new Error("Joined encrypted Matrix room is unavailable");
    const session = this.#client.matrixRTC.getRoomSession(room);
    const slotId = session.slotId;
    if (slotId !== "m.call#ROOM") throw new Error("MatrixRTC slot is not supported");
    if (outbound) {
      const members = room.getMembersWithMembership("join");
      const { userId, deviceId } = this.#setup.credentials;
      if (outbound.recipientId === userId || (!(outbound.selfCall && this.#setup.policy.selfCalls) && !this.#setup.policy.owners.includes(outbound.recipientId)) ||
          !Number.isInteger(outbound.ringTimeoutMs) || outbound.ringTimeoutMs < 1000 || outbound.ringTimeoutMs > 60_000 ||
          room.getJoinedMemberCount() !== 2 || members.length !== 2 || !members.some((member) => member.userId === userId) ||
          !members.some((member) => member.userId === outbound.recipientId)) throw new Error("Outbound recipient requires an authorized two-party room");
      if (session.memberships.some((member) => member.userId !== userId || member.deviceId !== deviceId)) throw new Error("MatrixRTC room already has an active call");
    }
    const provider = new MatrixMediaKeyProvider();
    const media = this.#mediaFactory(provider);
    const memberships = () => session.memberships.map(membershipSnapshot);
    const { userId, deviceId } = this.#setup.credentials;
    const own = () => memberships().filter((member) => member.userId === userId && member.deviceId === deviceId);
    let notificationSent = false;
    const notified = (notice: { event_id: string } & IRTCNotificationContent): void => {
      const local = session.memberships.filter((member) => member.userId === userId && member.deviceId === deviceId);
      if (notice.notification_type === "ring" && notice.slot_id === slotId && notice.event_id &&
          notice["m.relates_to"]?.event_id && local.length === 1 && notice["m.relates_to"].event_id === local[0]!.eventId) notificationSent = true;
    };
    const listeners = outbound ? [outbound.recipientId] : this.#setup.policy.owners;
    const keys = new VerifiedMatrixRtcKeys({ roomId, owners: listeners, memberships, now: Date.now }, provider);
    const source: OutboundKeySource = { roomId, owners: listeners, memberships, client: this.#client,
      isJoined: () => session.isJoined(), now: Date.now, sink: provider };
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const guard = new MatrixPublicationGuard(source, media);
    const fail = (reason: string): void => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`Matrix call ended: ${reason}`));
        void this.#disconnect(call).catch(() => {});
      }
    };
    const stateFailed = (): void => fail("state");
    const mediaFailed = (): void => fail("media");
    const encryptionFailed = (error: Error): void => fail(error.message.startsWith("MissingKey:") ? "missing-key" : (error.message.startsWith("InvalidKey:") ? "invalid-key" : "encryption"));
    const subscribe = (): void => {
      for (const participant of media.room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.kind === Track.Kind.Audio) publication.setSubscribed(keys.hasCurrentKey(participant.identity));
        }
      }
    };
    const receive = (message: ReceivedToDeviceMessage): void => {
      if (message.message.type === EventType.CallEncryptionKeysPrefix) void keys.receive(message).then((accepted) => { if (accepted) subscribe(); }).catch(() => fail("keys"));
    };
    const refresh = (): void => {
      media.suspend();
      subscribe();
      if (call.connected) void refreshPublication(guard, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])).catch((error) => fail(publicationFailure(error)));
    };
    let captureMemberships = memberships();
    const changed = (): void => {
      const current = memberships();
      if (!this.#localMembership(call) || !retainCapture(captureMemberships, current, Date.now())) call.input.reset();
      captureMemberships = current;
      refresh();
    };
    const input = new VerifiedAudioInbox({ verify: (reference, signal) => this.verify(reference, signal) },
      (reference) => this.#call === call && call.connected && !controller.signal.aborted && this.#localMembership(call) && keys.hasCurrentKey(reference.participantId),
      () => media.resetCapture());
    const call: ActiveCall = { roomId, session, media, keys, guard, controller, connected: false, receive, changed, stateFailed, mediaFailed, encryptionFailed, subscribe, notified, timer: undefined, closing: undefined, input, playing: false,
      outbound: outbound && { recipientId: outbound.recipientId, expiresAtMs: Date.now() + outbound.ringTimeoutMs } };
    this.#call = call;
    this.#client.on(ClientEvent.ReceivedToDeviceMessage, receive);
    session.on(MatrixRTCSessionEvent.MembershipsChanged, changed);
    session.on(MatrixRTCSessionEvent.MembershipManagerError, stateFailed);
    session.on(MatrixRTCSessionEvent.DidSendCallNotification, notified);
    media.room.on(RoomEvent.Disconnected, mediaFailed);
    media.room.on(RoomEvent.EncryptionError, encryptionFailed);
    media.room.on(RoomEvent.TrackPublished, subscribe);
    try {
      if (this.#setup.captureAudio) await media.startCapture((identity, audio) => {
        void input.accept({ roomId, rtcSessionId: slotId, participantId: identity }, audio).catch(() => fail("capture"));
      }, (identity) => input.listening && call.connected && !controller.signal.aborted && this.#localMembership(call) && keys.hasCurrentKey(identity), () => fail("capture"));
      session.joinRTCSession({ userId, deviceId, memberId: `${userId}:${deviceId}` }, [
        { type: "livekit", livekit_service_url: this.#setup.policy.focusUrls[0]!, livekit_alias: roomId },
      ], undefined, { manageMediaKeys: false, callIntent: "audio", membershipEventExpiryMs: 60_000, delayedLeaveEventDelayMs: 5_000, delayedLeaveEventRestartMs: 2_000,
        ...(outbound ? { notificationType: "ring" as const, notificationLifetimeMs: outbound.ringTimeoutMs } : {}) });
      await waitUntil(() => session.isJoined() && own().length === 1, signal);
      if (outbound) await waitUntil(() => notificationSent, signal);
      await refreshPublication(guard, signal);
      const grant = await authorizeFocus(this.#authorizer, { roomId, slotId, client: this.#client,
        focus: () => { const oldest = session.getOldestMembership(); return oldest?.getTransport(oldest); },
        membership: () => { const matches = own(); return matches.length === 1 ? matches[0] : undefined; },
      }, signal);
      signal.throwIfAborted();
      await media.connect(grant.url, grant.jwt, grant.identity);
      signal.throwIfAborted();
      subscribe();
      call.connected = true;
      await refreshPublication(guard, signal);
      call.timer = setInterval(() => { if (!call.playing) refresh(); }, 5_000);
    } catch (error) {
      await this.#disconnect(call);
      throw error;
    }
  }

  async recipient(recipientId: string): Promise<ParticipantReference | null> {
    const call = this.#call;
    if (!call?.connected || call.controller.signal.aborted || call.outbound?.recipientId !== recipientId) throw new Error("Outbound call is unavailable");
    if (Date.now() >= call.outbound.expiresAtMs) throw new Error("Outbound answer deadline expired");
    const members = call.session.memberships.filter((member) => member.userId === recipientId);
    if (members.length > 1) throw new Error("Outbound recipient membership is ambiguous");
    const member = members[0];
    if (!member || !call.keys.hasCurrentKey(member.rtcBackendIdentity)) return null;
    const participant = call.media.room.remoteParticipants.get(member.rtcBackendIdentity);
    if (!participant || ![...participant.trackPublications.values()].some((publication) => publication.kind === Track.Kind.Audio &&
      publication.isEncrypted && publication.isSubscribed && publication.track?.mediaStreamTrack.readyState === "live")) return null;
    const reference = { roomId: call.roomId, rtcSessionId: "m.call#ROOM", participantId: member.rtcBackendIdentity };
    const proof = await this.verify(reference, call.controller.signal);
    if (proof.userId !== recipientId) throw new Error("Outbound recipient identity changed");
    if (Date.now() >= call.outbound.expiresAtMs) throw new Error("Outbound answer deadline expired");
    return Object.freeze(reference);
  }

  async publish(audio: PcmAudio, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const call = this.#call;
    if (!call?.connected || call.controller.signal.aborted) throw new Error("Matrix media is unavailable");
    await refreshPublication(call.guard, AbortSignal.any([signal, call.controller.signal, AbortSignal.timeout(30_000)]));
    signal.throwIfAborted();
    const revision = call.guard.revision;
    if (!call.guard.permits(revision)) throw new Error("Matrix publication is suspended");
    const listening = call.input.listening;
    call.input.pause(); call.playing = true;
    try { await call.media.publish(audio, AbortSignal.any([signal, call.controller.signal])); }
    finally { call.playing = false; if (listening) call.input.resume(); }
    signal.throwIfAborted();
    if (!call.guard.permits(call.guard.revision)) throw new Error("Matrix publication changed during playback");
  }

  async verify(reference: ParticipantReference, signal: AbortSignal) {
    const call = this.#call;
    if (!call?.connected || call.controller.signal.aborted || !this.#localMembership(call)) throw new Error("Matrix media is unavailable");
    const proof = await new MatrixRtcParticipantVerifier({ roomId: call.roomId, client: this.#client, session: call.session,
      media: call.media.room, keys: call.keys, now: Date.now }).verify(reference, signal);
    if (this.#call !== call || call.controller.signal.aborted || !this.#localMembership(call)) throw new Error("Matrix media is unavailable");
    return proof;
  }

  #localMembership(call: ActiveCall): boolean {
    const { userId, deviceId } = this.#setup.credentials;
    const members = call.session.memberships.filter((member) => member.userId === userId && member.deviceId === deviceId);
    if (!call.session.isJoined() || members.length !== 1) return false;
    const member = membershipSnapshot(members[0]!); const now = Date.now();
    return Number.isSafeInteger(member.createdAtMs) && member.createdAtMs >= 0 && member.createdAtMs <= now &&
      (member.expiresAtMs === undefined || (Number.isSafeInteger(member.expiresAtMs) && member.expiresAtMs > now));
  }

  takeAudio() { return this.#call?.input.take() ?? null; }

  resumeAudio(): void { this.#call?.input.resume(); }

  async disconnect(): Promise<void> {
    const call = this.#call;
    if (!call) return;
    return this.#disconnect(call);
  }

  #disconnect(call: ActiveCall): Promise<void> {
    if (call.closing) return call.closing;
    call.controller.abort(); call.input.close(); call.keys.close(); call.guard.close();
    clearInterval(call.timer);
    this.#client.off(ClientEvent.ReceivedToDeviceMessage, call.receive);
    call.session.off(MatrixRTCSessionEvent.MembershipsChanged, call.changed);
    call.session.off(MatrixRTCSessionEvent.MembershipManagerError, call.stateFailed);
    call.session.off(MatrixRTCSessionEvent.DidSendCallNotification, call.notified);
    call.media.room.off(RoomEvent.Disconnected, call.mediaFailed);
    call.media.room.off(RoomEvent.EncryptionError, call.encryptionFailed);
    call.media.room.off(RoomEvent.TrackPublished, call.subscribe);
    call.closing = (async () => {
      try { await call.media.close(); }
      finally { await call.session.leaveRoomSession(5_000); }
    })().catch((error) => { this.#stopped = true; throw error; }).finally(() => { this.#call = undefined; });
    return call.closing;
  }

  async close(): Promise<void> {
    this.#stopped = true;
    try { await this.disconnect(); }
    finally { this.#client.stopClient(); }
  }
}
