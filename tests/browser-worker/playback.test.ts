import { describe, expect, it, vi } from "vitest";
import { PcmPlayback } from "../../packages/browser-worker/src/playback.js";

const pcm = { samples: new Int16Array(8000).fill(16384), sampleRate: 8000, channels: 1 as const };
function fixture() {
  const samples = new Float32Array(8000); const sources: Array<{ onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const context = { currentTime: 0, createBuffer: vi.fn(() => ({ getChannelData: () => samples })), createBufferSource: vi.fn(() => {
    const source = { onended: null as (() => void) | null, buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
    sources.push(source); return source;
  }) };
  const player = new PcmPlayback(context as unknown as AudioContext, {} as AudioNode);
  return { player, context, samples, sources };
}
const signal = () => new AbortController().signal;

describe("reauthorized PCM playback", () => {
  it("pauses without completing, resumes from the exact remaining position and ignores stale ended callbacks", async () => {
    const f = fixture(); f.player.pause(); f.player.resume(); const pending = f.player.play(pcm, signal());
    expect(f.samples[0]).toBe(0.5); f.player.resume(); expect(f.sources.length).toBe(1);
    const stale = f.sources[0]!.onended!;
    f.context.currentTime = 0.25; f.player.pause(); f.player.pause(); expect(f.sources[0]!.stop).toHaveBeenCalledOnce();
    f.context.currentTime = 20; f.player.resume(); expect(f.sources[1]!.start).toHaveBeenCalledWith(0, 0.25);
    stale(); expect(f.samples[0]).toBe(0.5);
    f.context.currentTime = 20.25; f.player.pause(); f.player.resume();
    expect(f.sources[2]!.start).toHaveBeenCalledWith(0, 0.5);
    f.sources[2]!.onended!(); await pending; expect(f.samples.every((sample) => sample === 0)).toBe(true);
    f.player.close(); f.player.close(); f.player.resume();
    await expect(f.player.play(pcm, signal())).rejects.toThrow("unavailable");
  });

  it("converts signed PCM without changing borrowed input and wipes the browser buffer", async () => {
    const f = fixture(); const samples = pcm.samples.slice(); samples.set([-32768, 0, 16384]);
    const pending = f.player.play({ ...pcm, samples }, signal());
    expect([...f.samples.slice(0, 3)]).toEqual([-1, 0, 0.5]);
    f.sources[0]!.onended!(); await pending;
    expect(samples.slice(0, 3)).toEqual(new Int16Array([-32768, 0, 16384]));
    expect(f.samples.every((sample) => sample === 0)).toBe(true);
  });

  it("completes only after reauthorization when suspension occurs at the final sample", async () => {
    const f = fixture(); const pending = f.player.play(pcm, signal());
    f.context.currentTime = 1.5; f.player.pause(); f.player.resume(); await pending;
    expect(f.sources.length).toBe(1); expect(f.samples.every((sample) => sample === 0)).toBe(true);
  });

  it("rejects overlaps and aborts suspended playback without starting another source", async () => {
    const f = fixture(); const controller = new AbortController();
    const pending = f.player.play(pcm, controller.signal); const failed = expect(pending).rejects.toThrow("closed");
    await expect(f.player.play(pcm, signal())).rejects.toThrow("unavailable");
    f.player.pause(); controller.abort(new Error("closed")); await failed; f.player.resume();
    expect(f.sources.length).toBe(1); expect(f.samples.every((sample) => sample === 0)).toBe(true);
    await expect(f.player.play(pcm, controller.signal)).rejects.toThrow("closed");
  });

  it("rejects and wipes paused audio on permanent closure", async () => {
    const f = fixture(); const pending = f.player.play(pcm, signal()); const failed = expect(pending).rejects.toThrow("unavailable");
    f.player.pause(); f.player.close(); await failed; expect(f.samples.every((sample) => sample === 0)).toBe(true);
  });

  it("cleans an unsuccessful source setup even if stopping an unstarted node throws", async () => {
    const f = fixture(); f.context.createBufferSource.mockImplementationOnce(() => {
      const source = { onended: null, buffer: null, connect: vi.fn(), start: vi.fn(() => { throw new Error("start failed"); }),
        stop: vi.fn(() => { throw new Error("not started"); }), disconnect: vi.fn() };
      f.sources.push(source); return source;
    });
    await expect(f.player.play(pcm, signal())).rejects.toThrow("start failed");
    expect(f.sources[0]!.disconnect).toHaveBeenCalledOnce(); expect(f.samples.every((sample) => sample === 0)).toBe(true);
  });
});
