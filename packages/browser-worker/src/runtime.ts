import { ClientEvent, EventType, type MatrixClient, type ReceivedToDeviceMessage } from "matrix-js-sdk";
import { MatrixRTCSessionEvent, type MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { RoomEvent, Track } from "livekit-client";
import type { ParticipantReference, PcmAudio } from "@matrix-call/core";
import { MatrixMediaKeyProvider, VerifiedMatrixRtcKeys, MatrixRtcParticipantVerifier, membershipSnapshot, OpenIdFocusAuthorizer, FocusAuthorizationError, type FocusAuthorizationPort, type FocusAuthorizationSource, type OutboundKeySource } from "../../matrixrtc/src/index.js";
import { createMatrixClient, enrollPinnedDevices, initializeMatrixClient, joinedEncryptedRoom } from "./client.js";
import { createBrowserMedia, type BrowserMedia } from "./media.js";
import { MatrixPublicationGuard, MatrixPublicationChangedError } from "./guard.js";
import type { BrowserSetup } from "./types.js";

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
  timer: ReturnType<typeof setInterval> | undefined;
  closing: Promise<void> | undefined;
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
    await waitUntil(() => this.#setup.policy.rooms.every((id) => Boolean(joinedEncryptedRoom(this.#client, id))), AbortSignal.timeout(30_000));
    await enrollPinnedDevices(this.#client, this.#setup);
    this.#prepared = true;
  }

  status() {
    return Object.freeze({ initialized: this.#initialized, prepared: this.#prepared && !this.#stopped,
      roomId: this.#call?.roomId ?? null, connected: this.#call?.connected === true && !this.#call.controller.signal.aborted });
  }

  async connect(roomId: string): Promise<void> {
    if (!this.#prepared || this.#stopped || this.#call) throw new Error("Matrix runtime is unavailable or busy");
    if (!this.#setup.policy.rooms.includes(roomId)) throw new Error("Matrix room is not configured");
    const room = joinedEncryptedRoom(this.#client, roomId);
    if (!room) throw new Error("Joined encrypted Matrix room is unavailable");
    const session = this.#client.matrixRTC.getRoomSession(room);
    const slotId = session.slotId;
    if (slotId !== "m.call#ROOM") throw new Error("MatrixRTC slot is not supported");
    const provider = new MatrixMediaKeyProvider();
    const media = this.#mediaFactory(provider);
    const memberships = () => session.memberships.map(membershipSnapshot);
    const keys = new VerifiedMatrixRtcKeys({ roomId, owners: this.#setup.policy.owners, memberships, now: Date.now }, provider);
    const source: OutboundKeySource = { roomId, owners: this.#setup.policy.owners, memberships, client: this.#client,
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
    const changed = (): void => {
      media.suspend();
      subscribe();
      if (call.connected) void refreshPublication(guard, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])).catch(() => fail("listeners"));
    };
    const call: ActiveCall = { roomId, session, media, keys, guard, controller, connected: false, receive, changed, stateFailed, mediaFailed, encryptionFailed, subscribe, timer: undefined, closing: undefined };
    this.#call = call;
    this.#client.on(ClientEvent.ReceivedToDeviceMessage, receive);
    session.on(MatrixRTCSessionEvent.MembershipsChanged, changed);
    session.on(MatrixRTCSessionEvent.MembershipManagerError, stateFailed);
    media.room.on(RoomEvent.Disconnected, mediaFailed);
    media.room.on(RoomEvent.EncryptionError, encryptionFailed);
    media.room.on(RoomEvent.TrackPublished, subscribe);
    const { userId, deviceId } = this.#setup.credentials;
    const own = () => memberships().filter((member) => member.userId === userId && member.deviceId === deviceId);
    try {
      session.joinRTCSession({ userId, deviceId, memberId: `${userId}:${deviceId}` }, [
        { type: "livekit", livekit_service_url: this.#setup.policy.focusUrls[0]!, livekit_alias: roomId },
      ], undefined, { manageMediaKeys: false, callIntent: "audio", membershipEventExpiryMs: 60_000, delayedLeaveEventDelayMs: 5_000, delayedLeaveEventRestartMs: 2_000 });
      await waitUntil(() => session.isJoined() && own().length === 1, signal);
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
      call.timer = setInterval(changed, 5_000);
    } catch (error) {
      await this.#disconnect(call);
      throw error;
    }
  }

  async publish(audio: PcmAudio, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const call = this.#call;
    if (!call?.connected || call.controller.signal.aborted) throw new Error("Matrix media is unavailable");
    await refreshPublication(call.guard, AbortSignal.any([signal, call.controller.signal, AbortSignal.timeout(30_000)]));
    signal.throwIfAborted();
    const revision = call.guard.revision;
    if (!call.guard.permits(revision)) throw new Error("Matrix publication is suspended");
    await call.media.publish(audio, AbortSignal.any([signal, call.controller.signal]));
    signal.throwIfAborted();
    if (!call.guard.permits(revision)) throw new Error("Matrix publication changed during playback");
  }

  async verify(reference: ParticipantReference, signal: AbortSignal) {
    const call = this.#call;
    if (!call?.connected || call.controller.signal.aborted) throw new Error("Matrix media is unavailable");
    return new MatrixRtcParticipantVerifier({ roomId: call.roomId, client: this.#client, session: call.session,
      media: call.media.room, keys: call.keys, now: Date.now }).verify(reference, signal);
  }

  async disconnect(): Promise<void> {
    const call = this.#call;
    if (!call) return;
    return this.#disconnect(call);
  }

  #disconnect(call: ActiveCall): Promise<void> {
    if (call.closing) return call.closing;
    call.controller.abort(); call.keys.close(); call.guard.close();
    clearInterval(call.timer);
    this.#client.off(ClientEvent.ReceivedToDeviceMessage, call.receive);
    call.session.off(MatrixRTCSessionEvent.MembershipsChanged, call.changed);
    call.session.off(MatrixRTCSessionEvent.MembershipManagerError, call.stateFailed);
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
