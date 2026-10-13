import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AuthenticationError, RequestAuthenticator, type SpeechRecognitionPort, type SpeechSynthesisPort } from "@matrix-call/core";
import { decodePcm, encodePcm, synthesisRequestSchema, synthesisResponseSchema, transcriptionRequestSchema, transcriptionResponseSchema } from "@matrix-call/speech-http";

class BodyError extends Error {
  constructor(readonly status: 400 | 413) { super("invalid-request-body"); }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1_300_000) throw new BodyError(413);
      chunks.push(buffer);
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

export function createSpeechServer(options: {
  secret: string; recognition: SpeechRecognitionPort; synthesis: SpeechSynthesisPort; timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid speech timeout");
  const audience = randomUUID();
  const auth = new RequestAuthenticator({ secret: options.secret, audience });
  let active: AbortController | undefined;
  let pending: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, async (request, response) => {
    const path = request.url!;
    const signed = (status: number, value: unknown): void => {
      const body = JSON.stringify(value);
      json(response, status, body, auth.sign({ method: `RESPONSE_${status}`, path, body }));
    };
    if (request.method === "GET" && path === "/healthz") {
      json(response, 200, JSON.stringify({ protocolVersion: 1, audience, ready: false, status: "development" }));
      return;
    }
    if (request.method === "GET" && path === "/capabilities") {
      signed(200, { protocolVersion: 1, audience, recognition: true, synthesis: true, encoding: "pcm-s16le" });
      return;
    }
    if (request.method !== "POST" || (path !== "/transcriptions" && path !== "/syntheses")) {
      json(response, 404, JSON.stringify({ error: "not-found" }));
      return;
    }
    const controller = new AbortController();
    const onClose = () => { controller.abort(); };
    response.on("close", onClose);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      const body = await readBody(request);
      auth.verify({ method: "POST", path, body }, request.headers);
      let value: unknown;
      try { value = JSON.parse(body); }
      catch { signed(400, { error: "invalid-request" }); return; }
      const parsed = (path === "/transcriptions" ? transcriptionRequestSchema : synthesisRequestSchema).safeParse(value);
      if (!parsed.success) { signed(400, { error: "invalid-request" }); return; }
      if (closing) { signed(503, { error: "speech-closed" }); return; }
      if (active) { signed(409, { error: "speech-busy" }); return; }
      controller.signal.throwIfAborted();
      active = controller;
      timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
      const envelope = { protocolVersion: 1, requestId: parsed.data.requestId };
      if ("audio" in parsed.data) {
        const audio = decodePcm(parsed.data.audio);
        try {
          const operation = options.recognition.transcribe(audio, controller.signal);
          pending = operation;
          const text = await operation;
          controller.signal.throwIfAborted();
          signed(200, transcriptionResponseSchema.parse({ ...envelope, text }));
        } finally { audio.samples.fill(0); }
      } else {
        const operation = options.synthesis.synthesize(parsed.data.text, controller.signal);
        pending = operation;
        const audio = await operation;
        try {
          controller.signal.throwIfAborted();
          signed(200, synthesisResponseSchema.parse({ ...envelope, audio: encodePcm(audio) }));
        } finally { audio.samples.fill(0); }
      }
    } catch (error) {
      request.resume();
      if (error instanceof AuthenticationError) json(response, 401, JSON.stringify({ error: "unauthorized" }));
      else if (error instanceof BodyError) json(response, error.status, JSON.stringify({ error: "invalid-request-body" }));
      else signed(expired ? 504 : 503, { error: expired ? "speech-timeout" : "speech-failed" });
    } finally {
      clearTimeout(timer);
      response.off("close", onClose);
      if (active === controller) { active = undefined; pending = undefined; }
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
