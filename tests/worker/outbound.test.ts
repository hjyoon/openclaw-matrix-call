import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RequestAuthenticator } from "../../packages/core/src/index.js";
import { createWorkerServer, WorkerHttpClient, WorkerMediaController } from "../../packages/worker/src/index.js";

const secret = "ab".repeat(32);
const input = { roomId: "!room", recipientId: "@owner:example.org", message: "Good morning.", ringTimeoutMs: 1000 };
const signal = () => new AbortController().signal;

function fixture() {
  const transport = { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), dial: vi.fn(async (_request: unknown, _signal: AbortSignal) => {}) };
  const media = new WorkerMediaController({ rooms: [input.roomId], recipients: [input.recipientId], transport });
  return { transport, media };
}

describe("owned outbound calls", () => {
  it.each([["invalid"], Array(257).fill(input.recipientId)])("rejects invalid recipient configuration", (recipients) => {
    const { transport } = fixture();
    expect(() => new WorkerMediaController({ rooms: [input.roomId], transport, recipients })).toThrow("invalid-request");
  });

  it.each([null, {}, { ...input, owner: true }, { ...input, message: " " }, { ...input, recipientId: "owner" }, { ...input, ringTimeoutMs: 999 }, { ...input, ringTimeoutMs: 60001 }])("rejects malformed outbound requests before effects", async (value) => {
    const { media, transport } = fixture();
    await expect(media.dial(value, signal())).rejects.toThrow("invalid-request");
    expect(transport.dial).not.toHaveBeenCalled();
  });

  it.each(["transport", "recipients"])("requires explicit outbound %s support", async (missing) => {
    const { transport } = fixture();
    const media = new WorkerMediaController({ rooms: [input.roomId], transport: missing === "transport" ? { connect: transport.connect, disconnect: transport.disconnect } : transport, recipients: missing === "recipients" ? [] : [input.recipientId] });
    expect(media.canDial).toBe(false);
    await expect(media.dial(input, signal())).rejects.toThrow("transport-unavailable");
    expect(transport.dial).not.toHaveBeenCalled();
  });

  it("enforces both recipient and room before admission", async () => {
    const { media, transport } = fixture();
    await expect(media.dial({ ...input, recipientId: "@other:example.org" }, signal())).rejects.toThrow("forbidden-recipient");
    await expect(media.dial({ ...input, roomId: "!other" }, signal())).rejects.toThrow("forbidden-room");
    expect(transport.dial).not.toHaveBeenCalled();
  });

  it("authenticates dialing, holds the shared call slot and closes the exact completed session", async () => {
    const { media, transport } = fixture();
    let accept!: () => void;
    transport.dial.mockImplementation(() => new Promise<void>((resolve) => { accept = resolve; }));
    const { server } = createWorkerServer(secret, media);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const client = await WorkerHttpClient.connect({ baseUrl, secret, allowInsecureLoopback: true });
      expect(client.outboundCalls).toBe(true);
      expect((await fetch(baseUrl + "/v1/media/dial", { method: "POST", body: JSON.stringify(input) })).status).toBe(401);
      const id = crypto.randomUUID();
      const pending = client.dial({ ...input, message: "  Good morning.  " }, signal(), id.toUpperCase());
      await vi.waitFor(() => expect(transport.dial).toHaveBeenCalledOnce());
      expect((await client.status(signal())).session).toEqual({ sessionId: id, roomId: input.roomId, state: "ringing" });
      expect(transport.dial.mock.calls[0]![0]).toMatchObject({ message: "Good morning.", recipientId: input.recipientId });
      await expect(client.join(input.roomId, signal())).rejects.toThrow("busy");
      await expect(client.dial({ ...input, recipientId: "@other:example.org" }, signal())).rejects.toThrow("forbidden-recipient");
      accept();
      expect(await pending).toEqual({ sessionId: id, roomId: input.roomId, state: "connected" });
      expect(transport.connect).not.toHaveBeenCalled();
      await expect(client.leave(crypto.randomUUID(), signal())).rejects.toThrow("not-found");
      await client.leave(id, signal());
      expect((await client.status(signal())).session).toBeNull();
      await expect(client.dial(input, signal(), id)).rejects.toThrow("session-reused");
    } finally { accept?.(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await media.shutdown(); }
  });

  it("does not send a dial request to a worker without that capability", async () => {
    const { transport } = fixture();
    const media = new WorkerMediaController({ rooms: [input.roomId], transport });
    const { server } = createWorkerServer(secret, media);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const client = await WorkerHttpClient.connect({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, secret, allowInsecureLoopback: true });
      await expect(client.dial(input, signal())).rejects.toThrow("transport-unavailable");
      expect(transport.dial).not.toHaveBeenCalled();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await media.shutdown(); }
  });

  it.each(["room", "session"])("rejects a signed dial response rebound to another %s", async (mismatch) => {
    const audience = crypto.randomUUID();
    const auth = new RequestAuthenticator({ secret, audience });
    const fetcher: typeof fetch = async (url, options) => {
      const path = new URL(String(url)).pathname;
      const request = options?.method === "POST" ? JSON.parse(String(options.body)) : undefined;
      const value = request ? { sessionId: mismatch === "session" ? crypto.randomUUID() : request.sessionId, roomId: mismatch === "room" ? "!other" : request.roomId, state: "connected" }
        : { protocolVersion: 1, audience, mediaControl: true, clientSessionIds: true, outboundCalls: true };
      const body = JSON.stringify(value);
      return new Response(body, { headers: auth.sign({ method: "RESPONSE_200", path, body }) });
    };
    const client = await WorkerHttpClient.connect({ baseUrl: "https://worker.example.org", secret, fetch: fetcher });
    await expect(client.dial(input, signal())).rejects.toThrow("invalid-response");
  });

  it("bounds ringing and cleans cancellation before another call is admitted", async () => {
    vi.useFakeTimers();
    const { transport } = fixture();
    let ended = false;
    transport.dial.mockImplementation(async (_request, abort) => { await new Promise<void>((resolve) => abort.addEventListener("abort", () => { ended = true; resolve(); }, { once: true })); });
    const media = new WorkerMediaController({ rooms: [input.roomId], recipients: [input.recipientId], transport, timeoutMs: 1 });
    try {
      const pending = expect(media.dial(input, signal())).rejects.toThrow("closed");
      await vi.advanceTimersByTimeAsync(1001); await pending;
      expect(ended).toBe(true); expect(transport.disconnect).toHaveBeenCalledOnce();
      expect(media.status().session).toBeNull();
    } finally { await media.shutdown(); vi.useRealTimers(); }
  });
});
