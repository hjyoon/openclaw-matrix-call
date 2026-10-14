import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { RequestAuthenticator } from "../../dist/core/index.js";
import { synthesisRequestSchema, synthesisResponseSchema, synthesisLimitResponseSchema, transcriptionRequestSchema } from "../../dist/speech-http/index.js";

export async function observeSpeech(baseUrl, secret) {
  const capability = await fetch(baseUrl + "/capabilities", { signal: AbortSignal.timeout(5000) });
  const body = await capability.text(); const audience = JSON.parse(body).audience;
  const auth = new RequestAuthenticator({ secret, audience });
  auth.verify({ method: "RESPONSE_200", path: "/capabilities", body }, Object.fromEntries(capability.headers));
  const state = { syntheses: [], limits: 0, invalidRequests: 0 };
  const server = createServer(async (request, response) => {
    const controller = new AbortController(); const abort = () => controller.abort(); response.on("close", abort);
    try {
      assert(["/capabilities", "/transcriptions", "/syntheses"].includes(request.url));
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 1_300_000); chunks.push(chunk); }
      const body = Buffer.concat(chunks).toString("utf8"); let input;
      if (request.method === "POST") {
        auth.verify({ method: "POST", path: request.url, body }, request.headers);
        input = (request.url === "/syntheses" ? synthesisRequestSchema : transcriptionRequestSchema).parse(JSON.parse(body));
      } else { assert.equal(request.method, "GET"); assert.equal(request.url, "/capabilities"); }
      const upstream = await fetch(baseUrl + request.url, { method: request.method, headers: request.headers,
        ...(input ? { body } : {}), signal: controller.signal });
      const reply = await upstream.text(); assert(Buffer.byteLength(reply) <= 1_300_000);
      auth.verify({ method: `RESPONSE_${upstream.status}`, path: request.url, body: reply }, Object.fromEntries(upstream.headers));
      if (request.url === "/syntheses" && upstream.status === 200) {
        const result = synthesisResponseSchema.parse(JSON.parse(reply)); assert.equal(result.requestId, input.requestId);
        state.syntheses.push({ text: input.text, seconds: Buffer.from(result.audio.data, "base64").length / (result.audio.sampleRate * 2), atMs: Date.now() });
      } else if (upstream.status === 422) {
        const result = synthesisLimitResponseSchema.parse(JSON.parse(reply)); assert.equal(result.requestId, input.requestId); state.limits++;
      }
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers)).end(reply);
    } catch { if (!controller.signal.aborted) state.invalidRequests++; if (!response.destroyed) response.writeHead(500).end(); }
    finally { response.off("close", abort); }
  });
  server.maxConnections = 16; server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
