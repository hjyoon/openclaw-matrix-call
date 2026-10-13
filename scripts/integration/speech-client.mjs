import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { startTestVoiceServices } from "./voice-services.mjs";

const root = "/run/test";
const { RequestAuthenticator, MemoryConversationStore, copyPcm } = await import(pathToFileURL(path.join(root, "dist/core/index.js")));
const { HttpAgentAdapter } = await import(pathToFileURL(path.join(root, "dist/agent-http/index.js")));
const { HttpSpeechAdapter } = await import(pathToFileURL(path.join(root, "dist/speech-http/index.js")));
const { decodeWav } = await import(pathToFileURL(path.join(root, "dist/speech-worker/index.js")));
const { VoiceAssistant } = await import(pathToFileURL(path.join(root, "dist/voice/index.js")));
const secret = (await readFile("/run/secrets/voice_speech_secret", "utf8")).trim();
const baseUrl = "http://127.0.0.1:19792";
const speech = await HttpSpeechAdapter.connect({ baseUrl, secret, timeoutMs: 70_000, allowInsecureLoopback: true,
  async fetch(...args) {
    const response = await fetch(...args);
    if (response.status !== 200) console.error(JSON.stringify({ event: "speech-test-response", status: response.status, error: (await response.clone().json()).error }));
    return response;
  },
});
const manifest = JSON.parse(await readFile(path.join(root, "fixtures/manifest.json"), "utf8"));
let selected;
const services = await startTestVoiceServices(root, { agentReply: () => manifest[selected].reply });
const agent = await HttpAgentAdapter.connect({ baseUrl: services.agentUrl, secret: services.agentSecret });
const reference = { roomId: "!speech-test:example.org", rtcSessionId: "m.call#ROOM", participantId: "speech-test" };
let published;
const results = [];
const recognition = {
  async transcribe(audio, signal) {
    const start = performance.now();
    const text = await speech.transcribe(audio, signal);
    results.push({ language: selected, recognitionMs: Math.round(performance.now() - start), characters: text.length });
    for (const keyword of manifest[selected].keywords) assert(text.toLowerCase().includes(keyword), `Missing ${selected} fixture keyword`);
    return text;
  },
};
const synthesis = {
  async synthesize(text, signal) {
    assert.equal(text, manifest[selected].reply);
    const start = performance.now();
    const audio = await speech.synthesize(text, signal);
    results.at(-1).synthesisMs = Math.round(performance.now() - start);
    return audio;
  },
};
const assistant = new VoiceAssistant({
  policy: { owners: ["@fixture:example.org"], rooms: [reference.roomId], agents: ["speech-fixture"] },
  agentId: "speech-fixture", agent, recognition, synthesis, store: new MemoryConversationStore(1), timeoutMs: 90_000,
  verifier: { async verify(input) { return { ...input, userId: "@fixture:example.org", deviceId: "FIXTURE", expiresAtMs: Date.now() + 30_000, deviceVerified: true, mediaEncrypted: true }; } },
  transport: { async publish(audio) { published = copyPcm(audio); } },
});

async function waitFor(operation, message) {
  const deadline = Date.now() + 10_000;
  while (!await operation()) {
    assert(Date.now() < deadline, message);
    await setTimeout(20);
  }
}

async function enginePids() {
  const pids = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try { if ((await readFile(`/proc/${entry}/comm`, "utf8")).trim() === "whisper-cli") pids.push(entry); }
    catch {}
  }
  return pids;
}

try {
  for (const language of ["ko", "en"]) {
    selected = language;
    const bytes = await readFile(path.join(root, "fixtures", manifest[language].file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest[language].sha256);
    const audio = decodeWav(bytes);
    assert.equal(await assistant.receive(reference, audio), "replied");
    audio.samples.fill(0);
    assert(published && published.sampleRate === 22_050);
    const rms = Math.sqrt(published.samples.reduce((sum, sample) => sum + sample * sample, 0) / published.samples.length) / 32768;
    assert(rms > 0.005);
    results.at(-1).outputSeconds = published.samples.length / published.sampleRate;
    results.at(-1).outputRms = rms;
    published.samples.fill(0);
    published = undefined;
  }
  assert.equal(services.state.turns.length, 2);
  assert.equal(services.state.turns[0].conversationId, services.state.turns[1].conversationId);
  assert.equal(services.state.turns[1].messages.length, 3);
  assert.equal(services.state.invalidRequests, 0);
  assert.equal(services.state.transcriptions.length, 0);
  assert.equal(services.state.syntheses, 0);
  await assistant.endSession();

  const controller = new AbortController();
  const audio = decodeWav(await readFile(path.join(root, "fixtures/jfk-en.wav")));
  const pending = speech.transcribe(audio, controller.signal);
  const canceled = assert.rejects(pending);
  await waitFor(async () => (await enginePids()).length > 0, "Recognition child did not start");
  const health = await (await fetch(baseUrl + "/healthz")).json();
  const auth = new RequestAuthenticator({ secret, audience: health.audience });
  const body = JSON.stringify({ protocolVersion: 1, requestId: "f04fce72-ea14-4793-b704-1412f5e72520", text: "Concurrent request" });
  const busy = await fetch(baseUrl + "/syntheses", { method: "POST", body, headers: auth.sign({ method: "POST", path: "/syntheses", body }) });
  assert.equal(busy.status, 409);
  const reply = await busy.text();
  auth.verify({ method: "RESPONSE_409", path: "/syntheses", body: reply }, Object.fromEntries(busy.headers));
  controller.abort();
  await canceled;
  audio.samples.fill(0);
  await waitFor(async () => (await enginePids()).length === 0, "Canceled recognition child remains alive");
  await waitFor(async () => !(await readdir("/tmp")).some((entry) => entry.startsWith("matrix-call-speech-")), "Canceled input WAV remains on disk");
  const after = await speech.synthesize("Hello", new AbortController().signal);
  after.samples.fill(0);
  console.log(JSON.stringify({ event: "speech-integration-passed", results, canceledChild: true, busyRejected: true, inputRemoved: true,
    agent: "signed deterministic fixture", identity: "fixture", transport: "fixture" }));
} finally { await assistant.endSession(); await services.close(); }
