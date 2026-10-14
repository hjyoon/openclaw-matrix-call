import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthenticationError, RequestAuthenticator } from "@matrix-call/core";
import { MediaControlError, type WorkerMediaController } from "./media.js";

const mediaPaths = new Set(["/v1/media/status", "/v1/media/join", "/v1/media/leave"]);
const mediaErrorStatus = { "invalid-request": 400, "forbidden-room": 403, busy: 409, "not-found": 404, closed: 409, "backend-failed": 503, "session-reused": 409, "capacity-exceeded": 503 } as const;

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

export function createWorkerServer(secret: string, media?: WorkerMediaController) {
  const audience = randomUUID();
  const auth = new RequestAuthenticator({ secret, audience });
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8_192 },
    async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/media/capabilities") {
        const value = { protocolVersion: 1, audience, mediaControl: Boolean(media), clientSessionIds: true };
        const body = JSON.stringify(value);
        json(response, 200, value, auth.sign({ method: "RESPONSE_200", path: request.url, body }));
        return;
      }
      if (request.method === "GET" && request.url === "/healthz") {
        json(response, 200, { protocolVersion: 1, status: "development", audience, ready: false, transports: media ? ["media-control"] : [] });
        return;
      }
      if (request.method === "GET" && request.url === "/readyz") {
        json(response, 503, { ready: false, error: "transport-unavailable" });
        return;
      }
      if (request.method !== "POST" || (request.url !== "/v1/calls" && !mediaPaths.has(request.url!))) {
        json(response, 404, { error: "not-found" });
        return;
      }
      const path = request.url!;
      const signed = (status: number, value: unknown): void => {
        const reply = JSON.stringify(value);
        json(response, status, value, auth.sign({ method: `RESPONSE_${status}`, path, body: reply }));
      };
      const controller = new AbortController();
      const onClose = () => { controller.abort(); };
      response.on("close", onClose);
      try {
        const body = await readBody(request);
        auth.verify({ method: "POST", path, body }, request.headers);
        if (path === "/v1/calls" || !media) { signed(501, { error: "transport-unavailable" }); return; }
        let value: unknown;
        try { value = JSON.parse(body); } catch { throw new MediaControlError("invalid-request"); }
        if (path === "/v1/media/status") signed(200, media.status(value));
        else if (path === "/v1/media/join") signed(200, await media.join(value, controller.signal));
        else { await media.leave(value); signed(200, { closed: true }); }
      } catch (error) {
        request.resume();
        if (error instanceof AuthenticationError) json(response, 401, { error: "unauthorized" });
        else if (error instanceof BodyError) json(response, error.status, { error: "invalid-request-body" });
        else if (error instanceof MediaControlError) signed(mediaErrorStatus[error.code], { error: error.code });
        else json(response, 500, { error: "internal-error" });
      } finally {
        response.off("close", onClose);
      }
    });
  return Object.freeze({ server, audience });
}
