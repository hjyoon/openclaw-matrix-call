import { describe, expect, it, vi } from "vitest";
import { EventType } from "matrix-js-sdk";
import { DeviceVerificationStatus, type CryptoApi } from "matrix-js-sdk/lib/crypto-api/index.js";
import { MatrixMediaKeyProvider } from "../../packages/matrixrtc/src/key-provider.js";
import { publishMatrixRtcKey, type OutboundKeySource } from "../../packages/matrixrtc/src/outbound-key.js";
import type { RtcMembership } from "../../packages/matrixrtc/src/verified-keys.js";

const local: RtcMembership = { userId: "@bot:example.org", deviceId: "BOT", memberId: "local-member", participantId: "local-sfu", createdAtMs: 90_000, expiresAtMs: 200_000 };
const remote: RtcMembership = { ...local, userId: "@alice:example.org", deviceId: "ALICE", memberId: "remote-member", participantId: "remote-sfu" };

function fixture() {
  let members: readonly RtcMembership[] = [local, remote];
  const getDeviceVerificationStatus = vi.fn(async () => new DeviceVerificationStatus({ localVerified: true }));
  const cryptoApi = { getDeviceVerificationStatus };
  const provider = new MatrixMediaKeyProvider();
  const source = {
    roomId: "!room", owners: [local.userId, remote.userId],
    client: { getUserId: () => local.userId, getDeviceId: () => local.deviceId, getCrypto: () => cryptoApi as unknown as CryptoApi, encryptAndSendToDevice: vi.fn(async () => {}) },
    memberships: () => members, isJoined: vi.fn(() => true), now: vi.fn(() => 100_000), sink: provider,
  } satisfies OutboundKeySource;
  return { source, provider, getDeviceVerificationStatus, setMembers: (value: readonly RtcMembership[]) => { members = value; }, signal: new AbortController().signal };
}

describe("publishMatrixRtcKey", () => {
  it("generates unique local keys, verifies listeners, and uses only public encrypted delivery", async () => {
    const { source, provider, getDeviceVerificationStatus, signal } = fixture();
    expect(await publishMatrixRtcKey(source, 0, signal)).toBe(true);
    expect(getDeviceVerificationStatus).toHaveBeenCalledWith(remote.userId, remote.deviceId);
    const firstCall = source.client.encryptAndSendToDevice.mock.calls[0]! as unknown as [string, unknown, { keys: { key: string; index: number } }];
    expect(firstCall).toEqual([EventType.CallEncryptionKeysPrefix, [{ userId: remote.userId, deviceId: remote.deviceId }], {
      room_id: "!room", member: { id: "local-member", claimed_device_id: "BOT" },
      session: { application: "m.call", call_id: "", scope: "m.room" }, sent_ts: 100_000,
      keys: { index: 0, key: expect.stringMatching(/^[A-Za-z0-9+/]{22}$/) },
    }]);
    expect(atob(firstCall[2].keys.key)).toHaveLength(16);
    expect(provider.getKeys()[0]).toMatchObject({ participantIdentity: "local-sfu", keyIndex: 0 });
    await publishMatrixRtcKey(source, 255, signal);
    const second = source.client.encryptAndSendToDevice.mock.calls[1]! as unknown as typeof firstCall;
    expect(second[2].keys.key).not.toBe(firstCall[2].keys.key);
    expect(provider.getKeys()).toHaveLength(2);
  });

  it("supports a solitary local member and sticky membership without sending to itself", async () => {
    const { source, setMembers, signal } = fixture();
    setMembers([{ ...local, expiresAtMs: undefined }]);
    expect(await publishMatrixRtcKey(source, 0, signal)).toBe(true);
    expect(source.client.encryptAndSendToDevice).not.toHaveBeenCalled();
  });

  it("treats another device on the same Matrix account as a remote listener", async () => {
    const { source, setMembers, getDeviceVerificationStatus, signal } = fixture();
    setMembers([local, { ...remote, userId: local.userId, deviceId: "OTHER" }]);
    expect(await publishMatrixRtcKey(source, 0, signal)).toBe(true);
    expect(getDeviceVerificationStatus).toHaveBeenCalledWith(local.userId, "OTHER");
  });

  it.each([-1, 0.5, 256])("rejects invalid key indices before distribution: %s", async (index) => {
    const { source, signal } = fixture();
    await expect(publishMatrixRtcKey(source, index, signal)).rejects.toThrow("Invalid MatrixRTC key index");
    expect(source.client.encryptAndSendToDevice).not.toHaveBeenCalled();
  });

  it.each([NaN, -1])("rejects invalid clocks: %s", async (now) => {
    const { source, signal } = fixture();
    source.now.mockReturnValue(now);
    await expect(publishMatrixRtcKey(source, 0, signal)).rejects.toThrow("Invalid MatrixRTC clock");
  });

  it.each([
    [], [remote], [local, local],
    [local, { ...remote, participantId: local.participantId }],
    [local, ...Array.from({ length: 64 }, (_, i) => ({ ...remote, participantId: `remote-${i}` }))],
  ].map((members) => ({ members })))("requires unique bounded local membership", async ({ members }) => {
    const { source, setMembers, signal } = fixture();
    setMembers(members);
    await expect(publishMatrixRtcKey(source, 0, signal)).rejects.toThrow("local membership is unavailable");
  });

  it("requires a joined local session", async () => {
    const { source, signal } = fixture();
    source.isJoined.mockReturnValue(false);
    await expect(publishMatrixRtcKey(source, 0, signal)).rejects.toThrow("local membership is unavailable");
  });

  it.each([
    { userId: "@unknown:example.org" }, { createdAtMs: NaN }, { createdAtMs: -1 }, { createdAtMs: 100_001 },
    { expiresAtMs: NaN }, { expiresAtMs: 100_000 },
  ])("rejects unauthorized, invalid, or expired listeners before distribution", async (change) => {
    const { source, setMembers, signal } = fixture();
    setMembers([local, { ...remote, ...change }]);
    await expect(publishMatrixRtcKey(source, 0, signal)).rejects.toThrow("listener is not authorized");
    expect(source.client.encryptAndSendToDevice).not.toHaveBeenCalled();
  });

  it("requires initialized crypto and current verified remote devices", async () => {
    const { source, signal } = fixture();
    source.client.getCrypto = () => undefined as unknown as CryptoApi;
    await expect(publishMatrixRtcKey(source, 0, signal)).rejects.toThrow("crypto is unavailable");
    for (const status of [null, new DeviceVerificationStatus({ localVerified: false })]) {
      source.client.getCrypto = () => ({ getDeviceVerificationStatus: async () => status }) as unknown as CryptoApi;
      await expect(publishMatrixRtcKey(source, 0, signal)).rejects.toThrow("listener device is not verified");
    }
  });

  it("discards membership changes during verification before sending anything", async () => {
    const { source, setMembers, getDeviceVerificationStatus, signal } = fixture();
    getDeviceVerificationStatus.mockImplementation(async () => {
      setMembers([local]);
      return new DeviceVerificationStatus({ localVerified: true });
    });
    expect(await publishMatrixRtcKey(source, 0, signal)).toBe(false);
    expect(source.client.encryptAndSendToDevice).not.toHaveBeenCalled();
  });

  it.each(["changed", "left", "expired", "invalid-clock", "negative-clock", "clock-rollback"])("discards a key when delivery completes after membership is %s", async (change) => {
    const { source, setMembers, provider, signal } = fixture();
    source.client.encryptAndSendToDevice.mockImplementation(async () => {
      if (change === "changed") setMembers([local]);
      if (change === "left") source.isJoined.mockReturnValue(false);
      if (change === "expired") source.now.mockReturnValue(200_000);
      if (change === "invalid-clock") source.now.mockReturnValue(NaN);
      if (change === "negative-clock") source.now.mockReturnValue(-1);
      if (change === "clock-rollback") source.now.mockReturnValue(80_000);
    });
    expect(await publishMatrixRtcKey(source, 0, signal)).toBe(false);
    expect(provider.getKeys()).toEqual([]);
  });

  it("checks cancellation before verification, after verification, and after delivery", async () => {
    const { source } = fixture();
    await expect(publishMatrixRtcKey(source, 0, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
    const first = new AbortController();
    source.client.getCrypto = () => ({ getDeviceVerificationStatus: async () => {
      first.abort(new Error("cancelled during lookup"));
      return new DeviceVerificationStatus({ localVerified: true });
    } }) as unknown as CryptoApi;
    await expect(publishMatrixRtcKey(source, 0, first.signal)).rejects.toThrow("cancelled during lookup");
    source.client.getCrypto = () => ({ getDeviceVerificationStatus: async () => new DeviceVerificationStatus({ localVerified: true }) }) as unknown as CryptoApi;
    const second = new AbortController();
    source.client.encryptAndSendToDevice.mockImplementation(async () => { second.abort(new Error("cancelled during delivery")); });
    await expect(publishMatrixRtcKey(source, 0, second.signal)).rejects.toThrow("cancelled during delivery");
  });

  it("lets the real provider discard an import interrupted after delivery", async () => {
    const { source, provider } = fixture();
    const controller = new AbortController();
    const install = provider.install.bind(provider);
    source.sink.install = (identity, bytes, index, current) => {
      const pending = install(identity, bytes, index, current);
      controller.abort();
      return pending;
    };
    expect(await publishMatrixRtcKey(source, 0, controller.signal)).toBe(false);
    expect(provider.getKeys()).toEqual([]);
  });
});
