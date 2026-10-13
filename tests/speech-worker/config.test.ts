import { createHash } from "node:crypto";
import { mkdtemp, open, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSpeechConfig, verifySpeechModel } from "../../packages/speech-worker/src/index.js";

vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof import("node:fs/promises")>();
  return { ...module, open: vi.fn(module.open) };
});

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const minimal = {
  secretFile: "/run/secrets/speech", whisper: { binary: "/opt/whisper-cli", model: { file: "/models/model.bin", bytes: 4, sha256: hash("test") } },
  espeak: { binary: "/opt/espeak-ng" },
};

afterEach(() => { vi.unstubAllEnvs(); });

async function configFile(value: unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), "speech-config-test-"));
  const file = path.join(directory, "config.json");
  await writeFile(file, JSON.stringify(value));
  return { directory, file, clean: () => rm(directory, { recursive: true, force: true }) };
}

describe("local speech worker configuration", () => {
  it("loads current process configuration with bounded loopback defaults", async () => {
    const fixture = await configFile(minimal);
    vi.stubEnv("MATRIX_CALL_SPEECH_CONFIG", fixture.file);
    try {
      const config = await readSpeechConfig();
      expect(config).toEqual({ ...minimal, host: "127.0.0.1", port: 19792, temporaryDir: tmpdir(), timeoutMs: 30000,
        whisper: { ...minimal.whisper, language: "auto", threads: 2 }, espeak: { ...minimal.espeak, language: "auto", wordsPerMinute: 175 } });
      expect(Object.isFrozen(config)).toBe(true);
    } finally { await fixture.clean(); }
  });

  it("accepts explicit IPv6, private temporary storage and operator-selected settings", async () => {
    const value = { ...minimal, host: "::1", port: 0, temporaryDir: "/tmp/private", timeoutMs: 60000,
      whisper: { ...minimal.whisper, language: "ko", threads: 1 }, espeak: { ...minimal.espeak, language: "en", wordsPerMinute: 200 } };
    const fixture = await configFile(value);
    try { expect(await readSpeechConfig({ MATRIX_CALL_SPEECH_CONFIG: fixture.file })).toEqual(value); }
    finally { await fixture.clean(); }
  });

  it.each([
    { secretFile: "relative" }, { secretFile: "/bad\0file" }, { secretFile: "/" + "a".repeat(4096) },
    { host: "0.0.0.0" }, { host: "localhost" }, { port: -1 }, { port: 65536 }, { port: 0.1 },
    { temporaryDir: "relative" }, { timeoutMs: 0 }, { timeoutMs: 60001 }, { extra: true },
    { whisper: { ...minimal.whisper, language: "fr" } }, { whisper: { ...minimal.whisper, threads: 9 } },
    { whisper: { ...minimal.whisper, model: { ...minimal.whisper.model, bytes: 2147483648 } } },
    { whisper: { ...minimal.whisper, model: { ...minimal.whisper.model, sha256: "invalid" } } },
    { espeak: { ...minimal.espeak, wordsPerMinute: 301 } },
  ])("rejects invalid or additional settings %j", async (override) => {
    const fixture = await configFile({ ...minimal, ...override });
    try { await expect(readSpeechConfig({ MATRIX_CALL_SPEECH_CONFIG: fixture.file })).rejects.toThrow("Invalid speech worker configuration"); }
    finally { await fixture.clean(); }
  });

  it("redacts missing files, default-path failures and malformed JSON", async () => {
    await expect(readSpeechConfig({ MATRIX_CALL_SPEECH_CONFIG: "relative" })).rejects.toThrow("Invalid speech worker configuration");
    await expect(readSpeechConfig({ MATRIX_CALL_SPEECH_CONFIG: "/does-not-exist/private-config" })).rejects.toThrow("Invalid speech worker configuration");
    await expect(readSpeechConfig({})).rejects.toThrow("Invalid speech worker configuration");
    const fixture = await configFile(minimal);
    await writeFile(fixture.file, "{broken");
    try { await expect(readSpeechConfig({ MATRIX_CALL_SPEECH_CONFIG: fixture.file })).rejects.toThrow("Invalid speech worker configuration"); }
    finally { await fixture.clean(); }
  });
});

describe("operator-pinned speech model integrity", () => {
  it("verifies a regular file by exact size and streaming SHA-256", async () => {
    const fixture = await configFile(minimal);
    const file = path.join(fixture.directory, "model.bin");
    await writeFile(file, "test");
    try {
      await verifySpeechModel({ file, bytes: 4, sha256: hash("test") });
      await writeFile(file, "another model");
      await expect(verifySpeechModel({ file, bytes: 4, sha256: hash("test") })).rejects.toThrow("Invalid speech model");
    } finally { await fixture.clean(); }
  });

  it("rejects missing, symbolic-link and non-regular model files", async () => {
    const fixture = await configFile(minimal);
    const link = path.join(fixture.directory, "link");
    await symlink(fixture.file, link);
    try {
      for (const file of ["/does-not-exist/model", fixture.directory, link]) {
        await expect(verifySpeechModel({ file, bytes: 4, sha256: hash("test") })).rejects.toThrow("Invalid speech model");
      }
      await expect(verifySpeechModel({ file: "relative", bytes: 4, sha256: hash("test") })).rejects.toThrow("Invalid speech model");
    } finally { await fixture.clean(); }
  });

  it("rejects a same-size model with the wrong hash", async () => {
    const fixture = await configFile(minimal);
    const file = path.join(fixture.directory, "model.bin");
    await writeFile(file, "evil");
    try { await expect(verifySpeechModel({ file, bytes: 4, sha256: hash("test") })).rejects.toThrow("Invalid speech model"); }
    finally { await fixture.clean(); }
  });

  it.each(["grows", "shrinks", "read-fails", "close-fails"])("closes and rejects a model that %s during verification", async (mode) => {
    const close = vi.fn(async () => { if (mode === "close-fails") throw new Error("private path"); });
    const handle = {
      stat: async () => ({ isFile: () => true, size: 4 }),
      createReadStream: () => mode === "read-fails" ? new Readable({ read() { this.destroy(new Error("private path")); } }) :
        Readable.from([Buffer.from(mode === "grows" ? "growing" : mode === "shrinks" ? "a" : "test")]),
      close,
    };
    vi.mocked(open).mockResolvedValueOnce(handle as unknown as FileHandle);
    await expect(verifySpeechModel(minimal.whisper.model)).rejects.toThrow("Invalid speech model");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
