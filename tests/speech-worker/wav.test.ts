import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav, recognitionPcm } from "../../packages/speech-worker/src/index.js";

const audio = { samples: new Int16Array([-32768, -1, 0, 1, 32767]), sampleRate: 16_000, channels: 1 as const };

describe("engine WAV boundary", () => {
  it("round-trips signed mono PCM with explicit little-endian samples and owned storage", () => {
    const wav = encodeWav(audio);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.subarray(44)).toEqual(Buffer.from([0, 128, 255, 255, 0, 0, 1, 0, 255, 127]));
    const result = decodeWav(wav);
    expect(result).toEqual(audio);
    expect(Object.isFrozen(result)).toBe(true);
    wav.fill(0);
    expect(result.samples).toEqual(audio.samples);
  });

  it.each([8000, 16_000, 22_050, 48_000])("accepts at most ten seconds at %i Hz", (sampleRate) => {
    const value = { ...audio, sampleRate, samples: new Int16Array(sampleRate * 10) };
    expect(decodeWav(encodeWav(value))).toEqual(value);
    const overlong = Buffer.concat([encodeWav(value), Buffer.alloc(2)]);
    overlong.writeUInt32LE(overlong.length - 8, 4);
    overlong.writeUInt32LE(overlong.length - 44, 40);
    expect(() => decodeWav(overlong)).toThrow();
  });

  it.each([
    [0, "RIFX"], [8, "RF64fmt "], [36, "LIST"],
  ] as const)("rejects unsupported container marker at %i", (offset, marker) => {
    const wav = encodeWav(audio);
    wav.write(marker, offset);
    expect(() => decodeWav(wav)).toThrow("Invalid engine WAV output");
  });

  it("rejects high-bit aliases of the container markers without ASCII masking", () => {
    for (const offset of [0, 8, 12, 36]) {
      const wav = encodeWav(audio);
      wav[offset] = wav[offset]! | 0x80;
      expect(() => decodeWav(wav)).toThrow("Invalid engine WAV output");
    }
  });

  it.each([
    [16, 18, 4], [20, 3, 2], [22, 2, 2], [24, 7999, 4], [28, 1, 4],
    [32, 4, 2], [34, 32, 2], [4, 99, 4], [40, 99, 4],
  ])("rejects inconsistent or unsupported format field at %i", (offset, value, bytes) => {
    const wav = encodeWav(audio);
    wav.writeUIntLE(value!, offset!, bytes!);
    expect(() => decodeWav(wav)).toThrow();
  });

  it("rejects missing, odd, empty or oversized payloads", () => {
    for (const wav of [Buffer.alloc(0), encodeWav(audio).subarray(0, 44), encodeWav(audio).subarray(0, 47), Buffer.alloc(960_046)]) {
      expect(() => decodeWav(wav)).toThrow("Invalid engine WAV output");
    }
    expect(() => encodeWav({ ...audio, channels: 2 as 1 })).toThrow("Invalid PCM audio");
  });

  it("accepts only the pinned eSpeak streaming sentinel when explicitly enabled", () => {
    const wav = encodeWav(audio);
    wav.writeUInt32LE(0x7ffff024, 4);
    wav.writeUInt32LE(0x7ffff000, 40);
    expect(() => decodeWav(wav)).toThrow("Invalid engine WAV output");
    expect(decodeWav(wav, true)).toEqual(audio);
    wav.writeUInt32LE(0x7ffff001, 40);
    expect(() => decodeWav(wav, true)).toThrow("Invalid engine WAV output");
    wav.writeUInt32LE(0x7ffff023, 4);
    expect(() => decodeWav(wav, true)).toThrow("Invalid engine WAV output");
    expect(decodeWav(encodeWav(audio), true)).toEqual(audio);
  });
});

describe("recognition resampling", () => {
  it("copies native 16 kHz PCM without mutating or sharing the source", () => {
    const result = recognitionPcm(audio);
    expect(result).toEqual(audio);
    expect(result.samples).not.toBe(audio.samples);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => recognitionPcm({ ...audio, sampleRate: 0 })).toThrow("Invalid PCM audio");
  });

  it.each([8000, 44_100, 48_000])("preserves duration and DC level when converting %i Hz", (sampleRate) => {
    const input = { ...audio, sampleRate, samples: new Int16Array(sampleRate).fill(1234) };
    const result = recognitionPcm(input);
    expect(result.sampleRate).toBe(16_000);
    expect(result.samples).toEqual(new Int16Array(16_000).fill(1234));
    expect(input.samples.every((sample) => sample === 1234)).toBe(true);
  });

  it("retains even a single input sample and clamps filter overshoot to signed PCM", () => {
    expect(recognitionPcm({ ...audio, sampleRate: 48_000, samples: new Int16Array([-32768]) }).samples).toEqual(new Int16Array([-32768]));
    const input = Int16Array.from({ length: 64 }, (_, i) => i < 32 ? -32768 : 32767);
    const result = recognitionPcm({ ...audio, sampleRate: 8000, samples: input });
    expect(Math.min(...result.samples)).toBe(-32768);
    expect(Math.max(...result.samples)).toBe(32767);
  });

  it("suppresses frequencies above the destination Nyquist limit", () => {
    const samples = Int16Array.from({ length: 4800 }, (_, i) => Math.round(16000 * Math.sin(2 * Math.PI * 12000 * i / 48_000)));
    const result = recognitionPcm({ ...audio, sampleRate: 48_000, samples });
    const steady = result.samples.subarray(32, -32);
    expect(Math.sqrt(steady.reduce((sum, sample) => sum + sample * sample, 0) / steady.length)).toBeLessThan(20);
  });
});
