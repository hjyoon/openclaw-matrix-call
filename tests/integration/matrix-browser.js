import { createClient, ClientEvent, EventType, SyncState } from "matrix-js-sdk";
import { VerifiedMatrixRtcKeys } from "../../packages/matrixrtc/src/verified-keys.ts";
import { MatrixRtcParticipantVerifier, membershipSnapshot } from "../../packages/matrixrtc/src/participants.ts";
import { publishMatrixRtcKey } from "../../packages/matrixrtc/src/outbound-key.ts";
import { OpenIdFocusAuthorizer } from "../../packages/matrixrtc/src/focus.ts";
import { provider, room as media } from "./livekit-browser.js";

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild() { return quiet; } };
let client;
let session;
let gate;
let accepted = 0;
let rejected = 0;
let authenticated = 0;
let verified = 0;
let localKey = false;
let failed = false;
let keySource;
let roomId;
let localIndex = -1;

window.matrixTest = {
  async init(credentials) {
    client = createClient({ ...credentials, logger: quiet });
    await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: "matrix-call-integration" });
    await client.startClient({ initialSyncLimit: 1 });
  },
  prepared(roomId) {
    return client.getSyncState() === SyncState.Prepared || (client.getSyncState() === SyncState.Syncing && Boolean(client.getRoom(roomId)));
  },
  keys() {
    return client.getCrypto().getOwnDeviceKeys();
  },
  async trust(userId, deviceId, expected) {
    const devices = await client.getCrypto().getUserDeviceInfo([userId], true);
    const device = devices.get(userId)?.get(deviceId);
    if (!device) return false;
    if (device.getFingerprint() !== expected.ed25519 || device.getIdentityKey() !== expected.curve25519) throw new Error("Test device fingerprint mismatch");
    await client.getCrypto().setDeviceVerified(userId, deviceId, true);
    return true;
  },
  async trusted(userId, deviceId) {
    return (await client.getCrypto().getDeviceVerificationStatus(userId, deviceId))?.isVerified() === true;
  },
  async sendCommand(id, body, botId) {
    if (!client.getRoom(id)?.hasEncryptionStateEvent()) throw new Error("Encrypted command room is unavailable");
    return client.sendMessage(id, { msgtype: "m.text", body, "m.mentions": { user_ids: [botId] } });
  },
  async commandReplies(id, botId) {
    const replies = [];
    for (const event of client.getRoom(id)?.getLiveTimeline().getEvents() ?? []) {
      if (event.getSender() !== botId) continue;
      await client.decryptEventIfNeeded(event);
      if (event.getType() === "m.room.message" && event.getContent().body?.startsWith("Matrix Call")) {
        replies.push({ id: event.getId(), type: event.getWireType(), algorithm: event.getWireContent().algorithm, text: event.getContent().body });
      }
    }
    return replies;
  },
  async join(id, owners, focusUrl) {
    roomId = id;
    session = client.matrixRTC.getRoomSession(client.getRoom(roomId));
    gate = new VerifiedMatrixRtcKeys({ roomId, owners, memberships: () => session.memberships.map(membershipSnapshot), now: Date.now }, provider);
    client.on(ClientEvent.ReceivedToDeviceMessage, (message) => {
      if (message.message.type !== EventType.CallEncryptionKeysPrefix) return;
      if (message.encryptionInfo) authenticated++;
      if (message.encryptionInfo?.senderVerified) verified++;
      void gate.receive(message).then((result) => { if (result) accepted++; else rejected++; }).catch(() => { failed = true; });
    });
    const userId = client.getUserId();
    const deviceId = client.getDeviceId();
    keySource = { roomId, owners, client, memberships: () => session.memberships.map(membershipSnapshot), isJoined: () => session.isJoined(), now: Date.now, sink: provider };
    session.joinRTCSession({ userId, deviceId, memberId: `${userId}:${deviceId}` }, [{ type: "livekit", livekit_service_url: focusUrl, livekit_alias: roomId }], undefined, {
      manageMediaKeys: false, callIntent: "audio", membershipEventExpiryMs: 60_000,
      delayedLeaveEventDelayMs: 5_000, delayedLeaveEventRestartMs: 2_000,
    });
  },
  async connectAuthorized(focusUrl, sfuUrl) {
    let httpStatus;
    const authorizer = new OpenIdFocusAuthorizer({ focusUrls: [focusUrl], sfuUrls: [sfuUrl], allowInsecureLoopback: true,
      fetch: async (input, options) => { const response = await fetch(input, options); httpStatus = response.status; return response; },
    });
    let grant;
    try { grant = await authorizer.authorize({ roomId, slotId: session.slotId, client,
      focus: () => { const oldest = session.getOldestMembership(); return oldest?.getTransport(oldest); },
      membership: () => { const matches = session.memberships.filter((member) => member.userId === client.getUserId() && member.deviceId === client.getDeviceId()); return matches.length === 1 ? membershipSnapshot(matches[0]) : undefined; },
    }, new AbortController().signal); }
    catch (error) { throw new Error(`Focus authorization failed: ${error.code}, HTTP ${httpStatus}`); }
    await window.mediaTest.connect(grant.url, grant.jwt, grant.identity);
    return { connected: true, expiresAtMs: grant.expiresAtMs };
  },
  async rotate(index) {
    const signal = AbortSignal.timeout(30_000);
    for (;;) {
      signal.throwIfAborted();
      const members = keySource.memberships();
      const own = members.filter((member) => member.userId === client.getUserId() && member.deviceId === client.getDeviceId());
      if (!session.isJoined() || own.length !== 1 || new Set(members.map((member) => member.participantId)).size !== members.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      localIndex = Math.max(index, localIndex + 1);
      localKey = await publishMatrixRtcKey(keySource, localIndex, signal);
      if (localKey) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  },
  async verify(participantId) {
    const verifier = new MatrixRtcParticipantVerifier({ roomId, client, session, media, keys: gate, now: Date.now });
    return verifier.verify({ roomId, rtcSessionId: session.slotId, participantId }, new AbortController().signal);
  },
  status(remoteIdentity) {
    return { members: session?.memberships.length ?? 0, joined: session?.isJoined() === true, localMember: session?.memberships.filter((member) => member.userId === client.getUserId() && member.deviceId === client.getDeviceId()).length === 1, localKey, remoteKey: gate?.hasCurrentKey(remoteIdentity) ?? false, accepted, rejected, authenticated, verified, failed };
  },
  async sendKey(targetUserId, targetDeviceId, roomId, claim, plaintext) {
    const content = {
      room_id: roomId, member: { id: `${client.getUserId()}:${client.getDeviceId()}`, claimed_device_id: claim },
      session: { application: "m.call", call_id: "", scope: "m.room" },
      keys: { index: 255, key: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/=+$/, "") }, sent_ts: Date.now(),
    };
    if (plaintext) await client.sendToDevice(EventType.CallEncryptionKeysPrefix, new Map([[targetUserId, new Map([[targetDeviceId, content]])]]));
    else await client.encryptAndSendToDevice(EventType.CallEncryptionKeysPrefix, [{ userId: targetUserId, deviceId: targetDeviceId }], content);
  },
  async leave() {
    gate?.close();
    await session?.leaveRoomSession(5_000);
    client.stopClient();
  },
};
