import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AuthenticationError, RequestAuthenticator, agentRequestSchema, agentResponseSchema,
  authorizeParticipant, parsePolicy, type AgentPort, type AgentReply, type CallPolicy, type VerifiedParticipant,
} from "@matrix-call/core";

class BodyError extends Error {
  constructor(readonly status: 400 | 413) { super("invalid-request-body"); }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      bytes += buffer.length;
      if (bytes > 2_000_000) throw new BodyError(413);
    }
    const body = Buffer.concat(chunks);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(body); }
    catch { throw new BodyError(400); }
    finally { body.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

function json(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json", "cache-control": "no-store", "connection": "close", ...headers,
  });
  response.end(body);
}

export function createAgentServer(options: {
  secret: string; agent: AgentPort; policy: CallPolicy; timeoutMs?: number; maxTurns?: number;
  policyForCaller?: ((caller: VerifiedParticipant) => CallPolicy | undefined) | undefined;
}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxTurns = options.maxTurns ?? 4_096;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
    !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 65_536) throw new Error("Invalid agent service limits");
  const policy = parsePolicy(options.policy);
  const audience = randomUUID();
  const auth = new RequestAuthenticator({ secret: options.secret, audience });
  const accepted = new Set<string>();
  const conversations = new Map<string, string>();
  let active: AbortController | undefined;
  let pending: Promise<AgentReply> | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, async (request, response) => {
    const path = request.url!;
    const signed = (status: number, value: unknown): void => {
      const body = JSON.stringify(value);
      json(response, status, body, auth.sign({ method: `RESPONSE_${status}`, path, body }));
    };
    if (request.method === "GET" && path === "/capabilities") {
      signed(200, { protocolVersion: 1, audience, historyMode: options.agent.historyMode });
      return;
    }
    if (request.method !== "POST" || path !== "/turns") {
      json(response, 404, JSON.stringify({ error: "not-found" }));
      return;
    }
    const controller = new AbortController();
    const onClose = () => { controller.abort(); };
    response.on("close", onClose);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let expired = false;
    try {
      const body = await readBody(request);
      auth.verify({ method: "POST", path, body }, request.headers);
      let value: unknown;
      try { value = JSON.parse(body); }
      catch { signed(400, { error: "invalid-request" }); return; }
      const parsed = agentRequestSchema.safeParse(value);
      if (!parsed.success) { signed(400, { error: "invalid-request" }); return; }
      if (closing) { signed(503, { error: "agent-closed" }); return; }
      const turn = parsed.data;
      try {
        const currentPolicy = parsePolicy(options.policyForCaller?.(turn.caller) ?? policy);
        authorizeParticipant(currentPolicy, turn.caller, turn.caller, Date.now());
        const latest = turn.messages.at(-1)!;
        if (!currentPolicy.agents.includes(turn.agentId) || latest.role !== "user" || latest.senderId !== turn.caller.userId) {
          throw new Error("invalid-caller");
        }
      } catch { signed(403, { error: "forbidden" }); return; }
      const binding = JSON.stringify([
        turn.agentId, turn.caller.roomId, turn.caller.rtcSessionId, turn.caller.participantId,
        turn.caller.userId, turn.caller.deviceId,
      ]);
      const previous = conversations.get(turn.conversationId);
      if (previous !== undefined && previous !== binding) { signed(403, { error: "conversation-mismatch" }); return; }
      if (accepted.has(turn.turnId)) { signed(409, { error: "turn-already-accepted" }); return; }
      if (active) { signed(409, { error: "agent-busy" }); return; }
      if (accepted.size >= maxTurns) { signed(503, { error: "agent-capacity" }); return; }
      controller.signal.throwIfAborted();
      accepted.add(turn.turnId);
      conversations.set(turn.conversationId, binding);
      active = controller;
      timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => { reject(controller.signal.reason); };
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const operation = Promise.resolve().then(() => options.agent.reply({ ...turn, signal: controller.signal }));
      pending = operation.finally(() => { active = undefined; pending = undefined; });
      const reply = await Promise.race([pending, aborted]);
      controller.signal.throwIfAborted();
      signed(200, agentResponseSchema.parse({
        protocolVersion: 1, conversationId: turn.conversationId, turnId: turn.turnId, text: reply.text,
      }));
    } catch (error) {
      request.resume();
      if (error instanceof AuthenticationError) json(response, 401, JSON.stringify({ error: "unauthorized" }));
      else if (error instanceof BodyError) json(response, error.status, JSON.stringify({ error: "invalid-request-body" }));
      else signed(expired ? 504 : 503, { error: expired ? "agent-timeout" : "agent-failed" });
    } finally {
      clearTimeout(timer);
      response.off("close", onClose);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  });
  server.maxConnections = 16;
  const close = (): Promise<void> => {
    if (closing) return closing;
    active?.abort();
    server.closeAllConnections();
    const stopped = new Promise<void>((resolve) => { server.close(() => resolve()); });
    closing = Promise.allSettled([stopped, pending]).then(() => {});
    return closing;
  };
  return Object.freeze({ server, audience, close });
}
