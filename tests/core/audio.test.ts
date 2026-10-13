import { describe, expect, it } from "vitest";
import { copyPcm, validatePcm, type PcmAudio } from "../../packages/core/src/index.js";

const audio: PcmAudio = { samples: new Int16Array([-32768, 0, 32767]), sampleRate: 16_000, channels: 1 };

describe("portable PCM", () => {
  it("copies audio independently without changing its format or signed samples", () => {
    const copied = copyPcm(audio);
    expect(copied).toEqual(audio);
    expect(Object.isFrozen(copied)).toBe(true);
    copied.samples[0] = 1;
    expect(audio.samples[0]).toBe(-32768);
    validatePcm({ ...audio, sampleRate: 8000 });
    validatePcm({ ...audio, sampleRate: 48_000, samples: new Int16Array(480_000) });
  });

  it.each([
    { ...audio, channels: 2 }, { ...audio, sampleRate: 16_000.5 }, { ...audio, sampleRate: 7999 },
    { ...audio, sampleRate: 48_001 }, { ...audio, samples: [1] }, { ...audio, samples: new Int16Array() },
    { ...audio, samples: new Int16Array(160_001) },
  ])("rejects invalid and unbounded audio %#", (value) => {
    expect(() => copyPcm(value as PcmAudio)).toThrow("Invalid PCM audio");
  });
});
