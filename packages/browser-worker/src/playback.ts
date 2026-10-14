import type { PcmAudio } from "@matrix-call/core";
import { validatePcm } from "./audio.js";

type Playback = {
  buffer: AudioBuffer; samples: Float32Array; duration: number; offset: number; startedAt: number;
  source: AudioBufferSourceNode | undefined; resolve: () => void; reject: (error: unknown) => void;
};

export class PcmPlayback {
  readonly #context: AudioContext;
  readonly #destination: AudioNode;
  #active: Playback | undefined;
  #closed = false;

  constructor(context: AudioContext, destination: AudioNode) { this.#context = context; this.#destination = destination; }

  async play(audio: PcmAudio, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#closed || this.#active) throw new Error("Browser audio is unavailable");
    validatePcm(audio);
    const buffer = this.#context.createBuffer(1, audio.samples.length, audio.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < audio.samples.length; i++) samples[i] = audio.samples[i]! / 32768;
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const ended = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const playback: Playback = { buffer, samples, duration: audio.samples.length / audio.sampleRate, offset: 0,
      startedAt: 0, source: undefined, resolve, reject };
    this.#active = playback;
    const abort = (): void => { this.#release(playback); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    try { this.#start(playback); await ended; signal.throwIfAborted(); }
    finally { signal.removeEventListener("abort", abort); this.#release(playback); samples.fill(0); this.#active = undefined; }
  }

  pause(): void {
    const playback = this.#active;
    if (!playback?.source) return;
    playback.offset = Math.min(playback.duration, playback.offset + Math.max(0, this.#context.currentTime - playback.startedAt));
    this.#release(playback);
  }

  resume(): void { if (!this.#closed && this.#active) this.#start(this.#active); }

  close(): void {
    this.#closed = true;
    if (this.#active) { this.#release(this.#active); this.#active.reject(new Error("Browser audio is unavailable")); }
  }

  #release(playback: Playback): void {
    const source = playback.source; playback.source = undefined;
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch {}
    source.disconnect();
  }

  #start(playback: Playback): void {
    if (playback.source) return;
    if (playback.offset >= playback.duration) { playback.resolve(); return; }
    try {
      const source = this.#context.createBufferSource(); playback.source = source;
      source.buffer = playback.buffer; source.connect(this.#destination);
      source.onended = () => {
        if (playback.source !== source) return;
        playback.source = undefined; source.onended = null; source.disconnect(); playback.resolve();
      };
      playback.startedAt = this.#context.currentTime;
      source.start(0, playback.offset);
    } catch (error) { playback.reject(error); }
  }
}
