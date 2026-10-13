import type { PcmAudio } from "@matrix-call/core";

export class PcmSegmenter {
  readonly #buffer: Int16Array;
  readonly #preRoll: Int16Array;
  #preLength = 0;
  #length = 0;
  #voiced = 0;
  #silence = 0;

  constructor(readonly sampleRate: number) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48_000) throw new Error("Invalid capture sample rate");
    this.#buffer = new Int16Array(sampleRate * 10);
    this.#preRoll = new Int16Array(Math.ceil(sampleRate / 5));
  }

  push(samples: Float32Array): PcmAudio | undefined {
    if (!(samples instanceof Float32Array) || samples.length < 1 || samples.length > Math.ceil(this.sampleRate / 10)) {
      throw new Error("Invalid capture chunk");
    }
    let power = 0;
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i]!;
      if (!Number.isFinite(value)) throw new Error("Invalid capture sample");
      const clamped = Math.max(-1, Math.min(1, value));
      power += clamped * clamped;
      pcm[i] = Math.min(32767, Math.round(clamped * 32768));
    }
    const audible = Math.sqrt(power / samples.length) >= 0.012;
    if (!this.#length) {
      if (!audible) {
        const kept = Math.min(this.#preLength, this.#preRoll.length - pcm.length);
        this.#preRoll.copyWithin(0, this.#preLength - kept, this.#preLength);
        this.#preRoll.set(pcm, kept); this.#preLength = kept + pcm.length;
        return undefined;
      }
      this.#buffer.set(this.#preRoll.subarray(0, this.#preLength));
      this.#length = this.#preLength; this.#preLength = 0;
    }
    const count = Math.min(pcm.length, this.#buffer.length - this.#length);
    this.#buffer.set(pcm.subarray(0, count), this.#length); this.#length += count;
    if (audible) { this.#voiced += count; this.#silence = 0; }
    else this.#silence += count;
    if (this.#length < this.#buffer.length && this.#silence < this.sampleRate * 0.6) return undefined;
    const result = this.#voiced >= this.sampleRate * 0.2
      ? Object.freeze({ samples: this.#buffer.slice(0, this.#length), sampleRate: this.sampleRate, channels: 1 as const }) : undefined;
    this.reset();
    return result;
  }

  reset(): void {
    this.#buffer.fill(0); this.#preRoll.fill(0);
    this.#preLength = 0; this.#length = 0; this.#voiced = 0; this.#silence = 0;
  }
}
