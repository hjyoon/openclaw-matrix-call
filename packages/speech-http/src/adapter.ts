import { randomUUID } from "node:crypto";
import { RequestAuthenticator, SynthesisLimitError, type PcmAudio, type SpeechRecognitionPort, type SpeechSynthesisPort } from "@matrix-call/core";
import { decodePcm, encodePcm, speechCapabilitiesSchema, synthesisLimitResponseSchema, synthesisRequestSchema, synthesisResponseSchema, transcriptionResponseSchema } from "./protocol.js";

export type SpeechHttpOptions = Readonly<{
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  allowInsecureLoopback?: boolean;
  fetch?: typeof globalThis.fetch;
}>;

export class SpeechHttpError extends Error {
  constructor(readonly code: "invalid-config" | "http-error" | "invalid-response" | "response-too-large") {
    super(code); this.name = "SpeechHttpError";
  }
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new SpeechHttpError("invalid-response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new SpeechHttpError("response-too-large");
      chunks.push(chunk.value);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new SpeechHttpError("invalid-response"); }
  } finally { signal.removeEventListener("abort", abort); await reader.cancel(); }
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body); }
  catch { throw new SpeechHttpError("invalid-response"); }
}

export class HttpSpeechAdapter implements SpeechRecognitionPort, SpeechSynthesisPort {
  readonly #baseUrl: URL;
  readonly #auth: RequestAuthenticator;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  private constructor(baseUrl: URL, auth: RequestAuthenticator, timeoutMs: number, fetcher: typeof globalThis.fetch) {
    this.#baseUrl = baseUrl; this.#auth = auth; this.#timeoutMs = timeoutMs; this.#fetch = fetcher;
  }

  static async connect({ baseUrl, secret, timeoutMs = 30_000, allowInsecureLoopback = false,
    fetch: fetcher = globalThis.fetch.bind(globalThis) }: SpeechHttpOptions): Promise<HttpSpeechAdapter> {
    let base: URL;
    try { base = new URL(baseUrl); }
    catch { throw new SpeechHttpError("invalid-config"); }
    const local = allowInsecureLoopback && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) && base.protocol === "http:";
    if (base.username || base.password || base.search || base.hash || (base.protocol !== "https:" && !local) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new SpeechHttpError("invalid-config");
    new RequestAuthenticator({ secret, audience: randomUUID() });
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const endpoint = new URL("capabilities", base);
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetcher(endpoint, { signal, redirect: "error" });
    if (response.status !== 200) throw new SpeechHttpError("http-error");
    const body = await readBody(response, 4096, signal);
    const capabilities = speechCapabilitiesSchema.safeParse(parseJson(body));
    if (!capabilities.success) throw new SpeechHttpError("invalid-response");
    const auth = new RequestAuthenticator({ secret, audience: capabilities.data.audience });
    auth.verify({ method: "RESPONSE_200", path: endpoint.pathname, body }, Object.fromEntries(response.headers));
    return new HttpSpeechAdapter(base, auth, timeoutMs, fetcher);
  }

  async transcribe(audio: PcmAudio, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const requestId = randomUUID();
    const response = await this.#request("transcriptions", { protocolVersion: 1, requestId, audio: encodePcm(audio) }, 100_000, signal);
    const result = transcriptionResponseSchema.safeParse(response);
    if (!result.success || result.data.requestId !== requestId) throw new SpeechHttpError("invalid-response");
    return result.data.text;
  }

  async synthesize(text: string, signal: AbortSignal): Promise<PcmAudio> {
    signal.throwIfAborted();
    const request = synthesisRequestSchema.parse({ protocolVersion: 1, requestId: randomUUID(), text });
    const response = await this.#request("syntheses", request, 1_300_000, signal);
    const result = synthesisResponseSchema.safeParse(response);
    if (!result.success || result.data.requestId !== request.requestId) throw new SpeechHttpError("invalid-response");
    return decodePcm(result.data.audio);
  }

  async #request<T extends { requestId: string }>(path: string, request: T, maxBytes: number, callerSignal: AbortSignal): Promise<unknown> {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.#timeoutMs)]);
    const body = JSON.stringify(request);
    const endpoint = new URL(path, this.#baseUrl);
    const response = await this.#fetch(endpoint, { method: "POST", body, redirect: "error", signal,
      headers: { "content-type": "application/json", ...this.#auth.sign({ method: "POST", path: endpoint.pathname, body }) } });
    if (response.status === 422 && path === "syntheses") {
      const responseBody = await readBody(response, 512, signal);
      this.#auth.verify({ method: "RESPONSE_422", path: endpoint.pathname, body: responseBody }, Object.fromEntries(response.headers));
      const result = synthesisLimitResponseSchema.safeParse(parseJson(responseBody));
      if (!result.success || result.data.requestId !== request.requestId) throw new SpeechHttpError("invalid-response");
      throw new SynthesisLimitError();
    }
    if (response.status !== 200) throw new SpeechHttpError("http-error");
    const responseBody = await readBody(response, maxBytes, signal);
    this.#auth.verify({ method: "RESPONSE_200", path: endpoint.pathname, body: responseBody }, Object.fromEntries(response.headers));
    return parseJson(responseBody);
  }
}
