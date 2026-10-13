import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkerConfig, startWorker } from "../../packages/worker/src/index.js";

afterEach(() => vi.unstubAllEnvs());

async function fixture(secret = "ab".repeat(32)) {
  const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-worker-"));
  const secretFile = path.join(directory, "secret");
  await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
  return {
    env: { MATRIX_CALL_SECRET_FILE: secretFile, MATRIX_CALL_PORT: "0" },
    clean: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("worker configuration", () => {
  it("uses current process defaults with an explicit secret file", () => {
    vi.stubEnv("MATRIX_CALL_SECRET_FILE", "/run/secrets/matrix_call_secret");
    vi.stubEnv("MATRIX_CALL_HOST", undefined);
    vi.stubEnv("MATRIX_CALL_PORT", undefined);
    expect(readWorkerConfig()).toEqual({
      host: "127.0.0.1", port: 19790, secretFile: "/run/secrets/matrix_call_secret",
    });
  });

  it("accepts explicit IPv6 and ephemeral port configuration", () => {
    const config = readWorkerConfig({ MATRIX_CALL_HOST: "::1", MATRIX_CALL_PORT: "0", MATRIX_CALL_SECRET_FILE: "/tmp/secret" });
    expect(config.host).toBe("::1");
    expect(config.port).toBe(0);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    {}, { MATRIX_CALL_SECRET_FILE: "relative" },
    { MATRIX_CALL_SECRET_FILE: "/tmp/secret", MATRIX_CALL_HOST: "not-an-ip" },
    { MATRIX_CALL_SECRET_FILE: "/tmp/secret", MATRIX_CALL_PORT: "-1" },
    { MATRIX_CALL_SECRET_FILE: "/tmp/secret", MATRIX_CALL_PORT: "65536" },
    { MATRIX_CALL_SECRET_FILE: "/tmp/secret", MATRIX_CALL_PORT: "100000" },
  ])("rejects invalid configuration %#", (env) => {
    expect(() => readWorkerConfig(env)).toThrow("invalid-input");
  });
});

describe("worker process lifecycle", () => {
  it("loads a secret file, serves health, and closes idempotently", async () => {
    const files = await fixture();
    const worker = await startWorker(files.env);
    try {
      const address = worker.server.address() as { port: number };
      expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(200);
      const first = worker.close();
      expect(worker.close()).toBe(first);
      await first;
      expect(worker.server.listening).toBe(false);
    } finally { await worker.close(); await files.clean(); }
  });

  it("fails before listening when a dedicated secret is malformed", async () => {
    const files = await fixture("not-a-real-secret");
    try { await expect(startWorker(files.env)).rejects.toThrow("invalid-auth"); }
    finally { await files.clean(); }
  });

  it("propagates a bind failure without installing signal handlers", async () => {
    const files = await fixture();
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const address = occupied.address() as { port: number };
    const handlers = process.listenerCount("SIGTERM");
    try {
      await expect(startWorker({ ...files.env, MATRIX_CALL_PORT: String(address.port) }))
        .rejects.toThrow("EADDRINUSE");
      expect(process.listenerCount("SIGTERM")).toBe(handlers);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
      await files.clean();
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)("releases listeners and sockets after %s", async (signal) => {
    const files = await fixture();
    const handlers = process.listenerCount(signal);
    const worker = await startWorker(files.env);
    try {
      process.emit(signal);
      await worker.close();
      expect(worker.server.listening).toBe(false);
      expect(process.listenerCount(signal)).toBe(handlers);
    } finally { await worker.close(); await files.clean(); }
  });

  it("starts through the actual entry module without logging credentials", async () => {
    const files = await fixture();
    vi.stubEnv("MATRIX_CALL_SECRET_FILE", files.env.MATRIX_CALL_SECRET_FILE);
    vi.stubEnv("MATRIX_CALL_PORT", "0");
    vi.stubEnv("MATRIX_CALL_HOST", undefined);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { worker } = await import("../../packages/worker/src/main.js");
    try {
      expect(worker.server.listening).toBe(true);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
        event: "worker-started", ready: false, port: (worker.server.address() as { port: number }).port,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("ab".repeat(32));
    } finally { await worker.close(); await files.clean(); }
  });
});
