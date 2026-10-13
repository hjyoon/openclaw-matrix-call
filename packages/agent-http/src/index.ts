import {
  agentCapabilitiesSchema, agentResponseSchema, parseAgentRequest, RequestAuthenticator,
} from "@matrix-call/core";
import type { AgentPort, AgentReply, AgentTurn } from "@matrix-call/core";

export type AgentHttpOptions = {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
  fetch?: typeof globalThis.fetch;
};

export class AgentHttpError extends Error {
  constructor(readonly code: "invalid-config" | "http-error" | "invalid-response" | "response-too-large" | "request-too-large") {
    super(code);
    this.name = "AgentHttpError";
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new AgentHttpError("invalid-response");
  }
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new AgentHttpError("invalid-response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new AgentHttpError("response-too-large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class HttpAgentAdapter implements AgentPort {
  readonly id = "matrix-call-http";
  readonly historyMode: "messages" | "host-session";
  readonly #baseUrl: URL;
  readonly #auth: RequestAuthenticator;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  private constructor(
    baseUrl: URL,
    auth: RequestAuthenticator,
    historyMode: "messages" | "host-session",
    timeoutMs: number,
    fetcher: typeof globalThis.fetch,
  ) {
    this.#baseUrl = baseUrl;
    this.#auth = auth;
    this.historyMode = historyMode;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetcher;
  }

  static async connect({
    baseUrl, secret, timeoutMs = 30_000, allowInsecureHttp = false, fetch: fetcher = globalThis.fetch,
  }: AgentHttpOptions): Promise<HttpAgentAdapter> {
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch {
      throw new AgentHttpError("invalid-config");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (base.username || base.password || base.hash || base.search ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && (loopback || allowInsecureHttp))) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new AgentHttpError("invalid-config");
    }
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const endpoint = new URL("capabilities", base);
    const response = await fetcher(endpoint, {
      signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    });
    if (response.status !== 200) throw new AgentHttpError("http-error");
    const body = await readBody(response, 4_096);
    const parsed = agentCapabilitiesSchema.safeParse(parseJson(body));
    if (!parsed.success) throw new AgentHttpError("invalid-response");
    const auth = new RequestAuthenticator({ secret, audience: parsed.data.audience });
    auth.verify({ method: "RESPONSE_200", path: endpoint.pathname, body }, Object.fromEntries(response.headers));
    return new HttpAgentAdapter(base, auth, parsed.data.historyMode, timeoutMs, fetcher);
  }

  async reply(turn: AgentTurn): Promise<AgentReply> {
    turn.signal.throwIfAborted();
    const { signal, ...request } = turn;
    const body = JSON.stringify(parseAgentRequest(request));
    if (Buffer.byteLength(body, "utf8") > 2_000_000) throw new AgentHttpError("request-too-large");
    const endpoint = new URL("turns", this.#baseUrl);
    const response = await this.#fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.#auth.sign({ method: "POST", path: endpoint.pathname, body }),
      },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      redirect: "error",
    });
    if (response.status !== 200) throw new AgentHttpError("http-error");
    const replyBody = await readBody(response, 100_000);
    this.#auth.verify({ method: "RESPONSE_200", path: endpoint.pathname, body: replyBody }, Object.fromEntries(response.headers));
    const reply = agentResponseSchema.safeParse(parseJson(replyBody));
    if (!reply.success || reply.data.conversationId !== turn.conversationId || reply.data.turnId !== turn.turnId) {
      throw new AgentHttpError("invalid-response");
    }
    signal.throwIfAborted();
    return Object.freeze({ text: reply.data.text });
  }
}
