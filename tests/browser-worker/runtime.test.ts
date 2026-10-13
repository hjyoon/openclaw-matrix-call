import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, EventType, SyncState, type MatrixClient } from "matrix-js-sdk";
import { DeviceVerificationStatus } from "matrix-js-sdk/lib/crypto-api/index.js";
import { Device } from "matrix-js-sdk/lib/models/device.js";
import { MatrixRTCSessionEvent, type CallMembership } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { ConnectionState, RoomEvent, Track } from "livekit-client";
import { BrowserMatrixRuntime, waitUntil } from "../../packages/browser-worker/src/runtime.js";
import { MatrixPublicationGuard } from "../../packages/browser-worker/src/guard.js";
import { VerifiedMatrixRtcKeys } from "../../packages/matrixrtc/src/verified-keys.js";
import { parseBrowserConfig } from "../../packages/browser-worker/src/config.js";
import type { BrowserMedia } from "../../packages/browser-worker/src/media.js";
import type { FocusAuthorizationSource } from "../../packages/matrixrtc/src/focus.js";
import type { BrowserSetup } from "../../packages/browser-worker/src/types.js";
import { configuration, credentials } from "../fixtures/browser.js";

const { sdkFactory, mediaFactory, focusFactory } = vi.hoisted(() => ({ sdkFactory: vi.fn(), mediaFactory: vi.fn(), focusFactory: vi.fn() }));
vi.mock("../../packages/browser-worker/src/client.js", async (original) => ({ ...await original<object>(), createMatrixClient: sdkFactory }));
vi.mock("../../packages/browser-worker/src/media.js", () => ({ createBrowserMedia: mediaFactory }));
vi.mock("../../packages/matrixrtc/src/focus.js", async (original) => ({ ...await original<object>(), OpenIdFocusAuthorizer: class { constructor() { return focusFactory(); } } }));
afterEach(() => { vi.useRealTimers(); });

function member(userId: string, deviceId: string): CallMembership {
  const created = Date.now() - 1000;
  return { userId, deviceId, memberId: `${userId}:${deviceId}`, rtcBackendIdentity: `${userId}:${deviceId}`, createdTs: () => created, getAbsoluteExpiry: () => undefined, getTransport: () => ({ type: "livekit", livekit_service_url: configuration.focusUrls[0], livekit_alias: "!room" }) } as unknown as CallMembership;
}

function fixture() {
  const config = parseBrowserConfig(configuration, credentials);
  const setup: BrowserSetup = { credentials: config.credentials, policy: config.policy, expectedKeys: undefined };
  const pin = setup.policy.devices[0]!;
  const local = member(credentials.userId, credentials.deviceId);
  const remote = member(pin.userId, pin.deviceId);
  const session = Object.assign(new EventEmitter(), { slotId: "m.call#ROOM", memberships: [local, remote], isJoined: vi.fn(() => true), joinRTCSession: vi.fn(), leaveRoomSession: vi.fn(async () => true), getOldestMembership: vi.fn(() => local) });
  const cryptoApi = { getOwnDeviceKeys: vi.fn(async () => ({ ed25519: "C".repeat(43), curve25519: "D".repeat(43) })), getUserDeviceInfo: vi.fn(async () => new Map([[pin.userId, new Map([[pin.deviceId, new Device({ userId: pin.userId, deviceId: pin.deviceId, algorithms: [], keys: new Map([[`ed25519:${pin.deviceId}`, pin.ed25519], [`curve25519:${pin.deviceId}`, pin.curve25519]]) })]])]])), setDeviceVerified: vi.fn(async () => {}), getDeviceVerificationStatus: vi.fn(async () => new DeviceVerificationStatus({ localVerified: true })) };
  const room = { getMyMembership: () => "join", hasEncryptionStateEvent: () => true };
  const client = Object.assign(new EventEmitter(), { downloadKeysForUsers: vi.fn(async () => ({ failures: {}, device_keys: {} })), initRustCrypto: vi.fn(async () => {}), getCrypto: () => cryptoApi, startClient: vi.fn(async () => {}), stopClient: vi.fn(), getSyncState: vi.fn(() => SyncState.Prepared), getRoom: vi.fn(() => room), getUserId: () => credentials.userId, getDeviceId: () => credentials.deviceId, encryptAndSendToDevice: vi.fn(async () => {}), matrixRTC: { getRoomSession: () => session } });
  const publication = { kind: Track.Kind.Audio, isEncrypted: true, isSubscribed: true, track: { mediaStreamTrack: { readyState: "live" } } };
  const mediaRoom = Object.assign(new EventEmitter(), { state: ConnectionState.Connected, isE2EEEnabled: true, remoteParticipants: new Map([[remote.rtcBackendIdentity, { identity: remote.rtcBackendIdentity, trackPublications: new Map([["audio", publication]]) }]]) });
  const media = { room: mediaRoom, connect: vi.fn(async () => {}), suspend: vi.fn(), resume: vi.fn(), publish: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const grant = { url: "wss://sfu.example.org", jwt: "opaque-jwt", identity: local.rtcBackendIdentity, expiresAtMs: Date.now() + 60_000 };
  const authorizer = { authorize: vi.fn(async (_source: FocusAuthorizationSource, _signal: AbortSignal) => grant) };
  sdkFactory.mockReturnValue(client); mediaFactory.mockReturnValue(media); focusFactory.mockReturnValue(authorizer);
  const runtime = new BrowserMatrixRuntime(setup, client as unknown as MatrixClient, () => media as unknown as BrowserMedia, authorizer);
  return { setup, runtime, client, cryptoApi, session, local, remote, media, authorizer, grant };
}

async function ready(f = fixture()) { await f.runtime.initialize(); await f.runtime.prepare(); return f; }
const pcm = { samples: new Int16Array([1]), sampleRate: 16_000, channels: 1 as const };
const signal = () => new AbortController().signal;

describe("production Matrix browser runtime", () => {
  it("initializes public SDK defaults and preserves a sanitized lifecycle status", async () => {
    const f = fixture();
    const runtime = new BrowserMatrixRuntime(f.setup);
    expect(runtime.status()).toEqual({ initialized: false, prepared: false, roomId: null, connected: false });
    await runtime.initialize(); await runtime.prepare(); await runtime.connect("!room");
    expect(runtime.status()).toEqual({ initialized: true, prepared: true, roomId: "!room", connected: true });
    expect(f.session.joinRTCSession).toHaveBeenCalledWith({ userId: credentials.userId, deviceId: credentials.deviceId, memberId: f.local.memberId }, [{ type: "livekit", livekit_service_url: configuration.focusUrls[0], livekit_alias: "!room" }], undefined, expect.objectContaining({ manageMediaKeys: false, callIntent: "audio" }));
    expect(f.media.connect).toHaveBeenCalledWith(f.grant.url, f.grant.jwt, f.grant.identity);
    expect(JSON.stringify(runtime.status())).not.toContain(credentials.accessToken);
    await runtime.close(); await runtime.close();
    expect(runtime.status().prepared).toBe(false);
  });

  it("rejects duplicate initialization and closes a failed crypto client", async () => {
    const f = await ready();
    await expect(f.runtime.initialize()).rejects.toThrow("cannot initialize again");
    await f.runtime.close();
    const g = fixture();
    g.client.initRustCrypto.mockRejectedValue(new Error("crypto failed"));
    await expect(g.runtime.initialize()).rejects.toThrow("crypto failed");
    expect(g.client.stopClient).toHaveBeenCalledOnce();
    await expect(g.runtime.prepare()).rejects.toThrow("unavailable");
    await expect(g.runtime.initialize()).rejects.toThrow("cannot initialize again");
  });

  it("requires initialized crypto, configured rooms, encrypted joined rooms, and the supported slot", async () => {
    const f = fixture();
    await expect(f.runtime.prepare()).rejects.toThrow("unavailable");
    await expect(f.runtime.connect("!room")).rejects.toThrow("unavailable");
    await ready(f);
    await expect(f.runtime.connect("!unknown")).rejects.toThrow("not configured");
    f.client.getRoom.mockReturnValue(undefined as never);
    await expect(f.runtime.connect("!room")).rejects.toThrow("Joined encrypted");
    f.client.getRoom.mockReturnValue({ getMyMembership: () => "join", hasEncryptionStateEvent: () => true });
    f.session.slotId = "m.call#OTHER";
    await expect(f.runtime.connect("!room")).rejects.toThrow("slot is not supported");
    await f.runtime.close();
    await expect(f.runtime.connect("!room")).rejects.toThrow("unavailable");
  });

  it("waits for Matrix sync and local membership with bounded cancellable polling", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.client.getSyncState.mockReturnValue(SyncState.Stopped);
    await f.runtime.initialize();
    const pending = f.runtime.prepare();
    f.client.getSyncState.mockReturnValue(SyncState.Syncing);
    await vi.advanceTimersByTimeAsync(100); await pending;
    f.session.memberships = [f.remote];
    f.session.isJoined.mockReturnValue(false);
    const connect = f.runtime.connect("!room");
    f.session.emit(MatrixRTCSessionEvent.MembershipsChanged);
    f.session.isJoined.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(100);
    f.session.memberships = [f.local, f.remote];
    await vi.advanceTimersByTimeAsync(100); await connect;
    await f.runtime.close();
    const controller = new AbortController();
    const wait = waitUntil(() => false, controller.signal).catch((error: Error) => error);
    controller.abort(new Error("cancelled"));
    await vi.advanceTimersByTimeAsync(100);
    expect(await wait).toMatchObject({ message: "cancelled" });
    await expect(waitUntil(() => true, controller.signal)).rejects.toThrow("cancelled");
  });

  it("refences focus metadata and unique local membership through SDK callbacks", async () => {
    const f = await ready();
    f.authorizer.authorize.mockImplementation(async (source) => {
      expect(source.focus()).toEqual({ type: "livekit", livekit_service_url: configuration.focusUrls[0], livekit_alias: "!room" });
      expect(source.membership()?.participantId).toBe(f.local.rtcBackendIdentity);
      f.session.getOldestMembership.mockReturnValue(undefined as never);
      f.session.memberships = [];
      expect(source.focus()).toBeUndefined(); expect(source.membership()).toBeUndefined();
      f.session.memberships = [f.local, f.remote];
      return f.grant;
    });
    await f.runtime.connect("!room");
    await f.runtime.close();
  });

  it("reserves capacity while opening and releases resources after focus failure", async () => {
    const f = await ready();
    let reject!: (error: Error) => void;
    f.authorizer.authorize.mockImplementationOnce(() => new Promise((_resolve, failure) => { reject = failure; }));
    const pending = f.runtime.connect("!room");
    await vi.waitFor(() => expect(f.authorizer.authorize).toHaveBeenCalledOnce());
    await expect(f.runtime.connect("!room")).rejects.toThrow("busy");
    reject(new Error("focus unavailable"));
    await expect(pending).rejects.toThrow("focus unavailable");
    expect(f.media.close).toHaveBeenCalledOnce();
    expect(f.session.leaveRoomSession).toHaveBeenCalledWith(5000);
    expect(f.runtime.status().roomId).toBeNull();
    await f.runtime.close();
  });

  it("cannot reclaim a cancelled connection after its focus operation completes", async () => {
    const f = await ready();
    let resolve!: (value: typeof f.grant) => void;
    f.authorizer.authorize.mockImplementationOnce(() => new Promise((success) => { resolve = success; }));
    const pending = f.runtime.connect("!room");
    await vi.waitFor(() => expect(f.authorizer.authorize).toHaveBeenCalledOnce());
    await f.runtime.disconnect();
    await f.runtime.connect("!room");
    resolve(f.grant);
    await expect(pending).rejects.toThrow();
    expect(f.runtime.status().connected).toBe(true);
    await f.runtime.close();
  });

  it("closes a connection that is cancelled during media setup", async () => {
    const f = await ready();
    f.media.connect.mockImplementation(async () => { await f.runtime.disconnect(); });
    await expect(f.runtime.connect("!room")).rejects.toThrow();
    expect(f.runtime.status().connected).toBe(false);
    await f.runtime.close();
  });

  it("serializes fresh key authorization before PCM output", async () => {
    const f = await ready();
    await expect(f.runtime.publish(pcm, signal())).rejects.toThrow("unavailable");
    await f.runtime.connect("!room");
    await f.runtime.publish(pcm, signal());
    expect(f.media.publish).toHaveBeenCalledWith(pcm, expect.any(AbortSignal));
    expect(f.client.encryptAndSendToDevice).toHaveBeenCalledTimes(3);
    await expect(f.runtime.publish(pcm, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
    await f.runtime.close();
  });

  it("suspends output immediately on changes and rotates on the periodic trust check", async () => {
    vi.useFakeTimers();
    const f = await ready(); await f.runtime.connect("!room");
    const count = f.media.suspend.mock.calls.length;
    f.session.emit(MatrixRTCSessionEvent.MembershipsChanged);
    expect(f.media.suspend.mock.calls.length).toBeGreaterThan(count);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.client.encryptAndSendToDevice.mock.calls.length).toBeGreaterThan(2);
    await f.runtime.close();
  });

  it("terminates a call when a newly joined listener is unauthorized", async () => {
    const f = await ready(); await f.runtime.connect("!room");
    f.session.memberships.push(member("@unknown:example.org", "UNKNOWN"));
    f.session.emit(MatrixRTCSessionEvent.MembershipsChanged);
    await vi.waitFor(() => expect(f.runtime.status().roomId).toBeNull());
    expect(f.media.close).toHaveBeenCalledOnce();
    await f.runtime.close();
  });

  it("rejects revoked trust, publication suspension, and changes during playback", async () => {
    const f = await ready(); await f.runtime.connect("!room");
    const permits = vi.spyOn(MatrixPublicationGuard.prototype, "permits").mockReturnValueOnce(false);
    await expect(f.runtime.publish(pcm, signal())).rejects.toThrow("suspended");
    permits.mockRestore();
    f.media.publish.mockImplementation(async () => { f.session.emit(MatrixRTCSessionEvent.MembershipsChanged); });
    await expect(f.runtime.publish(pcm, signal())).rejects.toThrow("changed during playback");
    f.cryptoApi.getDeviceVerificationStatus.mockResolvedValue(new DeviceVerificationStatus({ localVerified: false }));
    await expect(f.runtime.publish(pcm, signal())).rejects.toThrow("not verified");
    await f.runtime.close();
  });

  it("authenticates actual SDK key delivery before returning participant proofs", async () => {
    const f = await ready();
    const reference = { roomId: "!room", rtcSessionId: "m.call#ROOM", participantId: f.remote.rtcBackendIdentity };
    await expect(f.runtime.verify(reference, signal())).rejects.toThrow("unavailable");
    await f.runtime.connect("!room");
    const receive = vi.spyOn(VerifiedMatrixRtcKeys.prototype, "receive");
    f.client.emit(ClientEvent.ReceivedToDeviceMessage, { message: { type: "ignored" } });
    expect(receive).not.toHaveBeenCalled();
    f.client.emit(ClientEvent.ReceivedToDeviceMessage, {
      encryptionInfo: { senderVerified: true, sender: f.remote.userId, senderDevice: f.remote.deviceId },
      message: { type: EventType.CallEncryptionKeysPrefix, sender: f.remote.userId, content: { room_id: "!room", member: { id: f.remote.memberId, claimed_device_id: f.remote.deviceId }, session: { application: "m.call", call_id: "", scope: "m.room" }, keys: { index: 0, key: btoa("0123456789abcdef") }, sent_ts: Date.now() } },
    });
    await receive.mock.results[0]!.value;
    const proof = await f.runtime.verify(reference, signal());
    expect(proof).toMatchObject({ userId: f.remote.userId, deviceId: f.remote.deviceId, deviceVerified: true, mediaEncrypted: true });
    await f.runtime.close();
  });

  it.each(["membership", "disconnected", "encryption", "key-import"])("cleans up on SDK errors: %s", async (event) => {
    const f = await ready(); await f.runtime.connect("!room");
    const saved = f.session.listeners(MatrixRTCSessionEvent.MembershipManagerError)[0]!;
    if (event === "membership") f.session.emit(MatrixRTCSessionEvent.MembershipManagerError, new Error("failed"));
    if (event === "disconnected") f.media.room.emit(RoomEvent.Disconnected);
    if (event === "encryption") f.media.room.emit(RoomEvent.EncryptionError, new Error("failed"));
    if (event === "key-import") {
      vi.spyOn(VerifiedMatrixRtcKeys.prototype, "receive").mockRejectedValueOnce(new Error("failed"));
      f.client.emit(ClientEvent.ReceivedToDeviceMessage, { message: { type: EventType.CallEncryptionKeysPrefix } });
    }
    await vi.waitFor(() => expect(f.runtime.status().roomId).toBeNull());
    saved();
    await f.runtime.close();
    expect(f.media.close).toHaveBeenCalledOnce();
  });

  it("retains unrelated SDK listeners and makes cleanup failure permanent", async () => {
    const f = await ready();
    const listener = vi.fn(); f.session.on(MatrixRTCSessionEvent.MembershipsChanged, listener);
    await f.runtime.connect("!room");
    f.media.close.mockRejectedValueOnce(new Error("media cleanup failed"));
    f.session.emit(MatrixRTCSessionEvent.MembershipManagerError);
    await vi.waitFor(() => expect(f.runtime.status().roomId).toBeNull());
    expect(f.session.listeners(MatrixRTCSessionEvent.MembershipsChanged)).toEqual([listener]);
    expect(f.session.leaveRoomSession).toHaveBeenCalledOnce();
    await expect(f.runtime.connect("!room")).rejects.toThrow("unavailable");
    await f.runtime.close();
  });

  it("fences a closing call and coalesces concurrent cleanup requests", async () => {
    const f = await ready(); await f.runtime.connect("!room");
    let complete!: () => void;
    f.media.close.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const one = f.runtime.disconnect(); const two = f.runtime.disconnect();
    expect(f.runtime.status().connected).toBe(false);
    await expect(f.runtime.publish(pcm, signal())).rejects.toThrow("unavailable");
    await expect(f.runtime.verify({ roomId: "!room", rtcSessionId: "m.call#ROOM", participantId: "remote" }, signal())).rejects.toThrow("unavailable");
    complete(); await Promise.all([one, two]);
    expect(f.media.close).toHaveBeenCalledOnce();
    await f.runtime.close();
  });
});
