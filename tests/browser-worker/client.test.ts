import { describe, expect, it, vi } from "vitest";
import { SyncState, createClient, type MatrixClient, type Room } from "matrix-js-sdk";
import { Device } from "matrix-js-sdk/lib/models/device.js";
import { createMatrixClient, enrollPinnedDevices, initializeMatrixClient, joinedEncryptedRoom } from "../../packages/browser-worker/src/client.js";
import type { BrowserSetup, DeviceKeys } from "../../packages/browser-worker/src/types.js";
import { parseBrowserConfig } from "../../packages/browser-worker/src/config.js";
import { credentials, configuration } from "../fixtures/browser.js";

vi.mock("matrix-js-sdk", async (original) => ({ ...await original<object>(), createClient: vi.fn() }));

const keys: DeviceKeys = { ed25519: "C".repeat(43), curve25519: "D".repeat(43) };

function fixture(expectedKeys: DeviceKeys | undefined = undefined) {
  const config = parseBrowserConfig(configuration, credentials);
  const setup: BrowserSetup = { credentials: config.credentials, policy: config.policy, expectedKeys };
  const pin = setup.policy.devices[0]!;
  const device = new Device({ userId: pin.userId, deviceId: pin.deviceId, algorithms: [], keys: new Map([[`ed25519:${pin.deviceId}`, pin.ed25519], [`curve25519:${pin.deviceId}`, pin.curve25519]]) });
  const cryptoApi = { getOwnDeviceKeys: vi.fn(async () => keys), getUserDeviceInfo: vi.fn(async () => new Map([[pin.userId, new Map([[pin.deviceId, device]])]])), setDeviceVerified: vi.fn(async () => {}), prepareToEncrypt: vi.fn() };
  const client = { whoami: vi.fn(async () => ({ user_id: credentials.userId, device_id: credentials.deviceId })), downloadKeysForUsers: vi.fn(async () => ({ failures: {}, device_keys: {} })), initRustCrypto: vi.fn(async () => {}), getCrypto: vi.fn(() => cryptoApi), startClient: vi.fn(async () => {}), getSyncState: vi.fn(() => SyncState.Prepared), getRoom: vi.fn(() => ({ getMyMembership: () => "join", hasEncryptionStateEvent: () => true }) as Room) };
  return { client, sdk: client as unknown as MatrixClient, cryptoApi, setup, pin, device };
}

describe("Matrix browser device initialization", () => {
  it.each([{ user_id: "@different:example.org", device_id: credentials.deviceId }, { user_id: credentials.userId, device_id: "OTHER" }, { user_id: credentials.userId }])("checks the authenticated token identity before creating crypto state", async (identity) => {
    const f = fixture();
    f.client.whoami.mockResolvedValue(identity as never);
    await expect(initializeMatrixClient(f.sdk, f.setup)).rejects.toThrow("Matrix token identity does not match configuration");
    expect(f.client.initRustCrypto).not.toHaveBeenCalled();
    expect(f.client.downloadKeysForUsers).not.toHaveBeenCalled();
  });

  it("creates a public SDK client with a credential-redacting logger", () => {
    createMatrixClient(credentials);
    const options = vi.mocked(createClient).mock.calls[0]![0];
    expect(options).toMatchObject(credentials);
    const logger = options.logger!;
    for (const method of [logger.trace, logger.debug, logger.info, logger.warn, logger.error]) expect(method("private token")).toBeUndefined();
    expect(logger.getChild("child")).toBe(logger);
  });

  it("enrolls a newly issued device and initializes persistent crypto before sync", async () => {
    const f = fixture();
    expect(await initializeMatrixClient(f.sdk, f.setup)).toEqual(keys);
    expect(f.client.downloadKeysForUsers).toHaveBeenCalledWith([credentials.userId]);
    expect(f.client.initRustCrypto).toHaveBeenCalledWith({ useIndexedDB: true, cryptoDatabasePrefix: "matrix-call-worker" });
    expect(f.client.startClient).toHaveBeenCalledWith({ initialSyncLimit: 1 });
  });

  it("restores matching private keys and allows a missing published device entry", async () => {
    const f = fixture(keys);
    expect(await initializeMatrixClient(f.sdk, f.setup)).toEqual(keys);
    f.client.downloadKeysForUsers.mockResolvedValue({ failures: {}, device_keys: { [credentials.userId]: { [credentials.deviceId]: { keys: { [`ed25519:${credentials.deviceId}`]: keys.ed25519, [`curve25519:${credentials.deviceId}`]: keys.curve25519 } } } } } as never);
    expect(await initializeMatrixClient(f.sdk, f.setup)).toEqual(keys);
  });

  it.each([undefined, { ...keys, ed25519: "wrong" }, { ...keys, curve25519: "wrong" }])("rejects reusing an existing device without the exact manifest", async (expectedKeys) => {
    const f = fixture(expectedKeys);
    f.client.downloadKeysForUsers.mockResolvedValue({ failures: {}, device_keys: { [credentials.userId]: { [credentials.deviceId]: { keys: { [`ed25519:${credentials.deviceId}`]: keys.ed25519, [`curve25519:${credentials.deviceId}`]: keys.curve25519 } } } } } as never);
    await expect(initializeMatrixClient(f.sdk, f.setup)).rejects.toThrow("Matrix device already exists without matching local keys");
    expect(f.client.initRustCrypto).not.toHaveBeenCalled();
  });

  it("fails closed on key lookup failure or unavailable crypto", async () => {
    const f = fixture();
    f.client.downloadKeysForUsers.mockResolvedValueOnce({ failures: { "example.org": {} }, device_keys: {} } as never);
    await expect(initializeMatrixClient(f.sdk, f.setup)).rejects.toThrow("Matrix device lookup failed");
    f.client.getCrypto.mockReturnValue(undefined as never);
    await expect(initializeMatrixClient(f.sdk, f.setup)).rejects.toThrow("Matrix crypto is unavailable");
    await expect(enrollPinnedDevices(f.sdk, f.setup)).rejects.toThrow("Matrix crypto is unavailable");
  });

  it.each([{ ...keys, ed25519: "wrong" }, { ...keys, curve25519: "wrong" }])("rejects a changed private profile before starting sync", async (expectedKeys) => {
    const f = fixture(expectedKeys);
    await expect(initializeMatrixClient(f.sdk, f.setup)).rejects.toThrow("Matrix profile device keys changed");
    expect(f.client.startClient).not.toHaveBeenCalled();
  });

  it("marks only explicitly compared owner device keys as verified", async () => {
    const f = fixture();
    await enrollPinnedDevices(f.sdk, f.setup);
    expect(f.cryptoApi.getUserDeviceInfo).toHaveBeenCalledWith([f.pin.userId], false);
    expect(f.cryptoApi.setDeviceVerified).toHaveBeenCalledWith(f.pin.userId, f.pin.deviceId, true);
  });

  it.each(["wrong-user", "wrong-device", "signing-key", "identity-key"])("rejects changed enrolled device evidence: %s", async (change) => {
    const f = fixture();
    const device = { userId: change === "wrong-user" ? "@wrong:example.org" : f.pin.userId, deviceId: change === "wrong-device" ? "OTHER" : f.pin.deviceId, getFingerprint: () => change === "signing-key" ? "wrong" : f.pin.ed25519, getIdentityKey: () => change === "identity-key" ? "wrong" : f.pin.curve25519 };
    f.cryptoApi.getUserDeviceInfo.mockResolvedValue(new Map([[f.pin.userId, new Map([[f.pin.deviceId, device as Device]])]]));
    await expect(enrollPinnedDevices(f.sdk, f.setup)).rejects.toThrow("Matrix device fingerprint does not match enrollment");
    expect(f.cryptoApi.setDeviceVerified).not.toHaveBeenCalled();
  });

  it.each(["missing-user", "missing-device"])("waits for pinned devices to enter the SDK crypto store: %s", async (missing) => {
    const f = fixture();
    f.cryptoApi.getUserDeviceInfo.mockResolvedValueOnce(new Map(missing === "missing-user" ? [] : [[f.pin.userId, new Map()]]));
    await enrollPinnedDevices(f.sdk, f.setup);
    expect(f.cryptoApi.getUserDeviceInfo).toHaveBeenCalledTimes(2);
    expect(f.cryptoApi.prepareToEncrypt).toHaveBeenCalledTimes(2);
    expect(f.cryptoApi.setDeviceVerified).toHaveBeenCalledExactlyOnceWith(f.pin.userId, f.pin.deviceId, true);
  });

  it("bounds unavailable device storage without granting trust", async () => {
    const f = fixture(); const controller = new AbortController();
    f.cryptoApi.getUserDeviceInfo.mockImplementation(async () => { setTimeout(() => controller.abort(new Error("enrollment expired")), 10); return new Map(); });
    await expect(enrollPinnedDevices(f.sdk, f.setup, controller.signal)).rejects.toThrow("enrollment expired");
    expect(f.cryptoApi.setDeviceVerified).not.toHaveBeenCalled();
  });

  it("rejects cancellation after the SDK lookup and a lost encrypted room", async () => {
    const f = fixture(); const controller = new AbortController();
    f.cryptoApi.getUserDeviceInfo.mockImplementation(async () => { controller.abort(new Error("enrollment canceled")); return new Map(); });
    await expect(enrollPinnedDevices(f.sdk, f.setup, controller.signal)).rejects.toThrow("enrollment canceled");
    f.client.getRoom.mockReturnValue(undefined as never);
    await expect(enrollPinnedDevices(f.sdk, f.setup)).rejects.toThrow("Joined encrypted Matrix room is unavailable");
    expect(f.cryptoApi.setDeviceVerified).not.toHaveBeenCalled();
  });

  it("requires prepared sync and joined encrypted Matrix rooms", () => {
    const f = fixture();
    expect(joinedEncryptedRoom(f.sdk, "!room")).toBeDefined();
    f.client.getSyncState.mockReturnValue(SyncState.Syncing);
    expect(joinedEncryptedRoom(f.sdk, "!room")).toBeDefined();
    f.client.getSyncState.mockReturnValue(SyncState.Stopped);
    expect(joinedEncryptedRoom(f.sdk, "!room")).toBeUndefined();
    f.client.getSyncState.mockReturnValue(SyncState.Prepared);
    for (const room of [undefined, { getMyMembership: () => "invite" }, { getMyMembership: () => "join", hasEncryptionStateEvent: () => false }]) {
      f.client.getRoom.mockReturnValue(room as Room);
      expect(joinedEncryptedRoom(f.sdk, "!room")).toBeUndefined();
    }
  });
});
