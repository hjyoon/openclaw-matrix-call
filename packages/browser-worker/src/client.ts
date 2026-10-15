import { createClient, SyncState, type MatrixClient } from "matrix-js-sdk";
import type { BrowserSetup, MatrixCredentials } from "./types.js";
import { cancelable } from "../../voice/src/cancellation.js";

export function createMatrixClient(credentials: MatrixCredentials): MatrixClient {
  const silent = (): void => {};
  const logger = { trace: silent, debug: silent, info: silent, warn: silent, error: silent, getChild: () => logger };
  return createClient({ ...credentials, logger });
}

export async function initializeMatrixClient(client: MatrixClient, setup: BrowserSetup) {
  const { userId, deviceId } = setup.credentials;
  const identity = await client.whoami();
  if (identity.user_id !== userId || identity.device_id !== deviceId) throw new Error("Matrix token identity does not match configuration");
  const published = await client.downloadKeysForUsers([userId]);
  if (Object.keys(published.failures).length > 0) throw new Error("Matrix device lookup failed");
  const device = published.device_keys[userId]?.[deviceId];
  if (device && (!setup.expectedKeys || device.keys[`ed25519:${deviceId}`] !== setup.expectedKeys.ed25519 ||
      device.keys[`curve25519:${deviceId}`] !== setup.expectedKeys.curve25519)) {
    throw new Error("Matrix device already exists without matching local keys");
  }
  await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: "matrix-call-worker" });
  const cryptoApi = client.getCrypto();
  if (!cryptoApi) throw new Error("Matrix crypto is unavailable");
  const keys = await cryptoApi.getOwnDeviceKeys();
  if (setup.expectedKeys && (keys.ed25519 !== setup.expectedKeys.ed25519 || keys.curve25519 !== setup.expectedKeys.curve25519)) {
    throw new Error("Matrix profile device keys changed");
  }
  await client.startClient({ initialSyncLimit: 1 });
  return Object.freeze(keys);
}

export async function enrollPinnedDevices(client: MatrixClient, setup: BrowserSetup, signal = AbortSignal.timeout(30_000)): Promise<void> {
  const cryptoApi = client.getCrypto();
  if (!cryptoApi) throw new Error("Matrix crypto is unavailable");
  let devices: Awaited<ReturnType<typeof cryptoApi.getUserDeviceInfo>>;
  for (;;) {
    signal.throwIfAborted();
    for (const id of setup.policy.rooms) {
      const room = joinedEncryptedRoom(client, id);
      if (!room) throw new Error("Joined encrypted Matrix room is unavailable");
      cryptoApi.prepareToEncrypt(room);
    }
    devices = await cancelable(cryptoApi.getUserDeviceInfo([...new Set(setup.policy.devices.map((pin) => pin.userId))], true), signal);
    signal.throwIfAborted();
    if (setup.policy.devices.every((pin) => devices.get(pin.userId)?.has(pin.deviceId))) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  for (const pin of setup.policy.devices) {
    const device = devices.get(pin.userId)!.get(pin.deviceId)!;
    if (device.userId !== pin.userId || device.deviceId !== pin.deviceId ||
        device.getFingerprint() !== pin.ed25519 || device.getIdentityKey() !== pin.curve25519) {
      throw new Error("Matrix device fingerprint does not match enrollment");
    }
    await cryptoApi.setDeviceVerified(pin.userId, pin.deviceId, true);
  }
}

export function joinedEncryptedRoom(client: MatrixClient, roomId: string) {
  const state = client.getSyncState();
  const room = client.getRoom(roomId);
  if ((state !== SyncState.Prepared && state !== SyncState.Syncing) || !room ||
      room.getMyMembership() !== "join" || !room.hasEncryptionStateEvent()) return undefined;
  return room;
}
