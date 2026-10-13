import { describe, expect, it } from "vitest";
import { KeyProviderEvent } from "livekit-client";
import { MatrixMediaKeyProvider } from "../../packages/matrixrtc/src/key-provider.js";

describe("MatrixMediaKeyProvider", () => {
  it("imports real WebCrypto HKDF material for separate participants and explicit indices", async () => {
    const provider = new MatrixMediaKeyProvider();
    const events: unknown[] = [];
    provider.on(KeyProviderEvent.SetKey, (...args) => events.push(args));
    const bytes = new Uint8Array(16).fill(7);
    expect(await provider.install("alice", bytes, 0, () => true)).toBe(true);
    expect(await provider.install("bob", new Uint8Array(16).fill(8), 255, () => true)).toBe(true);
    const keys = provider.getKeys();
    expect(keys.map(({ participantIdentity, keyIndex }) => [participantIdentity, keyIndex])).toEqual([["alice", 0], ["bob", 255]]);
    const first = keys[0]!.key;
    expect(first.algorithm.name).toBe("HKDF");
    expect(first.extractable).toBe(false);
    const params = { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("LKFrameEncryptionKey"), info: new Uint8Array() };
    const actual = await crypto.subtle.deriveBits(params, first, 128);
    const reference = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits"]);
    expect(new Uint8Array(actual)).toEqual(new Uint8Array(await crypto.subtle.deriveBits(params, reference, 128)));
    expect(events).toHaveLength(2);
    expect(events.every((event) => (event as unknown[])[1] === true)).toBe(true);
    expect(provider.getOptions()).toMatchObject({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0, keyringSize: 256, keySize: 128 });
    expect(provider.getLatestManuallySetKeyIndex()).toBe(255);
  });

  it("discards asynchronous imports when a membership or call has ended", async () => {
    const provider = new MatrixMediaKeyProvider();
    let current = true;
    const pending = provider.install("alice", new Uint8Array(16), 0, () => current);
    current = false;
    expect(await pending).toBe(false);
    expect(provider.getKeys()).toEqual([]);
  });

  it.each([
    ["", new Uint8Array(16), 0],
    ["a b", new Uint8Array(16), 0],
    ["a".repeat(1025), new Uint8Array(16), 0],
    ["alice", [] as unknown as Uint8Array<ArrayBuffer>, 0],
    ["alice", new Uint8Array(15), 0],
    ["alice", new Uint8Array(17), 0],
    ["alice", new Uint8Array(16), 0.5],
    ["alice", new Uint8Array(16), -1],
    ["alice", new Uint8Array(16), 256],
  ])("rejects invalid material without emitting keys (%s)", async (identity, bytes, index) => {
    const provider = new MatrixMediaKeyProvider();
    await expect(provider.install(identity as string, bytes as Uint8Array<ArrayBuffer>, index as number, () => true)).rejects.toThrow("Invalid MatrixRTC media key");
    expect(provider.getKeys()).toEqual([]);
  });
});
