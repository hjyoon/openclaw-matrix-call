import { randomUUID } from "node:crypto";
import { RequestAuthenticator } from "@matrix-call/core";
import {
  mediaErrorSchema, mediaJoinResponseSchema, mediaJoinSchema, mediaLeaveResponseSchema, mediaLeaveSchema,
  mediaStatusSchema, workerCapabilitiesSchema, type MediaRemoteError,
} from "./protocol.js";

export class WorkerHttpError extends Error {
  constructor(readonly code: "invalid-config" | "invalid-response" | "response-too-large" | "http-error" | MediaRemoteError) {
    super(code); this.name = "WorkerHttpError";
  }
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new WorkerHttpError("invalid-response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { void reader.cancel().catch(() => {}); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new WorkerHttpError("response-too-large");
      chunks.push(chunk.value);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new WorkerHttpError("invalid-response"); }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkerHttpError) throw error;
    throw new WorkerHttpError("invalid-response");
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  }
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body); }
  catch { throw new WorkerHttpError("invalid-response"); }
}

export class WorkerHttpClient {
  readonly #base: URL;
  readonly #auth: RequestAuthenticator;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  private constructor(
    base: URL, auth: RequestAuthenticator, timeoutMs: number, fetcher: typeof globalThis.fetch,
  ) { this.#base = base; this.#auth = auth; this.#timeoutMs = timeoutMs; this.#fetch = fetcher; }

  static async connect(options: {
    baseUrl: string; secret: string; timeoutMs?: number; allowInsecureLoopback?: boolean;
    signal?: AbortSignal; fetch?: typeof globalThis.fetch;
  }): Promise<WorkerHttpClient> {
    const { secret, timeoutMs = 35_000, allowInsecureLoopback = false, fetch: fetcher = globalThis.fetch.bind(globalThis) } = options;
    let base: URL;
    try { base = new URL(options.baseUrl); }
    catch { throw new WorkerHttpError("invalid-config"); }
    const local = allowInsecureLoopback && base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash || (base.protocol !== "https:" && !local) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new WorkerHttpError("invalid-config");
    new RequestAuthenticator({ secret, audience: randomUUID() });
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    signal.throwIfAborted();
    const endpoint = new URL("v1/media/capabilities", base);
    const response = await fetcher(endpoint, { signal, redirect: "error" });
    if (response.status !== 200) throw new WorkerHttpError("http-error");
    const body = await readBody(response, 4096, signal);
    const parsed = workerCapabilitiesSchema.safeParse(parseJson(body));
    if (!parsed.success) throw new WorkerHttpError("invalid-response");
    const auth = new RequestAuthenticator({ secret, audience: parsed.data.audience });
    auth.verify({ method: "RESPONSE_200", path: endpoint.pathname, body }, Object.fromEntries(response.headers));
    if (!parsed.data.mediaControl) throw new WorkerHttpError("transport-unavailable");
    return new WorkerHttpClient(base, auth, timeoutMs, fetcher);
  }

  async status(signal: AbortSignal) {
    return mediaStatusSchema.parse(await this.#request("status", {}, signal));
  }

  async join(roomId: string, signal: AbortSignal, sessionId: string = randomUUID()) {
    const input = mediaJoinSchema.parse({ roomId, sessionId });
    const result = mediaJoinResponseSchema.parse(await this.#request("join", input, signal));
    if (result.roomId !== roomId || result.sessionId !== input.sessionId) throw new WorkerHttpError("invalid-response");
    return result;
  }

  async leave(sessionId: string, signal: AbortSignal): Promise<void> {
    const input = mediaLeaveSchema.parse({ sessionId });
    mediaLeaveResponseSchema.parse(await this.#request("leave", input, signal));
  }

  async #request(operation: string, value: unknown, callerSignal: AbortSignal): Promise<unknown> {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.#timeoutMs)]);
    signal.throwIfAborted();
    const endpoint = new URL(`v1/media/${operation}`, this.#base);
    const body = JSON.stringify(value);
    const response = await this.#fetch(endpoint, { method: "POST", body, signal, redirect: "error",
      headers: { "content-type": "application/json", ...this.#auth.sign({ method: "POST", path: endpoint.pathname, body }) } });
    if (response.status === 401) throw new WorkerHttpError("http-error");
    const reply = await readBody(response, 65_536, signal);
    this.#auth.verify({ method: `RESPONSE_${response.status}`, path: endpoint.pathname, body: reply }, Object.fromEntries(response.headers));
    const result = parseJson(reply);
    if (response.status !== 200) {
      const error = mediaErrorSchema.safeParse(result);
      if (!error.success) throw new WorkerHttpError("invalid-response");
      throw new WorkerHttpError(error.data.error);
    }
    return result;
  }
}
