import type { ParticipantReference, ParticipantVerifier, PcmAudio } from "@matrix-call/core";
import { copyPcm } from "../../core/src/audio.js";
import { cancelable } from "../../voice/src/cancellation.js";

export type BrowserUtterance = Readonly<{
  reference: ParticipantReference;
  audio: Readonly<{ samples: number[]; sampleRate: number; channels: 1 }>;
}>;

export class VerifiedAudioInbox {
  readonly #controller = new AbortController();
  #epoch = 0;
  #listening = true;
  #verifying = false;
  #audio: { reference: ParticipantReference; audio: PcmAudio; expiresAtMs: number } | undefined;

  constructor(readonly verifier: ParticipantVerifier, readonly current: (reference: ParticipantReference) => boolean,
    readonly resetCapture: () => void, readonly now: () => number = Date.now) {}

  get listening(): boolean { return this.#listening && !this.#controller.signal.aborted; }

  async accept(reference: ParticipantReference, input: PcmAudio): Promise<void> {
    if (!this.listening || this.#verifying || this.#audio || !this.current(reference)) { input.samples.fill(0); return; }
    const audio = copyPcm(input); input.samples.fill(0);
    const epoch = this.#epoch; this.#verifying = true;
    try {
      const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(3000)]);
      const proof = await cancelable(this.verifier.verify(reference, signal), signal);
      if (!this.listening || epoch !== this.#epoch || !this.current(reference)) return;
      this.#audio = { reference: Object.freeze({ ...reference }), audio: copyPcm(audio), expiresAtMs: Math.min(proof.expiresAtMs, this.now() + 3000) };
    } catch {}
    finally { audio.samples.fill(0); this.#verifying = false; }
  }

  take(): BrowserUtterance | null {
    const entry = this.#audio;
    if (!entry) return null;
    this.#audio = undefined;
    try {
      if (!this.listening || entry.expiresAtMs <= this.now() || !this.current(entry.reference)) return null;
      this.pause();
      return { reference: entry.reference, audio: { samples: Array.from(entry.audio.samples), sampleRate: entry.audio.sampleRate, channels: 1 } };
    } finally { entry.audio.samples.fill(0); }
  }

  pause(): void { this.#listening = false; this.reset(); }

  resume(): void { if (!this.#controller.signal.aborted) { this.reset(); this.#listening = true; } }

  reset(): void {
    ++this.#epoch; this.#audio?.audio.samples.fill(0); this.#audio = undefined; this.resetCapture();
  }

  close(): void {
    if (this.#controller.signal.aborted) return;
    this.#controller.abort(); this.pause();
  }
}
