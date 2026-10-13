import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSpeechWorker } from "../../packages/speech-worker/src/index.js";

afterEach(() => { vi.unstubAllEnvs(); });

async function fixture(override = {}, secret = "ab".repeat(32)) {
  const directory = await mkdtemp(path.join(tmpdir(), "speech-app-test-"));
  const configFile = path.join(directory, "config.json");
  const secretFile = path.join(directory, "secret");
  const model = path.join(directory, "model.bin");
  const config = { secretFile, port: 0, whisper: { binary: process.execPath, model: { file: model, bytes: 4, sha256: createHash("sha256").update("test").digest("hex") } }, espeak: { binary: process.execPath }, ...override };
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
  await writeFile(model, "test");
  return { directory, model, env: { MATRIX_CALL_SPEECH_CONFIG: configFile }, clean: () => rm(directory, { recursive: true, force: true }) };
}

describe("local speech worker lifecycle", () => {
  it("verifies the model, loads its dedicated secret, starts and closes idempotently", async () => {
    const files = await fixture();
    const worker = await startSpeechWorker(files.env);
    try {
      const response = await fetch(`http://127.0.0.1:${(worker.server.address() as AddressInfo).port}/healthz`);
      expect(await response.json()).toMatchObject({ ready: false, audience: worker.audience });
      const first = worker.close();
      expect(worker.close()).toBe(first);
      await first;
      expect(worker.server.listening).toBe(false);
    } finally { await worker.close(); await files.clean(); }
  });

  it.each(["SIGINT", "SIGTERM"] as const)("releases sockets and handlers on %s", async (signal) => {
    const files = await fixture();
    const previous = process.listenerCount(signal);
    const worker = await startSpeechWorker(files.env);
    try {
      process.emit(signal);
      await worker.close();
      expect(worker.server.listening).toBe(false);
      expect(process.listenerCount(signal)).toBe(previous);
    } finally { await worker.close(); await files.clean(); }
  });

  it("starts through the actual entry module and logs no model paths or secrets", async () => {
    const files = await fixture();
    vi.stubEnv("MATRIX_CALL_SPEECH_CONFIG", files.env.MATRIX_CALL_SPEECH_CONFIG);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { worker } = await import("../../packages/speech-worker/src/main.js");
    try {
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ event: "speech-worker-started", ready: false, recognition: true, synthesis: true, port: (worker.server.address() as AddressInfo).port });
      expect(JSON.stringify(log.mock.calls)).not.toContain("ab".repeat(32));
      expect(JSON.stringify(log.mock.calls)).not.toContain(files.directory);
    } finally { await worker.close(); await files.clean(); }
  });

  it("fails before listening or installing signal handlers for an altered model", async () => {
    const files = await fixture();
    const handlers = process.listenerCount("SIGTERM");
    await writeFile(files.model, "evil");
    try {
      await expect(startSpeechWorker(files.env)).rejects.toThrow("Invalid speech model");
      expect(process.listenerCount("SIGTERM")).toBe(handlers);
    } finally { await files.clean(); }
  });

  it.each(["/does-not-exist/engine", tmpdir()])("rejects unavailable or non-file executables %s", async (binary) => {
    const files = await fixture({ espeak: { binary } });
    try { await expect(startSpeechWorker(files.env)).rejects.toThrow("Speech engines unavailable"); }
    finally { await files.clean(); }
  });

  it("rejects a malformed secret before listening", async () => {
    const files = await fixture({}, "invalid");
    try { await expect(startSpeechWorker(files.env)).rejects.toThrow("invalid-auth"); }
    finally { await files.clean(); }
  });

  it("propagates a bind failure without leaving signal handlers", async () => {
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const files = await fixture({ port: (occupied.address() as AddressInfo).port });
    const handlers = process.listenerCount("SIGTERM");
    try {
      await expect(startSpeechWorker(files.env)).rejects.toThrow("EADDRINUSE");
      expect(process.listenerCount("SIGTERM")).toBe(handlers);
    } finally { await new Promise<void>((resolve) => { occupied.close(() => resolve()); }); await files.clean(); }
  });
});
