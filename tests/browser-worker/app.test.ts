import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBrowserWorker } from "../../packages/browser-worker/src/app.js";
import { configuration, credentials } from "../fixtures/browser.js";

const { start } = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../../packages/browser-worker/src/driver.js", () => ({ BrowserDriver: { start } }));
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "matrix-call-browser-app-"));
  const secret = path.join(dir, "secret");
  const config = path.join(dir, "config.json");
  const identity = path.join(dir, "matrix.json");
  await writeFile(secret, "ab".repeat(32), { mode: 0o600 });
  await writeFile(identity, JSON.stringify(credentials), { mode: 0o600 });
  await writeFile(config, JSON.stringify({ ...configuration, credentialsFile: identity }));
  const driver = { available: true, connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), close: vi.fn(async () => {}), onEnded: vi.fn((_listener: () => Promise<void>) => {}) };
  start.mockReset().mockResolvedValue(driver);
  return { dir, secret, driver, env: { MATRIX_CALL_SECRET_FILE: secret, MATRIX_CALL_PORT: "0", MATRIX_CALL_BROWSER_CONFIG: config }, clean: () => rm(dir, { recursive: true, force: true }) };
}

describe("browser worker application", () => {
  it("serves the portable control plane and releases an idle browser on shutdown", async () => {
    const f = await fixture(); const worker = await startBrowserWorker(f.env);
    try {
      const port = (worker.server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await response.json()).toMatchObject({ ready: false, transports: ["media-control"] });
      expect(worker.driver).toBe(f.driver);
      await worker.close(); await worker.close();
      expect(f.driver.close).toHaveBeenCalledOnce();
    } finally { await worker.close(); await f.clean(); }
  });

  it("ends failed calls without restoring authority and disables a failed driver", async () => {
    const f = await fixture(); const worker = await startBrowserWorker(f.env);
    try {
      const notify = f.driver.onEnded.mock.calls[0]![0];
      await notify();
      await worker.media.join({ roomId: "!room" }, new AbortController().signal);
      await notify();
      expect(worker.media.status().session).toBeNull(); expect(worker.media.status().available).toBe(true);
      f.driver.available = false;
      await notify();
      expect(worker.media.status().available).toBe(false);
    } finally { await worker.close(); await f.clean(); }
  });

  it("cancels a pending media session and still closes the browser after transport failure", async () => {
    const f = await fixture(); const worker = await startBrowserWorker(f.env);
    try {
      const pending = worker.media.join({ roomId: "!room" }, new AbortController().signal).catch((error: Error) => error);
      await worker.media.endSession();
      expect(await pending).toBeInstanceOf(Error);
      await worker.media.join({ roomId: "!room" }, new AbortController().signal);
      f.driver.disconnect.mockRejectedValue(new Error("cleanup failed"));
      await expect(worker.close()).rejects.toThrow("backend-failed");
      expect(f.driver.close).toHaveBeenCalledOnce();
    } finally { await worker.close().catch(() => {}); await f.clean(); }
  });

  it("validates control authentication before starting a Matrix client", async () => {
    const f = await fixture();
    try {
      await writeFile(f.secret, "invalid-control-key");
      await expect(startBrowserWorker(f.env)).rejects.toThrow("invalid-auth");
      expect(start).not.toHaveBeenCalled();
      await writeFile(f.secret, "ab".repeat(32));
      await expect(startBrowserWorker({ MATRIX_CALL_SECRET_FILE: f.secret })).rejects.toThrow("must be absolute");
    } finally { await f.clean(); }
  });

  it("releases a started browser when the control port is occupied", async () => {
    const f = await fixture(); const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      await expect(startBrowserWorker({ ...f.env, MATRIX_CALL_PORT: String((server.address() as { port: number }).port) })).rejects.toThrow("EADDRINUSE");
      expect(f.driver.close).toHaveBeenCalledOnce();
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.clean(); }
  });

  it("starts through the actual process entry and logs only public service state", async () => {
    const f = await fixture();
    for (const [name, value] of Object.entries(f.env)) vi.stubEnv(name, value);
    vi.stubEnv("MATRIX_CALL_HOST", undefined);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { worker } = await import("../../packages/browser-worker/src/main.js");
    try {
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ event: "browser-worker-started", ready: false, port: (worker.server.address() as { port: number }).port });
      expect(JSON.stringify(log.mock.calls)).not.toContain(credentials.accessToken);
    } finally { await worker.close(); await f.clean(); }
  });
});
