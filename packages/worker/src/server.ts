import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthenticationError, RequestAuthenticator } from "@matrix-call/core";

class BodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super("invalid-request-body");
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 65_536) throw new BodyError(413);
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new BodyError(400);
  }
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    "content-type": "application/json", "cache-control": "no-store", "connection": "close", ...headers,
  });
  response.end(JSON.stringify(value));
}

export function createWorkerServer(secret: string) {
  const audience = randomUUID();
  const auth = new RequestAuthenticator({ secret, audience });
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8_192 },
    async (request, response) => {
      if (request.method === "GET" && request.url === "/healthz") {
        json(response, 200, { protocolVersion: 1, status: "development", audience, ready: false, transports: [] });
        return;
      }
      if (request.method === "GET" && request.url === "/readyz") {
        json(response, 503, { ready: false, error: "transport-unavailable" });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/calls") {
        json(response, 404, { error: "not-found" });
        return;
      }
      try {
        const body = await readBody(request);
        auth.verify({ method: "POST", path: "/v1/calls", body }, request.headers);
        const reply = JSON.stringify({ error: "transport-unavailable" });
        const headers = auth.sign({ method: "RESPONSE_501", path: "/v1/calls", body: reply });
        json(response, 501, { error: "transport-unavailable" }, headers);
      } catch (error) {
        request.resume();
        if (error instanceof AuthenticationError) json(response, 401, { error: "unauthorized" });
        else if (error instanceof BodyError) json(response, error.status, { error: "invalid-request-body" });
        else json(response, 500, { error: "internal-error" });
      }
    });
  return Object.freeze({ server, audience });
}
