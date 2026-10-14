import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RequestAuthenticator } from "../../packages/core/src/index.js";
import { createWorkerServer, WorkerMediaController, WorkerHttpClient } from "../../packages/worker/src/index.js";

const secret = "ab".repeat(32);
const audience = "03ade3af-6c83-4b45-b401-acab7432111a";
const baseUrl = "https://worker.example.org/";
const capabilities = { protocolVersion: 1, audience, mediaControl: true, clientSessionIds: true };
const signal = () => new AbortController().signal;

function fixture() {
  const auth = new RequestAuthenticator({ secret, audience });
  const signed = (value: unknown, path: string, status = 200) => {
    const body = typeof value === "string" ? value : JSON.stringify(value);
    return new Response(body, { status, headers: auth.sign({ method: `RESPONSE_${status}`, path, body }) });
  };
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (options!.method !== "POST") return signed(capabilities, path);
    auth.verify({ method: "POST", path, body: options!.body as string }, options!.headers as Record<string, string>);
    const request = JSON.parse(options!.body as string);
    if (path.endsWith("join")) return signed({ ...request, state: "connected" }, path);
    return signed(path.endsWith("status") ? { available: true, session: null } : { closed: true }, path);
  });
  const connect = (options = {}) => WorkerHttpClient.connect({ baseUrl, secret, fetch: fetcher, ...options });
  return { auth, signed, fetcher, connect };
}

describe("signed portable worker client", () => {
  it("supports a path namespace without dropping the configured prefix", async () => {
    const test = fixture(); await test.connect({ baseUrl: "https://worker.example.org/control" });
    expect(String(test.fetcher.mock.calls[0]![0])).toBe("https://worker.example.org/control/v1/media/capabilities");
  });

  it("redacts stream errors and handles failed cleanup of an errored stream", async () => {
    const test = fixture();
    test.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error("private stream failure")); } })));
    await expect(test.connect()).rejects.toThrow("invalid-response");
  });

  it("negotiates authenticated capabilities and signs strict status/join/leave operations", async () => {
    const test = fixture(); const client = await test.connect();
    expect(await client.status(signal())).toEqual({ available: true, session: null });
    const id = randomUUID(); const joined = await client.join("!room", signal(), id.toUpperCase());
    expect(joined).toEqual({ roomId: "!room", sessionId: id, state: "connected" });
    expect(Object.isFrozen(joined)).toBe(true);
    await client.leave(id.toUpperCase(), signal());
    expect(String(test.fetcher.mock.calls[0]![0])).toBe(baseUrl + "v1/media/capabilities");
    expect(test.fetcher.mock.calls.every(([, options]) => options!.redirect === "error")).toBe(true);
    expect(JSON.stringify(test.fetcher.mock.calls)).not.toContain(secret);
    expect((await client.join("!room", signal())).sessionId).not.toBe(id);
  });

  it.each(["invalid", "ftp://localhost", "http://127.0.0.1", "http://worker.example.org", "https://u:p@example.org", "https://example.org?key=secret", "https://example.org#fragment"])("rejects unsafe or implicit endpoints %s", async (url) => {
    const test = fixture(); await expect(test.connect({ baseUrl: url })).rejects.toThrow("invalid-config"); expect(test.fetcher).not.toHaveBeenCalled();
  });
  it.each([0, 300001, 1.5, NaN])("rejects invalid deadlines %s", async (timeoutMs) => {
    const test = fixture(); await expect(test.connect({ timeoutMs })).rejects.toThrow("invalid-config"); expect(test.fetcher).not.toHaveBeenCalled();
  });
  it.each(["http://127.0.0.1", "http://localhost", "http://[::1]"])("allows explicitly selected loopback HTTP %s", async (baseUrl) => {
    await fixture().connect({ baseUrl, allowInsecureLoopback: true });
  });
  it("keeps the plaintext exception local and validates keys before network I/O", async () => {
    const test = fixture();
    await expect(test.connect({ baseUrl: "http://private.example.org", allowInsecureLoopback: true })).rejects.toThrow("invalid-config");
    await expect(test.connect({ secret: "bad" })).rejects.toThrow("invalid-auth"); expect(test.fetcher).not.toHaveBeenCalled();
  });
  it.each(["{", { ...capabilities, protocolVersion: 2 }, { ...capabilities, clientSessionIds: false }])("rejects malformed signed capabilities %#", async (value) => {
    const test = fixture(); test.fetcher.mockResolvedValueOnce(test.signed(value, "/v1/media/capabilities")); await expect(test.connect()).rejects.toThrow("invalid-response");
  });
  it("requires authenticated available media and signed results", async () => {
    const test = fixture();
    test.fetcher.mockResolvedValueOnce(test.signed({ ...capabilities, mediaControl: false }, "/v1/media/capabilities")); await expect(test.connect()).rejects.toThrow("transport-unavailable");
    test.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(capabilities))); await expect(test.connect()).rejects.toThrow("invalid-auth");
    test.fetcher.mockResolvedValueOnce(new Response("private error", { status: 503 })); await expect(test.connect()).rejects.toThrow("http-error");
  });
  it("bounds capability bytes and decodes strict UTF-8", async () => {
    const test = fixture();
    test.fetcher.mockResolvedValueOnce(new Response(null)); await expect(test.connect()).rejects.toThrow("invalid-response");
    test.fetcher.mockResolvedValueOnce(new Response(new Uint8Array([0xff]))); await expect(test.connect()).rejects.toThrow("invalid-response");
    const cancel = vi.fn();
    test.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4000)); controller.enqueue(new Uint8Array(97)); }, cancel })));
    await expect(test.connect()).rejects.toThrow("response-too-large"); expect(cancel).toHaveBeenCalledOnce();
  });
  it("propagates connection cancellation before dispatch", async () => {
    const test = fixture(); await test.connect({ signal: signal() });
    await expect(test.connect({ signal: AbortSignal.abort(new Error("closed")) })).rejects.toThrow("closed"); expect(test.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["status", "join", "leave"] as const)("does not dispatch aborted %s operations", async (method) => {
    const test = fixture(); const client = await test.connect(); const aborted = AbortSignal.abort(new Error("closed"));
    await expect(method === "status" ? client.status(aborted) : method === "join" ? client.join("!room", aborted) : client.leave(randomUUID(), aborted)).rejects.toThrow("closed"); expect(test.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid mutation input before network dispatch", async () => {
    const test = fixture(); const client = await test.connect();
    await expect(client.join("not-room", signal())).rejects.toThrow(); await expect(client.leave("not-id", signal())).rejects.toThrow(); expect(test.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { available: true, session: { sessionId: audience, roomId: "!room", state: "connecting" } },
    { available: false, session: { sessionId: audience, roomId: "!room", state: "closing" } },
  ])("accepts immutable status snapshots %#", async (value) => {
    const test = fixture(); const client = await test.connect(); test.fetcher.mockResolvedValueOnce(test.signed(value, "/v1/media/status"));
    const status = await client.status(signal()); expect(status).toEqual(value); expect(Object.isFrozen(status.session)).toBe(true);
  });
  it.each(["busy", "not-found", "forbidden-room", "closed", "backend-failed", "session-reused", "capacity-exceeded"])("exposes fixed authenticated remote errors %s", async (error) => {
    const test = fixture(); const client = await test.connect(); test.fetcher.mockResolvedValueOnce(test.signed({ error }, "/v1/media/status", 503)); await expect(client.status(signal())).rejects.toThrow(error);
  });
  it("rejects unauthenticated or unrecognized errors without retries", async () => {
    const test = fixture(); const client = await test.connect();
    test.fetcher.mockResolvedValueOnce(new Response("private error", { status: 401 })); await expect(client.status(signal())).rejects.toThrow("http-error");
    test.fetcher.mockResolvedValueOnce(test.signed({ error: "private credential" }, "/v1/media/status", 500)); await expect(client.status(signal())).rejects.toThrow("invalid-response");
    test.fetcher.mockResolvedValueOnce(test.signed("{", "/v1/media/status")); await expect(client.status(signal())).rejects.toThrow("invalid-response");
    test.fetcher.mockResolvedValueOnce(new Response("tampered", { headers: test.signed("original", "/v1/media/status").headers })); await expect(client.status(signal())).rejects.toThrow("invalid-auth"); expect(test.fetcher).toHaveBeenCalledTimes(5);
  });
  it("rejects mismatched room or session IDs in join results", async () => {
    const test = fixture(); const client = await test.connect(); const id = randomUUID();
    test.fetcher.mockResolvedValueOnce(test.signed({ sessionId: id, roomId: "!other", state: "connected" }, "/v1/media/join")); await expect(client.join("!room", signal(), id)).rejects.toThrow("invalid-response");
    test.fetcher.mockResolvedValueOnce(test.signed({ sessionId: audience, roomId: "!room", state: "connected" }, "/v1/media/join")); await expect(client.join("!room", signal(), id)).rejects.toThrow("invalid-response");
  });
  it("bounds results and rejects invalid operation envelopes", async () => {
    const test = fixture(); const client = await test.connect();
    test.fetcher.mockResolvedValueOnce(new Response("x".repeat(65537))); await expect(client.status(signal())).rejects.toThrow("response-too-large");
    test.fetcher.mockResolvedValueOnce(test.signed({ closed: false }, "/v1/media/leave")); await expect(client.leave(randomUUID(), signal())).rejects.toThrow();
    test.fetcher.mockResolvedValueOnce(test.signed({ state: "unknown" }, "/v1/media/status")); await expect(client.status(signal())).rejects.toThrow();
    test.fetcher.mockResolvedValueOnce(test.signed({ state: "connecting" }, "/v1/media/join")); await expect(client.join("!room", signal())).rejects.toThrow();
  });
  it("discards late headers and interrupts stalled bodies despite cancellation failure", async () => {
    const test = fixture(); const client = await test.connect(); const early = new AbortController();
    test.fetcher.mockImplementationOnce(async () => { early.abort(new Error("closed")); return new Response("{}"); }); await expect(client.status(early.signal)).rejects.toThrow("closed");
    const controller = new AbortController(); const cancel = vi.fn(async () => { throw new Error("private cancellation failure"); });
    test.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = client.status(controller.signal); const rejected = expect(pending).rejects.toThrow("closed"); await vi.waitFor(() => expect(test.fetcher).toHaveBeenCalledTimes(3)); controller.abort(new Error("closed")); await rejected; expect(cancel).toHaveBeenCalledOnce();
    const next = new AbortController(); test.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } })));
    const stalled = client.status(next.signal); const interrupted = expect(stalled).rejects.toThrow("closed"); await vi.waitFor(() => expect(test.fetcher).toHaveBeenCalledTimes(4)); next.abort(new Error("closed")); await interrupted;
  });
  it("covers the streamed body with the operation deadline", async () => {
    const test = fixture(); const client = await test.connect({ timeoutMs: 20 }); const cancel = vi.fn();
    test.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }))); await expect(client.status(signal())).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce();
  });
  it("controls a real HTTP worker with exact caller-selected session IDs", async () => {
    const transport = { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
    const media = new WorkerMediaController({ rooms: ["!room"], transport }); const { server } = createWorkerServer(secret, media);
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address() as { port: number };
    try {
      const client = await WorkerHttpClient.connect({ baseUrl: `http://127.0.0.1:${address.port}`, secret, allowInsecureLoopback: true }); const id = randomUUID();
      expect(await client.status(signal())).toEqual({ available: true, session: null }); expect(await client.join("!room", signal(), id)).toEqual({ sessionId: id, roomId: "!room", state: "connected" });
      await expect(client.join("!room", signal())).rejects.toThrow("busy"); await client.leave(id, signal()); await expect(client.join("!room", signal(), id)).rejects.toThrow("session-reused");
      expect(transport.connect).toHaveBeenCalledOnce(); expect(transport.disconnect).toHaveBeenCalledOnce();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => resolve()); }); await media.shutdown(); }
  });
});
