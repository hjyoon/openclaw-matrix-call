import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { HttpAgentAdapter } from "../dist/agent-http/index.js";
import { VoiceAssistant } from "../dist/voice/index.js";
import { MemoryConversationStore } from "../dist/core/index.js";
import { startMatrixGateway } from "./integration/matrix-gateway.mjs";
import { readLiveModel } from "./integration/live-model.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const liveModelFile = process.env.MATRIX_CALL_LIVE_MODEL_FILE;
assert(liveModelFile, "Set MATRIX_CALL_LIVE_MODEL_FILE to private access-only model settings");
const { profileId: _profile, ...live } = readLiveModel(liveModelFile);
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-live-failures-"));
const policy = { owners: ["@owner:example.org"], rooms: ["!room:example.org"], agents: ["main"] };
const reference = { roomId: policy.rooms[0], rtcSessionId: "failure-test", participantId: "failure-test" };
const proof = () => ({ ...reference, userId: policy.owners[0], deviceId: "TEST", deviceVerified: true, mediaEncrypted: true, expiresAtMs: Date.now() + 120_000 });
const request = (conversationId, turnId, text, signal) => ({ protocolVersion: 1, conversationId, turnId, agentId: "main",
  caller: proof(), messages: [{ role: "user", text, senderId: policy.owners[0], timestampMs: Date.now() }], signal });
const input = () => ({ samples: new Int16Array([100]), sampleRate: 16000, channels: 1 });
let gateway;
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const controller = new AbortController(); const conversationId = randomUUID(); const turnId = randomUUID();
  let visibleText = false;
  gateway = await startMatrixGateway({ root, directory: path.join(directory, "cancel"), policy, freePort, waitFor, liveModelFile, longReply: true,
    onAssistant(event) { if (event.runId === turnId) { visibleText = true; controller.abort(new Error("live-test-canceled")); } } });
  const agent = await HttpAgentAdapter.connect({ baseUrl: gateway.agentUrl, secret: gateway.agentSecret, timeoutMs: 120_000 });
  await gateway.modelEvidence();
  const pending = agent.reply(request(conversationId, turnId, "Explain how a tree grows in English.", controller.signal));
  const canceled = assert.rejects(pending, /live-test-canceled/);
  void canceled.catch(() => {});
  await waitFor(async () => (await gateway.modelEvidence()).sessions.some((session) => session.key.endsWith(":" + conversationId) && session.hasActiveRun), "actual model run admission");
  await gateway.subscribe(conversationId);
  await waitFor(() => visibleText, "actual model assistant text before cancellation", 75_000);
  await canceled;
  await waitFor(async () => (await gateway.modelEvidence()).sessions.some((session) => session.key.endsWith(":" + conversationId) && session.hasActiveRun === false), "actual host run settlement", 30_000);
  const recovered = await agent.reply(request(randomUUID(), randomUUID(), "Hello. Reply with a short English greeting.", new AbortController().signal));
  assert(recovered.text.trim()); assert.equal(gateway.state.providerRequests.length, 0);
  console.log(JSON.stringify({ event: "live-model-cancellation-passed", model: live.model, visibleTextBeforeAbort: true, hostSettled: true, independentTurnRecovered: true }));
  await gateway.close(); gateway = undefined;

  const broken = path.join(directory, "broken.json");
  await writeFile(broken, JSON.stringify({ ...live, credential: { ...live.credential, access: "invalid-private-test-access" } }), { mode: 0o600 });
  gateway = await startMatrixGateway({ root, directory: path.join(directory, "failure"), policy, freePort, waitFor, liveModelFile: broken });
  const unavailable = await HttpAgentAdapter.connect({ baseUrl: gateway.agentUrl, secret: gateway.agentSecret, timeoutMs: 120_000 });
  let syntheses = 0; let publications = 0;
  const store = new MemoryConversationStore(1);
  const voice = new VoiceAssistant({ policy, agentId: "main", agent: unavailable, store, timeoutMs: 120_000,
    verifier: { async verify() { return proof(); } }, recognition: { async transcribe() { return "Hello"; } },
    synthesis: { async synthesize() { syntheses++; return input(); } }, transport: { async publish() { publications++; } } });
  try {
    for (let i = 0; i < 2; i++) {
      await assert.rejects(voice.receive(reference, input()), (error) => error.code === "http-error");
      const turn = gateway.state.turns[i]; assert(turn);
      assert.equal((await store.get(turn.conversationId)).status, "closed");
      assert.equal(voice.busy, false); assert.equal(gateway.state.turns.length, i + 1);
    }
    assert.notEqual(gateway.state.turns[0].conversationId, gateway.state.turns[1].conversationId);
    assert.equal(gateway.state.replies.length, 0); assert.equal(syntheses, 0); assert.equal(publications, 0);
    assert.equal(gateway.state.providerRequests.length, 0); assert.equal(gateway.state.invalidRequests, 0);
    console.log(JSON.stringify({ event: "live-host-authentication-failure-passed", model: live.model, noSynthesis: true, noPublication: true, noAutomaticRetry: true, freshConversationAfterFailure: true }));
  } finally { await voice.endSession(); }
} finally { try { await gateway?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
