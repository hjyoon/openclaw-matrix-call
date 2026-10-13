import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AgentHttpError, HttpAgentAdapter } from "../../packages/agent-http/src/index.js";
import {
  AuthenticationError, CallCoordinator, MemoryConversationStore, RequestAuthenticator,
} from "../../packages/core/src/index.js";
import type { AgentTurn } from "../../packages/core/src/index.js";
import { request } from "../fixtures/agent.js";

const secret = "ab".repeat(32);
const audience = "03ade3af-6c83-4b45-b401-acab7432111a";
const baseUrl = "http://127.0.0.1:9980/v1/agent";

function turn(signal = new AbortController().signal): AgentTurn {
  return { ...request, signal };
}

function fixtures(historyMode: "messages" | "host-session" = "messages") {
  const auth = new RequestAuthenticator({ secret, audience });
  const signed = (body: string, path: string) => new Response(body, {
    status: 200,
    headers: auth.sign({ method: "RESPONSE_200", path, body }),
  });
  const capability = () => signed(JSON.stringify({ protocolVersion: 1, audience, historyMode }), "/v1/agent/capabilities");
  const reply = (extra: Record<string, unknown> = {}) => signed(JSON.stringify({
    protocolVersion: 1, conversationId: request.conversationId, turnId: request.turnId,
    text: "Welcome", ...extra,
  }), "/v1/agent/turns");
  const fetcher = vi.fn<typeof globalThis.fetch>();
  fetcher.mockImplementation(async (_url, init) => {
    if (init?.method !== "POST") return capability();
    return reply();
  });
  return { auth, signed, capability, reply, fetcher };
}

describe("provider-neutral HTTP agent adapter", () => {
  it.each(["messages", "host-session"] as const)("supports declared %s history mode", async (historyMode) => {
    const { auth, fetcher } = fixtures(historyMode);
    const adapter = await HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher });
    expect(adapter.historyMode).toBe(historyMode);
    expect(adapter.id).toBe("matrix-call-http");
    expect(await adapter.reply(turn())).toEqual({ text: "Welcome" });
    const [endpoint, options] = fetcher.mock.calls[1]!;
    expect(String(endpoint)).toBe(`${baseUrl}/turns`);
    expect(options!.redirect).toBe("error");
    expect(JSON.parse(options!.body as string)).toEqual(request);
    expect(options!.body).not.toContain("signal");
    auth.verify({ method: "POST", path: "/v1/agent/turns", body: options!.body as string },
      options!.headers as Record<string, string>);
  });

  it.each([
    "not a url", "ftp://localhost/api", "https://user:password@example.org/api",
    "https://example.org/api#fragment", "https://example.org/api?token=secret", "http://example.org/api",
  ])("rejects unsafe endpoint %s", async (url) => {
    const { fetcher } = fixtures();
    await expect(HttpAgentAdapter.connect({ baseUrl: url, secret, fetch: fetcher }))
      .rejects.toThrowError(new AgentHttpError("invalid-config"));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([0, 300_001, 1.5, NaN])("rejects invalid timeout %s", async (timeoutMs) => {
    const { fetcher } = fixtures();
    await expect(HttpAgentAdapter.connect({ baseUrl, secret, timeoutMs, fetch: fetcher }))
      .rejects.toThrowError(new AgentHttpError("invalid-config"));
  });

  it.each([
    ["https://example.org/v1/agent/", false],
    ["http://private.example.org/v1/agent/", true],
    ["http://localhost/v1/agent/", false],
    ["http://[::1]/v1/agent/", false],
  ] as const)("accepts explicitly configured endpoint %s", async (url, allowInsecureHttp) => {
    const { fetcher } = fixtures();
    await HttpAgentAdapter.connect({ baseUrl: url, secret, allowInsecureHttp, fetch: fetcher });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${url}capabilities`);
  });

  it("rejects a failed capability request", async () => {
    const { fetcher } = fixtures();
    fetcher.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher }))
      .rejects.toThrowError(new AgentHttpError("http-error"));
  });

  it("rejects a bodyless capability response", async () => {
    const { fetcher } = fixtures();
    fetcher.mockResolvedValueOnce(new Response(null));
    await expect(HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher }))
      .rejects.toThrowError(new AgentHttpError("invalid-response"));
  });

  it.each(["{", JSON.stringify({ protocolVersion: 2, audience, historyMode: "messages" })])
    ("rejects invalid capability JSON %#", async (body) => {
      const { fetcher, signed } = fixtures();
      fetcher.mockResolvedValueOnce(signed(body, "/v1/agent/capabilities"));
      await expect(HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher }))
        .rejects.toThrowError(new AgentHttpError("invalid-response"));
    });

  it("requires authenticated capabilities", async () => {
    const { fetcher } = fixtures();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ protocolVersion: 1, audience, historyMode: "messages" })));
    await expect(HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher }))
      .rejects.toThrowError(new AuthenticationError("invalid-auth"));
  });

  it("limits response bytes while consuming multiple stream chunks", async () => {
    const { fetcher } = fixtures();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2_000));
        controller.enqueue(new Uint8Array(2_000));
        controller.enqueue(new Uint8Array(97));
      },
      cancel() { cancelled = true; },
    });
    fetcher.mockResolvedValueOnce(new Response(stream));
    await expect(HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher }))
      .rejects.toThrowError(new AgentHttpError("response-too-large"));
    expect(cancelled).toBe(true);
  });

  it("does not dispatch an already cancelled turn", async () => {
    const { fetcher } = fixtures();
    const adapter = await HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher });
    await expect(adapter.reply(turn(AbortSignal.abort(new Error("cancelled")))))
      .rejects.toThrow("cancelled");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("limits serialized UTF-8 request bytes", async () => {
    const { fetcher } = fixtures();
    const adapter = await HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher });
    await expect(adapter.reply({ ...turn(), messages: Array(100).fill({
      ...request.messages[0], text: "界".repeat(16_000),
    }) })).rejects.toThrowError(new AgentHttpError("request-too-large"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns bounded failures without revealing remote error bodies", async () => {
    const { fetcher } = fixtures();
    const adapter = await HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher });
    fetcher.mockResolvedValueOnce(new Response("secret remote error", { status: 500 }));
    await expect(adapter.reply(turn())).rejects.toThrowError(new AgentHttpError("http-error"));
  });

  it.each([
    { protocolVersion: 2 }, { conversationId: randomUUID() }, { turnId: randomUUID() }, { text: " " },
  ])("rejects unsupported or misrouted agent replies %#", async (extra) => {
    const { fetcher, reply } = fixtures();
    const adapter = await HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher });
    fetcher.mockResolvedValueOnce(reply(extra));
    await expect(adapter.reply(turn())).rejects.toThrowError(new AgentHttpError("invalid-response"));
  });

  it("rejects authenticated malformed reply JSON", async () => {
    const { fetcher, signed } = fixtures();
    const adapter = await HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher });
    fetcher.mockResolvedValueOnce(signed("{", "/v1/agent/turns"));
    await expect(adapter.reply(turn())).rejects.toThrowError(new AgentHttpError("invalid-response"));
  });

  it("rejects a reply whose raw body was modified after signing", async () => {
    const { fetcher, reply } = fixtures();
    const adapter = await HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher });
    fetcher.mockResolvedValueOnce(new Response("tampered", { headers: reply().headers }));
    await expect(adapter.reply(turn())).rejects.toThrowError(new AuthenticationError("invalid-auth"));
  });

  it("rejects a reply received after local cancellation", async () => {
    const { fetcher, reply } = fixtures();
    const adapter = await HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher });
    const controller = new AbortController();
    fetcher.mockImplementationOnce(async () => { controller.abort(new Error("call closed")); return reply(); });
    await expect(adapter.reply(turn(controller.signal))).rejects.toThrow("call closed");
  });

  it("propagates cancellation during the HTTP request", async () => {
    const { fetcher } = fixtures();
    const adapter = await HttpAgentAdapter.connect({ baseUrl, secret, fetch: fetcher });
    fetcher.mockImplementationOnce(async (_url, options) => {
      await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      options!.signal!.throwIfAborted();
      throw new Error("unreachable");
    });
    const controller = new AbortController();
    const pending = adapter.reply(turn(controller.signal));
    const assertion = expect(pending).rejects.toThrow("cancel during fetch");
    controller.abort(new Error("cancel during fetch"));
    await assertion;
  });

  it("runs a complete core turn against a real local agent HTTP service", async () => {
    const auth = new RequestAuthenticator({ secret, audience });
    const received: unknown[] = [];
    const server = createServer(async (req, res) => {
      try {
        const path = req.url!;
        let body: string;
        if (req.method === "GET") {
          body = JSON.stringify({ protocolVersion: 1, audience, historyMode: "messages" });
        } else {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const raw = Buffer.concat(chunks).toString("utf8");
          auth.verify({ method: "POST", path, body: raw }, req.headers);
          const payload = JSON.parse(raw);
          received.push(payload);
          body = JSON.stringify({ protocolVersion: 1, conversationId: payload.conversationId,
            turnId: payload.turnId, text: `Heard ${payload.messages.at(-1).text}` });
        }
        res.writeHead(200, { "content-type": "application/json", ...auth.sign({ method: "RESPONSE_200", path, body }) });
        res.end(body);
      } catch { res.writeHead(500).end(); }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    try {
      const adapter = await HttpAgentAdapter.connect({ baseUrl: `http://127.0.0.1:${address.port}/v1/agent/`, secret });
      const store = new MemoryConversationStore();
      const calls = new CallCoordinator({
        policy: { owners: [request.caller.userId], rooms: [request.caller.roomId], agents: [request.agentId] },
        verifier: { async verify(reference) { return { ...request.caller, ...reference, expiresAtMs: Date.now() + 60_000 }; } },
        agent: adapter, store,
      });
      const call = await calls.open({ reference: {
        roomId: request.caller.roomId, rtcSessionId: request.caller.rtcSessionId, participantId: request.caller.participantId,
      }, agentId: request.agentId });
      expect(await calls.turn(call.id, request.caller.participantId, "Hello self-hosted agent"))
        .toEqual({ text: "Heard Hello self-hosted agent" });
      expect(received).toHaveLength(1);
      expect(JSON.stringify(received)).not.toContain("openclaw");
      await calls.close(call.id);
      expect((await store.get(call.id))!.status).toBe("closed");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
