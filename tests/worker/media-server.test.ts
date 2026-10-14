import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { RequestAuthenticator } from "../../packages/core/src/index.js";
import { createWorkerServer, startWorker, WorkerMediaController } from "../../packages/worker/src/index.js";

const secret = "cd".repeat(32);

async function fixture(enabled = true) {
  const transport = { connect: vi.fn(async (_room: string, _signal: AbortSignal) => {}), disconnect: vi.fn(async () => {}) };
  const media = new WorkerMediaController({ rooms: ["!room"], transport });
  const { server, audience } = createWorkerServer(secret, enabled ? media : undefined);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = new RequestAuthenticator({ secret, audience });
  const request = async (pathname: string, value: unknown) => {
    const body = JSON.stringify(value);
    const response = await fetch(`${base}${pathname}`, { method: "POST", body, headers: auth.sign({ method: "POST", path: pathname, body }) });
    const text = await response.text();
    auth.verify({ method: `RESPONSE_${response.status}`, path: pathname, body: text }, Object.fromEntries(response.headers));
    return { status: response.status, value: JSON.parse(text) };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await media.shutdown();
  };
  return { transport, media, server, base, auth, request, close };
}

describe("authenticated media control", () => {
  it("joins, reports, and leaves a media session without claiming agent readiness", async () => {
    const worker = await fixture();
    try {
      const health = await (await fetch(`${worker.base}/healthz`)).json();
      expect(health).toMatchObject({ transports: ["media-control"] });
      expect((await fetch(`${worker.base}/readyz`)).status).toBe(503);
      expect(await worker.request("/v1/media/status", {})).toEqual({ status: 200, value: { available: true, session: null } });
      const joined = await worker.request("/v1/media/join", { roomId: "!room" });
      expect(joined.status).toBe(200);
      expect((await worker.request("/v1/media/status", {})).value.session).toEqual(joined.value);
      expect(worker.transport.connect.mock.calls[0]![1].aborted).toBe(false);
      expect(await worker.request("/v1/calls", {})).toEqual({ status: 501, value: { error: "transport-unavailable" } });
      expect(await worker.request("/v1/media/leave", { sessionId: joined.value.sessionId })).toEqual({ status: 200, value: { closed: true } });
      expect(worker.transport.disconnect).toHaveBeenCalledOnce();
    } finally { await worker.close(); }
  });

  it("reports unavailable media only after authenticating the request", async () => {
    const worker = await fixture(false);
    try {
      expect((await fetch(`${worker.base}/v1/media/join`, { method: "POST", body: "{}" })).status).toBe(401);
      expect(await worker.request("/v1/media/join", { roomId: "!room" })).toEqual({ status: 501, value: { error: "transport-unavailable" } });
    } finally { await worker.close(); }
  });

  it.each([
    ["/v1/media/status", { owner: true }, 400, "invalid-request"],
    ["/v1/media/status", null, 400, "invalid-request"],
    ["/v1/media/join", { roomId: "!room", owner: true }, 400, "invalid-request"],
    ["/v1/media/join", { roomId: "!other" }, 403, "forbidden-room"],
    ["/v1/media/leave", { sessionId: crypto.randomUUID() }, 404, "not-found"],
  ] as const)("signs rejected media requests: %s", async (pathname, value, status, error) => {
    const worker = await fixture();
    try { expect(await worker.request(pathname, value)).toEqual({ status, value: { error } }); }
    finally { await worker.close(); }
  });

  it("rejects malformed authenticated JSON", async () => {
    const worker = await fixture();
    try {
      const pathname = "/v1/media/join";
      const body = "{";
      const response = await fetch(`${worker.base}${pathname}`, { method: "POST", body, headers: worker.auth.sign({ method: "POST", path: pathname, body }) });
      const reply = await response.text();
      expect(response.status).toBe(400);
      worker.auth.verify({ method: "RESPONSE_400", path: pathname, body: reply }, Object.fromEntries(response.headers));
      expect(JSON.parse(reply)).toEqual({ error: "invalid-request" });
    } finally { await worker.close(); }
  });

  it("rejects replay and binds authentication to the exact media path", async () => {
    const worker = await fixture();
    try {
      const body = "{}";
      const headers = worker.auth.sign({ method: "POST", path: "/v1/media/status", body });
      expect((await fetch(`${worker.base}/v1/media/status`, { method: "POST", body, headers })).status).toBe(200);
      expect((await fetch(`${worker.base}/v1/media/status`, { method: "POST", body, headers })).status).toBe(401);
      expect((await fetch(`${worker.base}/v1/media/join`, { method: "POST", body, headers })).status).toBe(401);
    } finally { await worker.close(); }
  });

  it("returns signed redacted backend and capacity failures", async () => {
    const worker = await fixture();
    try {
      worker.transport.connect.mockRejectedValueOnce(new Error("private backend credential"));
      expect(await worker.request("/v1/media/join", { roomId: "!room" })).toEqual({ status: 503, value: { error: "backend-failed" } });
      await vi.waitFor(() => expect(worker.media.status().session).toBeNull());
      await worker.request("/v1/media/join", { roomId: "!room" });
      expect(await worker.request("/v1/media/join", { roomId: "!room" })).toEqual({ status: 409, value: { error: "busy" } });
      await worker.media.shutdown();
      expect(await worker.request("/v1/media/join", { roomId: "!room" })).toEqual({ status: 409, value: { error: "closed" } });
    } finally { await worker.close(); }
  });

  it("cancels a connecting transport when its HTTP client disconnects", async () => {
    const worker = await fixture();
    const requestAbort = new AbortController();
    worker.transport.connect.mockImplementation((_room, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })));
    try {
      const body = JSON.stringify({ roomId: "!room" });
      const pending = fetch(`${worker.base}/v1/media/join`, { method: "POST", body, signal: requestAbort.signal, headers: worker.auth.sign({ method: "POST", path: "/v1/media/join", body }) });
      await vi.waitFor(() => expect(worker.transport.connect).toHaveBeenCalledOnce());
      requestAbort.abort();
      await expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(worker.transport.disconnect).toHaveBeenCalledOnce());
      expect(worker.media.status().session).toBeNull();
    } finally { await worker.close(); }
  });

  it("closes an injected media transport when the worker process closes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-media-worker-"));
    const file = path.join(directory, "secret");
    await writeFile(file, secret, { mode: 0o600 });
    const transport = { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
    const media = new WorkerMediaController({ rooms: ["!room"], transport });
    const worker = await startWorker({ MATRIX_CALL_SECRET_FILE: file, MATRIX_CALL_PORT: "0" }, media);
    try {
      await media.join({ roomId: "!room" }, new AbortController().signal);
      await worker.close();
      expect(transport.disconnect).toHaveBeenCalledOnce();
      expect(media.status().available).toBe(false);
    } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
