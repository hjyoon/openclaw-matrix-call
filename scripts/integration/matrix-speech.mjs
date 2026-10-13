import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { startMatrixSpeechService } from "./matrix-speech-service.mjs";
import { startTestVoiceServices } from "./voice-services.mjs";

export async function verifyMatrixSpeech({ root, directory, data, config, env, peer, identity, owner, waitFor, control, connect, startBrowserWorker }) {
  const { decodeWav } = await import(pathToFileURL(path.join(root, "dist/speech-worker/index.js")));
  const manifest = JSON.parse(await readFile(path.join(root, "tests/fixtures/speech/manifest.json"), "utf8"));
  const speech = await startMatrixSpeechService(root, directory, process.env.MATRIX_CALL_MATRIX_SPEECH_IMAGE);
  let services;
  let worker;
  let selected;
  const results = [];
  const reference = { roomId: config.rooms[0], rtcSessionId: "m.call#ROOM", participantId: `${owner.userId}:${owner.deviceId}` };

  async function prepareInput() {
    await waitFor(async () => {
      try { const proof = await worker.driver.verify(reference, new AbortController().signal); return proof.deviceVerified && proof.mediaEncrypted; }
      catch { return false; }
    }, "current Matrix microphone admission");
    await delay(300);
  }

  async function play(language) {
    const fixture = manifest[language];
    const bytes = await readFile(path.join(root, "tests/fixtures/speech", fixture.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
    const audio = decodeWav(bytes);
    const samples = Array.from(audio.samples.subarray(0, language === "en" ? Math.round(audio.sampleRate * 2.6) : audio.samples.length));
    audio.samples.fill(0); bytes.fill(0);
    const seconds = samples.length / audio.sampleRate;
    try { await peer.evaluate((input) => window.mediaTest.playPcm(input), { samples, sampleRate: audio.sampleRate }); }
    finally { samples.fill(0); }
    return seconds;
  }

  try {
    services = await startTestVoiceServices(root, { agentReply: () => manifest[selected].reply });
    const agentSecretFile = path.join(data, "real-agent.secret"); const speechSecretFile = path.join(data, "real-speech.secret");
    await writeFile(agentSecretFile, services.agentSecret, { mode: 0o600 });
    await writeFile(speechSecretFile, speech.secret, { mode: 0o600 });
    const voiceFile = path.join(data, "real-voice.json");
    await writeFile(voiceFile, JSON.stringify({ agentId: "assistant", agent: { baseUrl: services.agentUrl, secretFile: agentSecretFile },
      speech: { baseUrl: speech.baseUrl, secretFile: speechSecretFile }, requestTimeoutMs: 70_000, timeoutMs: 120_000, allowInsecureLoopback: true }), { mode: 0o600 });
    await waitFor(async () => (await peer.evaluate((id) => window.matrixTest.status(id), identity)).members === 1, "previous voice worker departure");
    await writeFile(env.MATRIX_CALL_BROWSER_CONFIG, JSON.stringify({ ...config, voiceFile }));
    worker = await startBrowserWorker(env);
    assert(worker.voice);
    const receive = worker.voice.receive.bind(worker.voice);
    worker.voice.receive = async (...args) => {
      console.log(JSON.stringify({ event: "matrix-speech-input-admitted", sampleRate: args[1].sampleRate, seconds: args[1].samples.length / args[1].sampleRate }));
      try { return await receive(...args); }
      catch (error) {
        console.log(JSON.stringify({ event: error.code === "call-closed" ? "matrix-speech-turn-canceled" : "matrix-speech-turn-failed", errorType: error.name, code: error.code ?? "unknown" }));
        throw error;
      }
    };
    const request = await control(`http://127.0.0.1:${worker.server.address().port}`);
    const sessionId = await connect(request);
    await prepareInput();

    for (const language of ["ko", "en"]) {
      selected = language;
      const before = services.state.turns.length;
      await prepareInput();
      await peer.evaluate((id) => window.mediaTest.observe(id), identity);
      let observation;
      let seconds;
      try {
        seconds = await play(language);
        await waitFor(() => services.state.turns.length === before + 1, `${language} real Matrix recognition and agent dispatch`, 90_000);
        await waitFor(() => !worker.voice.busy, `${language} real Matrix synthesis and publication`, 30_000);
        await delay(700);
      } finally { observation = await peer.evaluate(() => window.mediaTest.finishObservation()); }
      const turn = services.state.turns[before];
      assert.equal(turn.caller.userId, owner.userId); assert.equal(turn.caller.deviceId, owner.deviceId);
      assert.equal(turn.caller.roomId, config.rooms[0]); assert(turn.caller.deviceVerified && turn.caller.mediaEncrypted);
      const transcript = turn.messages.at(-1).text.toLowerCase();
      for (const keyword of language === "en" ? ["americans"] : manifest[language].keywords) assert(transcript.includes(keyword), `Missing ${language} Matrix speech keyword`);
      assert(observation.activeFrames >= 10 && observation.peakRms > 0.005, `${language} synthesized speech must reach the Matrix peer`);
      assert.equal(observation.encryptedFrames, observation.activeFrames);
      assert.equal(services.state.turns.length, before + 1);
      results.push({ runtime: "native", language, inputSeconds: seconds, ...observation });
      console.log(JSON.stringify({ event: "matrix-speech-turn-passed", ...results.at(-1) }));
    }
    assert.equal(services.state.turns[0].conversationId, services.state.turns[1].conversationId);
    assert.notEqual(services.state.turns[0].turnId, services.state.turns[1].turnId);
    assert.equal(services.state.turns[1].messages.length, 3);
    selected = "ko";
    await prepareInput();
    await play("ko");
    await waitFor(async () => await speech.engineCount() > 0, "real Matrix recognition child started", 10_000);
    assert.equal((await request("/v1/media/leave", { sessionId })).status, 200);
    await waitFor(async () => await speech.engineCount() === 0 && await speech.inputRemoved(), "real Matrix leave terminates recognition and removes input", 10_000);
    await worker.close(); worker = undefined;
    assert.equal(services.state.turns.length, 2);
    assert.equal(services.state.invalidRequests, 0); assert.equal(services.state.transcriptions.length, 0); assert.equal(services.state.syntheses, 0);
    const report = { model: speech.model, modelSha256: speech.modelSha256, imageId: speech.imageId, results,
      verifiedMatrixCaller: true, encryptedInput: true, encryptedOutput: true, canceledRecognitionOnLeave: true,
      agentRuntime: "signed deterministic fixture", releasedClient: false };
    await mkdir(path.join(root, ".cache/speech"), { recursive: true });
    await writeFile(path.join(root, ".cache/speech/matrix-integration-result.json"), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await worker?.close();
    await services?.close();
    await speech.close();
  }
}
