import { describe, expect, it, vi } from "vitest";
import { MatrixPublicationGuard } from "../../packages/browser-worker/src/guard.js";
import { MatrixMediaKeyProvider } from "../../packages/matrixrtc/src/key-provider.js";
import type { OutboundKeySource } from "../../packages/matrixrtc/src/outbound-key.js";

function fixture() {
  const source: OutboundKeySource = { roomId: "!room", owners: [], client: { getUserId: () => "@bot:example.org", getDeviceId: () => "BOT", getCrypto: () => ({}) as never, encryptAndSendToDevice: async () => {} }, memberships: () => [{ userId: "@bot:example.org", deviceId: "BOT", memberId: "local", participantId: "local", createdAtMs: 1, expiresAtMs: undefined }], isJoined: () => true, now: () => 10, sink: new MatrixMediaKeyProvider() };
  const media = { suspend: vi.fn(), resume: vi.fn() };
  const publish = vi.fn(async () => true);
  const guard = new MatrixPublicationGuard(source, media, publish);
  return { source, media, publish, guard };
}

describe("Matrix publication guard", () => {
  it("suspends immediately and permits only the current freshly authorized revision", async () => {
    const f = fixture();
    expect(f.guard.permits(0)).toBe(false);
    const task = f.guard.refresh();
    expect(f.media.suspend).toHaveBeenCalledOnce();
    expect(f.guard.permits(f.guard.revision)).toBe(false);
    await task;
    expect(f.guard.revision).toBe(1);
    expect(f.guard.permits(1)).toBe(true);
    expect(f.guard.permits(0)).toBe(false);
    expect(f.publish).toHaveBeenCalledWith(f.source, 0, expect.any(AbortSignal));
    await f.guard.refresh();
    expect(f.publish).toHaveBeenLastCalledWith(f.source, 1, expect.any(AbortSignal));
    expect(f.guard.permits(1)).toBe(false);
    f.guard.close();
    expect(f.guard.permits(2)).toBe(false);
    await expect(f.guard.refresh()).rejects.toThrow("closed");
  });

  it("uses the actual local key publisher by default", async () => {
    const f = fixture();
    const guard = new MatrixPublicationGuard(f.source, f.media);
    await guard.refresh();
    expect(f.source.sink).toBeInstanceOf(MatrixMediaKeyProvider);
    expect((f.source.sink as MatrixMediaKeyProvider).getKeys()).toHaveLength(1);
    guard.close();
  });

  it("coalesces obsolete queued changes without reusing key indices", async () => {
    const f = fixture();
    const one = f.guard.refresh();
    const two = f.guard.refresh();
    await Promise.all([one, two]);
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.guard.permits(2)).toBe(true);
  });

  it("serializes pending imports and prevents stale completion from enabling publication", async () => {
    const f = fixture();
    let complete!: (value: boolean) => void;
    f.publish.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const one = f.guard.refresh();
    await Promise.resolve();
    const two = f.guard.refresh();
    expect(f.publish).toHaveBeenCalledOnce();
    complete(true);
    await one;
    expect(f.media.resume).not.toHaveBeenCalled();
    await two;
    expect(f.media.resume).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenLastCalledWith(f.source, 1, expect.any(AbortSignal));
  });

  it.each([false, new Error("device unverified")])("closes permanently when authorization fails", async (result) => {
    const f = fixture();
    if (result instanceof Error) f.publish.mockRejectedValueOnce(result);
    else f.publish.mockResolvedValueOnce(result);
    await expect(f.guard.refresh()).rejects.toThrow();
    expect(f.guard.permits(f.guard.revision)).toBe(false);
    await expect(f.guard.refresh()).rejects.toThrow("closed");
    expect(f.media.resume).not.toHaveBeenCalled();
  });

  it("does not wrap the 256-index key ring within a call", async () => {
    const f = fixture();
    for (let i = 0; i < 256; i++) await f.guard.refresh();
    expect(f.publish).toHaveBeenCalledTimes(256);
    await expect(f.guard.refresh()).rejects.toThrow("rotation limit reached");
    expect(f.guard.permits(f.guard.revision)).toBe(false);
  });

  it("discards queued and pending rotations after closure", async () => {
    const f = fixture();
    const queued = f.guard.refresh();
    f.guard.close();
    await queued;
    expect(f.publish).not.toHaveBeenCalled();
    const g = fixture();
    let complete!: (value: boolean) => void;
    g.publish.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = g.guard.refresh();
    await Promise.resolve();
    g.guard.close(); complete(true);
    await pending;
    expect(g.media.resume).not.toHaveBeenCalled();
  });
});
