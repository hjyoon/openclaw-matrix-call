import { createClient, ClientEvent, EventType, SyncState } from "matrix-js-sdk";
import { VerifiedMatrixRtcKeys } from "../../packages/matrixrtc/src/verified-keys.ts";
import { MatrixRtcParticipantVerifier, membershipSnapshot } from "../../packages/matrixrtc/src/participants.ts";
import { publishMatrixRtcKey } from "../../packages/matrixrtc/src/outbound-key.ts";
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
    if (device?.getFingerprint() !== expected.ed25519 || device.getIdentityKey() !== expected.curve25519) throw new Error("Test device fingerprint mismatch");
    await client.getCrypto().setDeviceVerified(userId, deviceId, true);
  },
  async trusted(userId, deviceId) {
    return (await client.getCrypto().getDeviceVerificationStatus(userId, deviceId))?.isVerified() === true;
  },
  async join(id, owners) {
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
    session.joinRTCSession({ userId, deviceId, memberId: `${userId}:${deviceId}` }, [{ type: "livekit", livekit_service_url: "http://127.0.0.1/test-focus", livekit_alias: roomId }], undefined, {
      manageMediaKeys: false, callIntent: "audio", membershipEventExpiryMs: 60_000,
      delayedLeaveEventDelayMs: 5_000, delayedLeaveEventRestartMs: 2_000,
    });
  },
  async rotate(index) {
    localKey = await publishMatrixRtcKey(keySource, index, new AbortController().signal);
    return localKey;
  },
  async verify(participantId) {
    const verifier = new MatrixRtcParticipantVerifier({ roomId, client, session, media, keys: gate, now: Date.now });
    return verifier.verify({ roomId, rtcSessionId: session.slotId, participantId }, new AbortController().signal);
  },
  status(remoteIdentity) {
    return { members: session?.memberships.length ?? 0, localKey, remoteKey: gate?.hasCurrentKey(remoteIdentity) ?? false, accepted, rejected, authenticated, verified, failed };
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
