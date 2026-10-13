import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifiedAudioInbox } from "../../packages/browser-worker/src/inbox.js";
import type { ParticipantReference, VerifiedParticipant } from "../../packages/core/src/index.js";

afterEach(() => vi.useRealTimers());
const reference = { roomId: "!room", rtcSessionId: "m.call#ROOM", participantId: "speaker" };
const proof = { ...reference, userId: "@owner:example.org", deviceId: "DEVICE", expiresAtMs: 5000, mediaEncrypted: true, deviceVerified: true };
const pcm = () => ({ samples: new Int16Array([1, 2, 3]), sampleRate: 16_000, channels: 1 as const });
function fixture() {
  const verify = vi.fn(async (_reference: ParticipantReference, _signal: AbortSignal): Promise<VerifiedParticipant> => proof);
  const current = vi.fn(() => true); const reset = vi.fn(); const now = vi.fn(() => 1000);
  const inbox = new VerifiedAudioInbox({ verify }, current, reset, now);
  return { inbox, verify, current, reset, now };
}

describe("verified call audio inbox", () => {
  it("verifies owned PCM, exposes one private serialized utterance and pauses until resumed", async () => {
    const f = fixture(); const input = pcm(); await f.inbox.accept(reference, input);
    expect(input.samples).toEqual(new Int16Array(3));
    expect(f.verify).toHaveBeenCalledWith(reference, expect.any(AbortSignal));
    expect(f.inbox.take()).toEqual({ reference, audio: { samples: [1, 2, 3], sampleRate: 16_000, channels: 1 } });
    expect(f.inbox.listening).toBe(false); expect(f.inbox.take()).toBeNull();
    await f.inbox.accept(reference, pcm()); expect(f.verify).toHaveBeenCalledOnce();
    f.inbox.resume(); expect(f.inbox.listening).toBe(true);
    await f.inbox.accept(reference, pcm()); expect(f.inbox.take()).not.toBeNull(); f.inbox.close();
  });

  it("uses the real clock by default and expires input against both proof and capture age", async () => {
    const f = fixture(); f.verify.mockResolvedValue({ ...proof, expiresAtMs: Date.now() + 30000 });
    const inbox = new VerifiedAudioInbox({ verify: f.verify }, f.current, f.reset);
    await inbox.accept(reference, pcm()); expect(inbox.take()).not.toBeNull(); inbox.close();
    await f.inbox.accept(reference, pcm()); f.now.mockReturnValue(4000);
    expect(f.inbox.take()).toBeNull();
    f.verify.mockResolvedValueOnce({ ...proof, expiresAtMs: 4001 });
    await f.inbox.accept(reference, pcm()); f.now.mockReturnValue(4001); expect(f.inbox.take()).toBeNull(); f.inbox.close();
  });

  it("discards unverified, invalid, revoked and reset input before it reaches the host", async () => {
    const f = fixture(); f.current.mockReturnValueOnce(false);
    const input = pcm(); await f.inbox.accept(reference, input); expect(input.samples).toEqual(new Int16Array(3));
    await expect(f.inbox.accept(reference, { ...pcm(), samples: new Int16Array() })).rejects.toThrow("Invalid PCM");
    f.verify.mockRejectedValueOnce(new Error("unverified")); await f.inbox.accept(reference, pcm()); expect(f.inbox.take()).toBeNull();
    await f.inbox.accept(reference, pcm()); f.current.mockReturnValueOnce(false); expect(f.inbox.take()).toBeNull();
    await f.inbox.accept(reference, pcm()); f.inbox.reset(); expect(f.inbox.take()).toBeNull(); f.inbox.close();
  });

  it("keeps at most one verification or utterance pending and clears all data on close", async () => {
    const f = fixture(); let finish!: (value: VerifiedParticipant) => void;
    f.verify.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = f.inbox.accept(reference, pcm()); await f.inbox.accept(reference, pcm());
    expect(f.verify).toHaveBeenCalledOnce(); finish(proof); await pending;
    await f.inbox.accept(reference, pcm()); expect(f.verify).toHaveBeenCalledOnce();
    f.inbox.close(); f.inbox.close(); f.inbox.resume();
    expect(f.inbox.listening).toBe(false); expect(f.inbox.take()).toBeNull();
    await f.inbox.accept(reference, pcm()); expect(f.verify).toHaveBeenCalledOnce();
  });

  it.each(["pause", "reset", "membership", "close"])("discards verification that finishes after %s", async (event) => {
    const f = fixture(); let finish!: (value: VerifiedParticipant) => void;
    f.verify.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = f.inbox.accept(reference, pcm());
    if (event === "pause") f.inbox.pause();
    else if (event === "reset") f.inbox.reset();
    else if (event === "membership") f.current.mockReturnValue(false);
    else f.inbox.close();
    finish(proof); await pending; expect(f.inbox.take()).toBeNull(); f.inbox.close();
  });

  it("bounds uncooperative verification and returns after call cancellation", async () => {
    vi.useFakeTimers(); const f = fixture(); f.verify.mockReturnValueOnce(new Promise(() => {}));
    const pending = f.inbox.accept(reference, pcm()); await vi.advanceTimersByTimeAsync(3000); await pending;
    expect(f.inbox.take()).toBeNull();
    f.verify.mockReturnValueOnce(new Promise(() => {})); const next = f.inbox.accept(reference, pcm());
    f.inbox.close(); await next; expect(f.inbox.take()).toBeNull();
  });
});
