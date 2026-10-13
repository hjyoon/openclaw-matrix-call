import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { PcmAudio, SpeechRecognitionPort, SpeechSynthesisPort } from "@matrix-call/core";
import { runEngine, SpeechEngineError } from "./process.js";
import { decodeWav, encodeWav, recognitionPcm } from "./wav.js";

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute).refine((value) => !value.includes("\0"));
const language = z.enum(["auto", "ko", "en"]);
const recognitionOptions = z.strictObject({
  binary: absolutePath, model: absolutePath, temporaryDir: absolutePath,
  language: language.default("auto"), threads: z.number().int().min(1).max(8).default(2),
});
const synthesisOptions = z.strictObject({
  binary: absolutePath, language: language.default("auto"),
  wordsPerMinute: z.number().int().min(80).max(300).default(175),
});
const transcript = z.string().trim().max(16_000);
const speechText = z.string().trim().min(1).max(16_000).refine((value) => !value.includes("\0"));

export class WhisperRecognition implements SpeechRecognitionPort {
  readonly #options: z.infer<typeof recognitionOptions>;
  readonly #run: typeof runEngine;

  constructor(options: { binary: string; model: string; temporaryDir?: string; language?: "auto" | "ko" | "en"; threads?: number }, run: typeof runEngine = runEngine) {
    this.#options = recognitionOptions.parse({ ...options, temporaryDir: options.temporaryDir ?? tmpdir() });
    this.#run = run;
  }

  async transcribe(input: PcmAudio, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const audio = recognitionPcm(input);
    const wav = encodeWav(audio);
    audio.samples.fill(0);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(this.#options.temporaryDir, "matrix-call-speech-"));
      const file = join(directory, "input.wav");
      await writeFile(file, wav, { mode: 0o600, signal });
      const output = await this.#run({
        file: this.#options.binary, args: ["-m", this.#options.model, "-f", file, "-l", this.#options.language,
          "-t", String(this.#options.threads), "-ng", "-np", "-nt"],
        input: Buffer.alloc(0), maxOutputBytes: 64_000,
      }, signal);
      try {
        signal.throwIfAborted();
        return transcript.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
      } finally { output.fill(0); }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SpeechEngineError) throw error;
      throw new SpeechEngineError("engine-failed");
    } finally {
      wav.fill(0);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

export class EspeakSynthesis implements SpeechSynthesisPort {
  readonly #options: z.infer<typeof synthesisOptions>;
  readonly #run: typeof runEngine;

  constructor(options: { binary: string; language?: "auto" | "ko" | "en"; wordsPerMinute?: number }, run: typeof runEngine = runEngine) {
    this.#options = synthesisOptions.parse(options);
    this.#run = run;
  }

  async synthesize(value: string, signal: AbortSignal): Promise<PcmAudio> {
    signal.throwIfAborted();
    const text = speechText.parse(value);
    const selected = this.#options.language === "auto" ? (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(text) ? "ko" : "en") : this.#options.language;
    const input = Buffer.from(text, "utf8");
    try {
      const output = await this.#run({
        file: this.#options.binary, args: ["--stdin", "--stdout", "-b", "1", "-v", selected, "-s", String(this.#options.wordsPerMinute)],
        input, maxOutputBytes: 441_044,
      }, signal);
      try { signal.throwIfAborted(); return decodeWav(output, true); }
      finally { output.fill(0); }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SpeechEngineError) throw error;
      throw new SpeechEngineError("engine-failed");
    } finally { input.fill(0); }
  }
}
