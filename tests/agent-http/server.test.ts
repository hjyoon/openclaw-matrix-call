import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { RequestAuthenticator, type AgentReply, type AgentTurn } from "../../packages/core/src/index.js";
import { createAgentServer, HttpAgentAdapter } from "../../packages/agent-http/src/index.js";
import { request } from "../fixtures/agent.js";

const secret = "ab".repeat(32);
const policy = { owners: [request.caller.userId, "@other:example.org"], rooms: [request.caller.roomId, "!other:example.org"], agents: ["assistant", "other"] };
function input() {
  return { ...request, conversationId: randomUUID(), turnId: randomUUID(), caller: { ...request.caller, expiresAtMs: Date.now() + 60_000 } };
}

async function fixture(options: Partial<Parameters<typeof createAgentServer>[0]> = {}) {
  const run = vi.fn(async (_turn: AgentTurn): Promise<AgentReply> => ({ text: "Hello 한국어" }));
  const worker = createAgentServer({ secret, policy, agent: { id: "test", historyMode: "host-session", reply: run }, ...options });
  worker.server.listen(0, "127.0.0.1");
  await once(worker.server, "listening");
  const baseUrl = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const auth = new RequestAuthenticator({ secret, audience: worker.audience });
  const post = async (value: unknown, path = "/turns") => {
    const body = JSON.stringify(value);
    const response = await fetch(baseUrl + path, { method: "POST", body, headers: auth.sign({ method: "POST", path, body }) });
    const reply = await response.text();
    auth.verify({ method: `RESPONSE_${response.status}`, path, body: reply }, Object.fromEntries(response.headers));
    return { status: response.status, body: JSON.parse(reply) };
  };
  return { ...worker, baseUrl, auth, post, run };
}

function abortable(signal: AbortSignal, started: () => void): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started();
  });
}

describe("portable authenticated agent service", () => {
  it.each(["messages", "host-session"] as const)("negotiates %s history and interoperates with the HTTP adapter", async (historyMode) => {
    const run = vi.fn(async () => ({ text: "  Hello 한국어  " }));
    const worker = await fixture({ agent: { id: "portable", historyMode, reply: run } });
    try {
      const adapter = await HttpAgentAdapter.connect({ baseUrl: worker.baseUrl, secret });
      expect(adapter.historyMode).toBe(historyMode);
      const value = input();
      expect(await adapter.reply({ ...value, signal: new AbortController().signal })).toEqual({ text: "Hello 한국어" });
      expect(run.mock.calls).toHaveLength(1);
      const capabilities = await fetch(worker.baseUrl + "/capabilities");
      expect(capabilities.headers.get("cache-control")).toBe("no-store");
      expect(worker.server.maxConnections).toBe(16);
    } finally { await worker.close(); }
  });

  it.each([["GET", "/turns"], ["GET", "/unknown"], ["POST", "/unknown"], ["POST", "/capabilities"], ["POST", "/turns?other=true"]])("rejects unsupported routing %s %s", async (method, path) => {
    const worker = await fixture();
    try { expect((await fetch(worker.baseUrl + path, { method })).status).toBe(404); }
    finally { await worker.close(); }
  });

  it("rejects missing, modified and replayed authentication before dispatch", async () => {
    const worker = await fixture();
    try {
      const path = "/turns";
      const body = JSON.stringify(input());
      const headers = worker.auth.sign({ method: "POST", path, body });
      expect((await fetch(worker.baseUrl + path, { method: "POST", body })).status).toBe(401);
      expect((await fetch(worker.baseUrl + path, { method: "POST", body: body + " ", headers })).status).toBe(401);
      expect(worker.run).not.toHaveBeenCalled();
      expect((await fetch(worker.baseUrl + path, { method: "POST", body, headers })).status).toBe(200);
      expect((await fetch(worker.baseUrl + path, { method: "POST", body, headers })).status).toBe(401);
      expect(worker.run).toHaveBeenCalledTimes(1);
    } finally { await worker.close(); }
  });

  it.each([{}, { ...request, tools: ["exec"] }, { ...request, messages: [] }])("rejects invalid authenticated input %#", async (value) => {
    const worker = await fixture();
    try { expect(await worker.post(value)).toEqual({ status: 400, body: { error: "invalid-request" } }); }
    finally { await worker.close(); }
  });

  it("rejects malformed signed JSON and raw UTF-8 with fixed errors", async () => {
    const worker = await fixture();
    try {
      const path = "/turns";
      const body = "{private invalid json";
      const response = await fetch(worker.baseUrl + path, { method: "POST", body, headers: worker.auth.sign({ method: "POST", path, body }) });
      const reply = await response.text();
      expect(response.status).toBe(400);
      worker.auth.verify({ method: "RESPONSE_400", path, body: reply }, Object.fromEntries(response.headers));
      expect(JSON.parse(reply)).toEqual({ error: "invalid-request" });
      const invalid = await fetch(worker.baseUrl + path, { method: "POST", body: Buffer.from([0xff]) });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "invalid-request-body" });
    } finally { await worker.close(); }
  });

  it("bounds serialized UTF-8 bytes before authentication", async () => {
    const worker = await fixture();
    try {
      const response = await fetch(worker.baseUrl + "/turns", { method: "POST", body: "한".repeat(666_667) });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "invalid-request-body" });
      expect(worker.run).not.toHaveBeenCalled();
    } finally { await worker.close(); }
  });

  it.each([
    { userId: "@visitor:example.org" }, { roomId: "!unlisted:example.org" },
    { expiresAtMs: 0 }, { deviceVerified: false }, { mediaEncrypted: false },
  ])("rechecks caller authority before dispatch %#", async (caller) => {
    const worker = await fixture();
    try {
      const value = input();
      expect(await worker.post({ ...value, caller: { ...value.caller, ...caller } })).toEqual({ status: 403, body: { error: "forbidden" } });
      expect(worker.run).not.toHaveBeenCalled();
    } finally { await worker.close(); }
  });

  it.each([
    { agentId: "unlisted" },
    { messages: [{ ...request.messages[0]!, role: "assistant" }] },
    { messages: [{ ...request.messages[0]!, senderId: "@other:example.org" }] },
  ])("requires an allowed agent and latest message from the verified caller %#", async (extra) => {
    const worker = await fixture();
    try {
      expect(await worker.post({ ...input(), ...extra })).toEqual({ status: 403, body: { error: "forbidden" } });
      expect(worker.run).not.toHaveBeenCalled();
    } finally { await worker.close(); }
  });

  it("binds follow-up history to the original call and rejects duplicate turn IDs", async () => {
    const worker = await fixture();
    try {
      const value = input();
      expect((await worker.post(value)).status).toBe(200);
      expect(await worker.post(value)).toEqual({ status: 409, body: { error: "turn-already-accepted" } });
      expect((await worker.post({ ...value, turnId: randomUUID(), caller: { ...value.caller, expiresAtMs: Date.now() + 90_000 } })).status).toBe(200);
      expect(worker.run).toHaveBeenCalledTimes(2);
    } finally { await worker.close(); }
  });

  it.each([
    { caller: { deviceId: "OTHER" } }, { caller: { rtcSessionId: "rtc-2" } },
    { caller: { participantId: "participant-2" } }, { caller: { roomId: "!other:example.org" } },
    { caller: { userId: "@other:example.org" } }, { agentId: "other" },
  ])("prevents rebinding an accepted conversation %#", async (change) => {
    const worker = await fixture();
    try {
      const value = input();
      await worker.post(value);
      const caller = { ...value.caller, ...change.caller };
      expect(await worker.post({ ...value, ...change, caller, turnId: randomUUID(), messages: [{ ...value.messages[0]!, senderId: caller.userId }] }))
        .toEqual({ status: 403, body: { error: "conversation-mismatch" } });
      expect(worker.run).toHaveBeenCalledTimes(1);
    } finally { await worker.close(); }
  });

  it("refuses capacity without evicting accepted idempotency keys", async () => {
    const worker = await fixture({ maxTurns: 1 });
    try {
      const value = input();
      await worker.post(value);
      expect(await worker.post(input())).toEqual({ status: 503, body: { error: "agent-capacity" } });
      expect(await worker.post(value)).toEqual({ status: 409, body: { error: "turn-already-accepted" } });
      expect(worker.run).toHaveBeenCalledTimes(1);
    } finally { await worker.close(); }
  });

  it.each(["throw", "reject", "invalid"] as const)("redacts %s host failures and never re-executes an accepted failed turn", async (kind) => {
    const worker = await fixture();
    worker.run.mockImplementationOnce(() => {
      if (kind === "throw") throw new Error("private provider credential");
      if (kind === "reject") return Promise.reject(new Error("private prompt"));
      return Promise.resolve({ text: " " });
    });
    try {
      const value = input();
      expect(await worker.post(value)).toEqual({ status: 503, body: { error: "agent-failed" } });
      expect(await worker.post(value)).toEqual({ status: 409, body: { error: "turn-already-accepted" } });
      expect((await worker.post(input())).status).toBe(200);
      expect(worker.run).toHaveBeenCalledTimes(2);
    } finally { await worker.close(); }
  });

  it("rejects concurrent work without queueing another host operation", async () => {
    let release!: (value: AgentReply) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const worker = await fixture();
    worker.run.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; started(); }));
    try {
      const value = input();
      const pending = worker.post(value);
      await began;
      expect(await worker.post(value)).toEqual({ status: 409, body: { error: "turn-already-accepted" } });
      expect(await worker.post(input())).toEqual({ status: 409, body: { error: "agent-busy" } });
      release({ text: "Complete" });
      expect((await pending).status).toBe(200);
      expect(worker.run).toHaveBeenCalledTimes(1);
    } finally { await worker.close(); }
  });

  it.each(["resolve", "reject"] as const)("responds promptly to timeout while retaining the slot until a late %s", async (kind) => {
    let settle!: () => void;
    let observed!: AbortSignal;
    const worker = await fixture({ timeoutMs: 20 });
    worker.run.mockImplementationOnce((turn) => {
      observed = turn.signal;
      return new Promise((resolve, reject) => { settle = () => kind === "resolve" ? resolve({ text: "Late" }) : reject(new Error("late private failure")); });
    });
    try {
      const value = input();
      expect(await worker.post(value)).toEqual({ status: 504, body: { error: "agent-timeout" } });
      expect(observed.aborted).toBe(true);
      expect(await worker.post(input())).toEqual({ status: 409, body: { error: "agent-busy" } });
      settle();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await worker.post(value)).toEqual({ status: 409, body: { error: "turn-already-accepted" } });
      expect((await worker.post(input())).status).toBe(200);
    } finally { settle(); await worker.close(); }
  });

  it("cancels when the client disconnects", async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    let cancelled!: () => void;
    const ended = new Promise<void>((resolve) => { cancelled = resolve; });
    const worker = await fixture();
    worker.run.mockImplementationOnce((turn) => {
      turn.signal.addEventListener("abort", cancelled, { once: true });
      return abortable(turn.signal, started);
    });
    try {
      const controller = new AbortController();
      const adapter = await HttpAgentAdapter.connect({ baseUrl: worker.baseUrl, secret });
      const response = adapter.reply({ ...input(), signal: controller.signal });
      const rejected = expect(response).rejects.toThrow();
      await began;
      controller.abort();
      await ended;
      await rejected;
    } finally { await worker.close(); }
  });

  it("aborts active work, drains it, and closes idempotently", async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    let observed!: AbortSignal;
    const worker = await fixture();
    worker.run.mockImplementationOnce((turn) => { observed = turn.signal; return abortable(turn.signal, started); });
    const response = worker.post(input());
    const rejected = expect(response).rejects.toThrow();
    await began;
    const first = worker.close();
    expect(worker.close()).toBe(first);
    await first;
    await rejected;
    expect(observed.aborted).toBe(true);
    expect(worker.server.listening).toBe(false);
  });

  it("refuses admission after close even if the underlying server is restarted", async () => {
    const worker = await fixture();
    await worker.close();
    worker.server.listen(Number(new URL(worker.baseUrl).port), "127.0.0.1");
    await once(worker.server, "listening");
    try { expect(await worker.post(input())).toEqual({ status: 503, body: { error: "agent-closed" } }); }
    finally { await new Promise<void>((resolve) => { worker.server.close(() => resolve()); }); }
  });

  it("handles an interrupted upload without host dispatch", async () => {
    const worker = await fixture();
    try {
      await new Promise<void>((resolve) => {
        const upload = httpRequest(worker.baseUrl + "/turns", { method: "POST", headers: { "content-length": "100" } });
        upload.on("error", () => resolve());
        upload.write("partial");
        upload.once("socket", (socket) => socket.once("connect", () => setTimeout(() => upload.destroy(), 20)));
      });
      expect(worker.run).not.toHaveBeenCalled();
    } finally { await worker.close(); }
  });

  it.each([0, 300_001, 1.5])("rejects an invalid deadline %s", (timeoutMs) => {
    expect(() => createAgentServer({ secret, policy, agent: { id: "test", historyMode: "messages", reply: vi.fn() }, timeoutMs })).toThrow("Invalid agent service limits");
  });

  it.each([0, 65_537, 1.5])("rejects an invalid ledger limit %s", (maxTurns) => {
    expect(() => createAgentServer({ secret, policy, agent: { id: "test", historyMode: "messages", reply: vi.fn() }, maxTurns })).toThrow("Invalid agent service limits");
  });

  it("rejects a malformed dedicated secret before creating the listener", () => {
    expect(() => createAgentServer({ secret: "bad", policy, agent: { id: "test", historyMode: "messages", reply: vi.fn() } })).toThrow("invalid-auth");
  });
});
