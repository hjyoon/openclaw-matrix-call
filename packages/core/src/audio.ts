import type { PcmAudio } from "./contracts.js";

export class SynthesisLimitError extends Error {
  readonly code = "synthesis-too-long";
  constructor() { super("synthesis-too-long"); this.name = "SynthesisLimitError"; }
}

export function isSynthesisLimit(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "synthesis-too-long";
}

export function validatePcm(audio: PcmAudio): void {
  if (audio.channels !== 1 || !Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 48_000 ||
      !(audio.samples instanceof Int16Array) || audio.samples.length < 1 || audio.samples.length > audio.sampleRate * 10) {
    throw new Error("Invalid PCM audio");
  }
}

export function copyPcm(audio: PcmAudio): PcmAudio {
  validatePcm(audio);
  return Object.freeze({ samples: audio.samples.slice(), sampleRate: audio.sampleRate, channels: 1 });
}
