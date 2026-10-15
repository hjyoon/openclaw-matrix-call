import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RequestAuthenticator } from "../../packages/core/src/index.js";
import { createWorkerServer, MediaControlError, WorkerHttpClient, WorkerMediaController } from "../../packages/worker/src/index.js";

const secret = "ab".repeat(32);
const recipientId = "@visitor:example.org";
const signal = () => new AbortController().signal;
function fixture(selfCalls = true) {
  const transport = { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), dial: vi.fn(async (_input: unknown, _signal: AbortSignal) => {}), recipientRoom: vi.fn(async (_recipient: string, _preferred: string | undefined, _signal: AbortSignal) => "!private") };
  const media = new WorkerMediaController({ rooms: ["!configured"], recipients: ["@owner:example.org"], selfCalls, transport });
  return { media, transport };
}

describe("portable self-call control", () => {
  it("binds signed room discovery to its recipient and permits a private self-call beyond static owner rooms", async () => {
    const f = fixture(); const { server } = createWorkerServer(secret, f.media);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const client = await WorkerHttpClient.connect({ baseUrl, secret, allowInsecureLoopback: true });
      expect(client.selfCalls).toBe(true);
      expect((await fetch(baseUrl + "/v1/media/recipient-room", { method: "POST", body: JSON.stringify({ recipientId }) })).status).toBe(401);
      expect(await client.recipientRoom({ recipientId, preferredRoomId: "!source" }, signal())).toBe("!private");
      expect(f.transport.recipientRoom).toHaveBeenCalledWith(recipientId, "!source", expect.any(AbortSignal));
      const result = await client.dial({ roomId: "!private", recipientId, message: "Hello", selfCall: true }, signal());
      expect(f.transport.dial).toHaveBeenCalledWith(expect.objectContaining({ selfCall: true, recipientId }), expect.any(AbortSignal));
      await client.leave(result.sessionId, signal());
      for (const error of ["private-room-required", "verification-required"] as const) {
        f.transport.recipientRoom.mockRejectedValueOnce(new MediaControlError(error));
        await expect(client.recipientRoom({ recipientId }, signal())).rejects.toThrow(error);
      }
    } finally { await f.media.shutdown(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("requires explicit transport support and opt-in", async () => {
    const f = fixture(false);
    const { server } = createWorkerServer(secret, f.media); server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const client = await WorkerHttpClient.connect({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, secret, allowInsecureLoopback: true });
      expect(client.selfCalls).toBe(false);
      await expect(client.recipientRoom({ recipientId }, signal())).rejects.toThrow("transport-unavailable");
      await expect(client.dial({ roomId: "!configured", recipientId, message: "Hello", selfCall: true }, signal())).rejects.toThrow("transport-unavailable");
      await expect(f.media.recipientRoom({ recipientId }, signal())).rejects.toThrow("transport-unavailable");
      await expect(f.media.dial({ roomId: "!configured", recipientId, message: "Hello", selfCall: true }, signal())).rejects.toThrow("transport-unavailable");
      expect(new WorkerMediaController({ rooms: ["!configured"], transport: { connect: f.transport.connect, disconnect: f.transport.disconnect, dial: f.transport.dial }, recipients: [recipientId], selfCalls: true }).canSelfCall).toBe(false);
      expect(() => new WorkerMediaController({ rooms: ["!configured"], transport: f.transport, selfCalls: "yes" as never })).toThrow("invalid-request");
    } finally { await f.media.shutdown(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it.each([null, {}, { recipientId: "invalid" }, { recipientId, role: "owner" }])("rejects invalid discovery requests before transport %#", async (value) => {
    const f = fixture(); await expect(f.media.recipientRoom(value, signal())).rejects.toThrow("invalid-request"); expect(f.transport.recipientRoom).not.toHaveBeenCalled();
  });

  it("redacts failed discovery, bounds cancellation and refuses a closed worker", async () => {
    const f = fixture();
    f.transport.recipientRoom.mockRejectedValueOnce(new Error("private failure")).mockResolvedValueOnce("invalid-room");
    for (let i = 0; i < 2; i++) await expect(f.media.recipientRoom({ recipientId }, signal())).rejects.toThrow("backend-failed");
    const controller = new AbortController(); controller.abort();
    await expect(f.media.recipientRoom({ recipientId }, controller.signal)).rejects.toThrow("backend-failed");
    await f.media.shutdown(); await expect(f.media.recipientRoom({ recipientId }, signal())).rejects.toThrow("closed");
  });

  it("rejects a signed discovery result bound to a different recipient", async () => {
    const audience = crypto.randomUUID(); const auth = new RequestAuthenticator({ secret, audience });
    const fetcher: typeof fetch = async (url, options) => {
      const path = new URL(String(url)).pathname;
      const value = options?.method === "POST" ? { roomId: "!private", recipientId: "@victim:example.org" }
        : { protocolVersion: 1, audience, mediaControl: true, clientSessionIds: true, outboundCalls: true, selfCalls: true };
      const body = JSON.stringify(value); return new Response(body, { headers: auth.sign({ method: "RESPONSE_200", path, body }) });
    };
    const client = await WorkerHttpClient.connect({ baseUrl: "https://worker.example.org", secret, fetch: fetcher });
    await expect(client.recipientRoom({ recipientId }, signal())).rejects.toThrow("invalid-response");
  });
});
