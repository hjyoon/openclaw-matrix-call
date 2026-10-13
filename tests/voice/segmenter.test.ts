import { describe, expect, it } from "vitest";
import { PcmSegmenter } from "../../packages/voice/src/segmenter.js";

const frame = (value = 0, length = 160) => new Float32Array(length).fill(value);
function push(segmenter: PcmSegmenter, count: number, value: number) {
  let result; for (let i = 0; i < count; i++) result = segmenter.push(frame(value));
  return result;
}

describe("bounded PCM utterances", () => {
  it("preserves a bounded pre-roll and ends a voiced utterance after 600ms of silence", () => {
    const segmenter = new PcmSegmenter(8000);
    expect(push(segmenter, 30, 0.001)).toBeUndefined();
    expect(push(segmenter, 15, 0.2)).toBeUndefined();
    const result = push(segmenter, 30, 0)!;
    expect(result.sampleRate).toBe(8000); expect(result.channels).toBe(1);
    expect(result.samples).toHaveLength(8800);
    expect(result.samples[0]).toBe(33); expect(result.samples[1600]).toBe(6554);
    expect(result.samples.at(-1)).toBe(0); expect(Object.isFrozen(result)).toBe(true);
  });

  it("drops short noises, clears state explicitly and does not retain preceding speakers", () => {
    const segmenter = new PcmSegmenter(8000);
    push(segmenter, 9, 0.5); expect(push(segmenter, 30, 0)).toBeUndefined();
    push(segmenter, 10, -0.5); segmenter.reset();
    push(segmenter, 10, 0.5); const result = push(segmenter, 30, 0)!;
    expect(result.samples[0]).toBe(16384); expect(result.samples).toHaveLength(6400);
  });

  it("bounds continuous sound to ten seconds and clips signed extremes", () => {
    const segmenter = new PcmSegmenter(8000);
    push(segmenter, 499, 2); const result = segmenter.push(frame(-2))!;
    expect(result.samples).toHaveLength(80000); expect(result.samples[0]).toBe(32767);
    expect(result.samples.at(-1)).toBe(-32768);
  });

  it("handles partial maximum frames and a renewed voiced section before trailing silence", () => {
    const segmenter = new PcmSegmenter(8000);
    segmenter.push(frame(0.5, 1)); push(segmenter, 499, 0.5);
    expect(segmenter.push(frame(0.5))!.samples).toHaveLength(80000);
    push(segmenter, 10, 0.5); push(segmenter, 20, 0); push(segmenter, 10, 0.5);
    expect(push(segmenter, 30, 0)!.samples).toHaveLength(11200);
  });

  it.each([7999, 48001, 16000.5, NaN])("rejects unsupported sample rate %s", (rate) => {
    expect(() => new PcmSegmenter(rate)).toThrow("Invalid capture sample rate");
  });

  it.each([[], frame(0, 0), frame(0, 801), frame(NaN), frame(Infinity)])("rejects invalid or unbounded chunks %#", (samples) => {
    expect(() => new PcmSegmenter(8000).push(samples as Float32Array)).toThrow("Invalid capture");
  });
});
