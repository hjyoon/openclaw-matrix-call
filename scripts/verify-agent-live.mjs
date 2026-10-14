import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { HttpAgentAdapter } from "../dist/agent-http/index.js";
import { startMatrixGateway } from "./integration/matrix-gateway.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const liveModelFile = process.env.MATRIX_CALL_LIVE_MODEL_FILE;
assert(liveModelFile, "Set MATRIX_CALL_LIVE_MODEL_FILE to private access-only model settings");
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-live-agent-"));
let gateway;
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const policy = { owners: ["@owner:example.org"], rooms: ["!room:example.org"], agents: ["main"] };
  gateway = await startMatrixGateway({ root, directory: path.join(directory, "gateway"), policy, freePort, waitFor, liveModelFile });
  const agent = await HttpAgentAdapter.connect({ baseUrl: gateway.agentUrl, secret: gateway.agentSecret, timeoutMs: 120_000 });
  const results = [];
  const conversations = { ko: randomUUID(), en: randomUUID() };
  const memoryCode = "copper-" + randomUUID().slice(0, 8);
  for (const [language, text, recall] of [
    ["ko", `안녕하세요. 기억 코드 ${memoryCode}를 기억하고, 한국어로 짧은 인사 한 문장만 답해주세요.`, false],
    ["en", "Hello. Reply with one short greeting in English.", false],
    ["ko", "앞서 알려준 기억 코드만 그대로 답해주세요.", true],
  ]) {
    const started = Date.now();
    const reply = await agent.reply({ protocolVersion: 1, conversationId: conversations[language], turnId: randomUUID(), agentId: "main",
      caller: { userId: policy.owners[0], roomId: policy.rooms[0], deviceId: "TEST", rtcSessionId: "live-text", participantId: "live-text",
        deviceVerified: true, mediaEncrypted: true, expiresAtMs: Date.now() + 120_000 },
      messages: [{ role: "user", text, senderId: policy.owners[0], timestampMs: Date.now() }], signal: new AbortController().signal });
    assert(reply.text.trim());
    if (recall) assert(reply.text.includes(memoryCode), "The actual model must recall host-session history");
    else assert(language === "ko" ? /[가-힣]/.test(reply.text) : /[a-zA-Z]/.test(reply.text));
    results.push({ language, durationMs: Date.now() - started, characters: reply.text.length, replySha256: createHash("sha256").update(reply.text).digest("hex") });
    console.log(JSON.stringify({ event: "live-agent-turn-passed", model: gateway.model, ...results.at(-1) }));
  }
  const evidence = await gateway.modelEvidence();
  const sessions = evidence.sessions.filter((session) => Object.values(conversations).some((id) => session.key.endsWith(":" + id)));
  assert.equal(sessions.length, 2);
  for (const session of sessions) {
    assert.equal(session.modelProvider + "/" + session.model, gateway.model);
    assert(session.outputTokens > 0);
  }
  console.log(JSON.stringify({ event: "live-agent-model-evidence", sessions: sessions.map((session) => ({ model: session.model, provider: session.modelProvider,
    inputTokens: session.inputTokens, outputTokens: session.outputTokens, totalTokens: session.totalTokens, agentRuntime: session.agentRuntime?.id })) }));
  assert.equal(gateway.state.providerRequests.length, 0);
  assert.equal(gateway.state.turns.length, 3); assert.equal(gateway.state.replies.length, 3); assert.equal(gateway.state.invalidRequests, 0);
  for (const conversationId of Object.values(conversations)) {
    console.log(JSON.stringify({ event: "live-agent-history-passed", ...await gateway.conversationEvidence(conversationId) }));
  }
} finally { try { await gateway?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
