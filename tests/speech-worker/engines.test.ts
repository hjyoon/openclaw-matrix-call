import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EspeakSynthesis, WhisperRecognition, decodeWav, encodeWav, SpeechEngineError, type runEngine } from "../../packages/speech-worker/src/index.js";

const audio = { samples: new Int16Array([1, -1, 0, 100]), sampleRate: 16_000, channels: 1 as const };
const signal = () => new AbortController().signal;
const whisper = { binary: "/opt/whisper-cli", model: "/models/tiny.bin" };
const espeak = { binary: "/opt/espeak-ng" };

describe("local recognition adapter", () => {
  it("writes private 16 kHz audio and removes it after a successful UTF-8 transcription", async () => {
    let file = "";
    const output = Buffer.from("  Hello 한국어  \n");
    const run: typeof runEngine = vi.fn(async (request) => {
      expect(request.file).toBe(whisper.binary);
      expect(request.args.slice(0, 2)).toEqual(["-m", whisper.model]);
      file = request.args[3]!;
      expect(request.args.slice(4)).toEqual(["-l", "auto", "-t", "2", "-ng", "-np", "-nt"]);
      expect(request.input.length).toBe(0);
      expect(request.maxOutputBytes).toBe(64000);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      expect(decodeWav(await readFile(file))).toEqual(audio);
      return output;
    });
    expect(await new WhisperRecognition(whisper, run).transcribe(audio, signal())).toBe("Hello 한국어");
    expect(output.every((byte) => byte === 0)).toBe(true);
    expect(audio.samples[0]).toBe(1);
    await expect(access(file)).rejects.toThrow();
  });

  it("supports operator-selected language, threads and a private temporary directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "speech-test-"));
    const run: typeof runEngine = vi.fn(async (request) => {
      expect(request.args[3]).toContain(directory);
      expect(request.args.slice(4, 8)).toEqual(["-l", "ko", "-t", "1"]);
      expect(decodeWav(await readFile(request.args[3]!)).sampleRate).toBe(16_000);
      return Buffer.alloc(0);
    });
    try {
      expect(await new WhisperRecognition({ ...whisper, temporaryDir: directory, language: "ko", threads: 1 }, run)
        .transcribe({ ...audio, sampleRate: 48_000 }, signal())).toBe("");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    { binary: "relative" }, { model: "/bad\0model" }, { model: "/" + "x".repeat(4096) },
    { temporaryDir: "relative" }, { language: "fr" }, { threads: 0 }, { threads: 9 }, { extra: true },
  ])("rejects invalid operator configuration %j", (override) => {
    expect(() => new WhisperRecognition({ ...whisper, ...override } as typeof whisper)).toThrow();
  });

  it("does not start a cancelled operation or accept malformed PCM", async () => {
    const run = vi.fn();
    const adapter = new WhisperRecognition(whisper, run);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(adapter.transcribe(audio, controller.signal)).rejects.toThrow("cancelled");
    await expect(adapter.transcribe({ ...audio, samples: new Int16Array() }, signal())).rejects.toThrow("Invalid PCM audio");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([Buffer.from([0xff]), Buffer.from("x".repeat(16001))])("rejects malformed or excessive engine text", async (output) => {
    let file = "";
    const run: typeof runEngine = async (request) => { file = request.args[3]!; return output; };
    await expect(new WhisperRecognition(whisper, run).transcribe(audio, signal())).rejects.toThrow("engine-failed");
    expect(output.every((byte) => byte === 0)).toBe(true);
    await expect(access(file)).rejects.toThrow();
  });

  it.each([new Error("private path"), new SpeechEngineError("engine-output-limit")])("removes temporary audio on engine failure", async (error) => {
    let file = "";
    const run: typeof runEngine = async (request) => { file = request.args[3]!; throw error; };
    await expect(new WhisperRecognition(whisper, run).transcribe(audio, signal())).rejects.toThrow(error instanceof SpeechEngineError ? "engine-output-limit" : "engine-failed");
    await expect(access(file)).rejects.toThrow();
  });

  it("fails safely when its temporary directory is unavailable", async () => {
    const run = vi.fn();
    await expect(new WhisperRecognition({ ...whisper, temporaryDir: "/does-not-exist/speech" }, run).transcribe(audio, signal())).rejects.toThrow("engine-failed");
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the actual process runner by default and removes audio after a missing binary", async () => {
    await expect(new WhisperRecognition({ ...whisper, binary: "/does-not-exist/whisper" }).transcribe(audio, signal())).rejects.toThrow("engine-failed");
  });

  it("discards a late result after cancellation and cleans its file", async () => {
    const controller = new AbortController();
    const output = Buffer.from("late transcript");
    let file = "";
    const run: typeof runEngine = async (request) => {
      file = request.args[3]!;
      controller.abort(new Error("cancelled"));
      return output;
    };
    await expect(new WhisperRecognition(whisper, run).transcribe(audio, controller.signal)).rejects.toThrow("cancelled");
    expect(output.every((byte) => byte === 0)).toBe(true);
    await expect(access(file)).rejects.toThrow();
  });
});

describe("local synthesis adapter", () => {
  it.each(["Hello world", "안녕하세요", "English와 한국어", "가", "ㄱ"])("selects a local voice and preserves literal text: %s", async (text) => {
    const output = encodeWav({ ...audio, sampleRate: 22_050 });
    output.writeUInt32LE(0x7ffff024, 4);
    output.writeUInt32LE(0x7ffff000, 40);
    let input: Buffer | undefined;
    const run: typeof runEngine = async (request) => {
      input = request.input;
      expect(input.toString()).toBe(text);
      expect(request.args).toEqual(["--stdin", "--stdout", "-b", "1", "-v", text === "Hello world" ? "en" : "ko", "-s", "175"]);
      expect(request.maxOutputBytes).toBe(441044);
      return output;
    };
    const result = await new EspeakSynthesis(espeak, run).synthesize(`  ${text}  `, signal());
    expect(result).toEqual({ ...audio, sampleRate: 22_050 });
    expect(output.every((byte) => byte === 0)).toBe(true);
    expect(input!.every((byte) => byte === 0)).toBe(true);
  });

  it("allows an operator to override automatic voice selection and speaking speed", async () => {
    const run: typeof runEngine = async (request) => {
      expect(request.args.slice(4)).toEqual(["-v", "en", "-s", "200"]);
      expect(request.input.toString()).toBe("$(touch /tmp/never-execute) `literal` <speak>Hello</speak>");
      return encodeWav(audio);
    };
    await new EspeakSynthesis({ ...espeak, language: "en", wordsPerMinute: 200 }, run).synthesize("$(touch /tmp/never-execute) `literal` <speak>Hello</speak>", signal());
  });

  it.each([{ binary: "relative" }, { language: "de" }, { wordsPerMinute: 79 }, { wordsPerMinute: 301 }, { extra: true }])("rejects invalid synthesis configuration %j", (override) => {
    expect(() => new EspeakSynthesis({ ...espeak, ...override } as typeof espeak)).toThrow();
  });

  it.each(["", " ", "x".repeat(16001), "Hello\0world"])("rejects empty, excessive or nul-containing text", async (text) => {
    const run = vi.fn();
    await expect(new EspeakSynthesis(espeak, run).synthesize(text, signal())).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not start a cancelled synthesis", async () => {
    const run = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(new EspeakSynthesis(espeak, run).synthesize("Hello", controller.signal)).rejects.toThrow("cancelled");
    expect(run).not.toHaveBeenCalled();
  });

  it("wipes invalid engine output and redacts diagnostics", async () => {
    const output = Buffer.from("private engine failure");
    await expect(new EspeakSynthesis(espeak, async () => output).synthesize("Hello", signal())).rejects.toThrow("engine-failed");
    expect(output.every((byte) => byte === 0)).toBe(true);
  });

  it.each([new Error("private detail"), new SpeechEngineError("engine-output-limit")])("wipes text and exposes only engine failure codes", async (error) => {
    let input: Buffer | undefined;
    const run: typeof runEngine = async (request) => { input = request.input; throw error; };
    await expect(new EspeakSynthesis(espeak, run).synthesize("private text", signal())).rejects.toThrow(error instanceof SpeechEngineError ? "engine-output-limit" : "engine-failed");
    expect(input!.every((byte) => byte === 0)).toBe(true);
  });

  it("uses the real runner by default", async () => {
    await expect(new EspeakSynthesis({ binary: "/does-not-exist/espeak" }).synthesize("Hello", signal())).rejects.toThrow("engine-failed");
  });

  it("discards output after cancellation", async () => {
    const controller = new AbortController();
    const output = encodeWav(audio);
    const run: typeof runEngine = async () => { controller.abort(new Error("cancelled")); return output; };
    await expect(new EspeakSynthesis(espeak, run).synthesize("Hello", controller.signal)).rejects.toThrow("cancelled");
    expect(output.every((byte) => byte === 0)).toBe(true);
  });
});
