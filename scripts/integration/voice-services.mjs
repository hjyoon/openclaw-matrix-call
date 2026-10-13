import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function startTestVoiceServices(root, { agentReply = () => "Fixture agent response" } = {}) {
  const { RequestAuthenticator, parseAgentRequest } = await import(pathToFileURL(path.join(root, "dist/core/index.js")));
  const { decodePcm, encodePcm, transcriptionRequestSchema, synthesisRequestSchema } = await import(pathToFileURL(path.join(root, "dist/speech-http/index.js")));
  const agentSecret = randomBytes(32).toString("hex"); const speechSecret = randomBytes(32).toString("hex");
  const agentAudience = randomUUID(); const speechAudience = randomUUID();
  const agentAuth = new RequestAuthenticator({ secret: agentSecret, audience: agentAudience });
  const speechAuth = new RequestAuthenticator({ secret: speechSecret, audience: speechAudience });
  const state = { transcriptions: [], turns: [], syntheses: 0, canceledRecognition: 0, invalidRequests: 0, holdRecognition: false };
  const pending = new Set();
  const server = createServer(async (request, response) => {
    try {
      const url = request.url;
      const agent = url.startsWith("/agent/"); const auth = agent ? agentAuth : speechAuth;
      const send = (payload) => {
        const body = JSON.stringify(payload);
        response.writeHead(200, { "content-type": "application/json", ...auth.sign({ method: "RESPONSE_200", path: url, body }) }).end(body);
      };
      if (request.method === "GET") {
        assert(url === "/agent/capabilities" || url === "/speech/capabilities");
        send(agent ? { protocolVersion: 1, audience: agentAudience, historyMode: "messages" }
          : { protocolVersion: 1, audience: speechAudience, recognition: true, synthesis: true, encoding: "pcm-s16le" });
        return;
      }
      assert.equal(request.method, "POST");
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 1_400_000); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString("utf8");
      auth.verify({ method: "POST", path: url, body: raw }, request.headers);
      const parsed = JSON.parse(raw);
      if (url === "/speech/transcriptions") {
        const input = transcriptionRequestSchema.parse(parsed); const audio = decodePcm(input.audio);
        const rms = Math.sqrt(audio.samples.reduce((sum, value) => sum + value * value, 0) / audio.samples.length) / 32768;
        let first = -1; let last = 0; let crossings = 0;
        for (let i = 1; i < audio.samples.length; i++) {
          if (Math.abs(audio.samples[i]) > 1000) { if (first < 0) first = i; last = i; }
        }
        for (let i = first + 1; i <= last; i++) if (audio.samples[i - 1] <= 0 && audio.samples[i] > 0) crossings++;
        const frequency = crossings * audio.sampleRate / (last - first);
        assert(rms > 0.03 && Number.isFinite(frequency));
        state.transcriptions.push({ rms, frequency, sampleRate: audio.sampleRate, duration: audio.samples.length / audio.sampleRate });
        const payload = { protocolVersion: 1, requestId: input.requestId, text: `Fixture transcript ${state.transcriptions.length}` };
        if (state.holdRecognition) {
          const release = () => { pending.delete(release); if (!response.destroyed) send(payload); };
          pending.add(release);
          response.on("close", () => { pending.delete(release); if (!response.writableEnded) state.canceledRecognition++; });
        } else send(payload);
      } else if (url === "/agent/turns") {
        const input = parseAgentRequest(parsed); state.turns.push(input);
        send({ protocolVersion: 1, conversationId: input.conversationId, turnId: input.turnId, text: agentReply(input) });
      } else {
        assert.equal(url, "/speech/syntheses"); const input = synthesisRequestSchema.parse(parsed);
        assert.equal(input.text, "Fixture agent response"); state.syntheses++;
        const samples = new Int16Array(44_100);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(2 * Math.PI * 1320 * i / 22050) * 8192);
        send({ protocolVersion: 1, requestId: input.requestId, audio: encodePcm({ samples, sampleRate: 22050, channels: 1 }) });
      }
    } catch { state.invalidRequests++; response.writeHead(500).end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { state, agentSecret, speechSecret, agentUrl: `${base}/agent`, speechUrl: `${base}/speech`,
    release() { state.holdRecognition = false; for (const release of [...pending]) release(); },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
