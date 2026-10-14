import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { startMatrixSpeechService } from "./matrix-speech-service.mjs";
import { startTestVoiceServices } from "./voice-services.mjs";
import { startMatrixGateway } from "./matrix-gateway.mjs";

const exec = promisify(execFile);

export async function verifyMatrixSpeech({ root, directory, data, config, env, peer, identity, owner, keys, waitFor, control, connect, startBrowserWorker, freePort, getDriverPage }) {
  const { decodeWav } = await import(pathToFileURL(path.join(root, "dist/speech-worker/index.js")));
  const manifest = JSON.parse(await readFile(path.join(root, "tests/fixtures/speech/manifest.json"), "utf8"));
  const speech = await startMatrixSpeechService(root, directory, process.env.MATRIX_CALL_MATRIX_SPEECH_IMAGE);
  let services;
  let worker;
  let container;
  let selected;
  let gateway;
  const nativeGateway = process.env.MATRIX_CALL_NATIVE_GATEWAY === "1";
  const liveModelFile = process.env.MATRIX_CALL_LIVE_MODEL_FILE;
  assert(!liveModelFile || nativeGateway, "Live model checks require the installed native Gateway");
  const results = [];
  const modelEvidence = [];
  const reference = { roomId: config.rooms[0], rtcSessionId: "m.call#ROOM", participantId: `${owner.userId}:${owner.deviceId}` };

  async function prepareInput() {
    await waitFor(async () => {
      try {
        const proof = worker ? await worker.driver.verify(reference, new AbortController().signal)
          : await peer.evaluate((id) => window.matrixTest.verify(id), identity);
        return proof.deviceVerified && proof.mediaEncrypted;
      }
      catch { return false; }
    }, "current Matrix microphone admission");
    await delay(300);
  }

  async function closeWorker() {
    if (gateway) { await gateway.close(); gateway = undefined; }
    if (worker) { await worker.close(); worker = undefined; }
    if (container) {
      try {
        await exec("docker", ["stop", "--time", "15", container]);
        const state = JSON.parse((await exec("docker", ["inspect", "--format", "{{json .State}}", container])).stdout);
        assert.equal(state.ExitCode, 0); assert.equal(state.OOMKilled, false);
      } finally { await exec("docker", ["rm", "--force", container]); container = undefined; }
    }
  }

  async function play(language) {
    const fixture = manifest[language];
    const bytes = await readFile(path.join(root, "tests/fixtures/speech", fixture.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
    const audio = decodeWav(bytes);
    const input = audio.samples.subarray(language === "en" ? audio.sampleRate * 5 : 0);
    const peak = input.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
    assert(peak > 0);
    const gain = 0.8 * 32767 / peak;
    const samples = Array.from(input, (value) => Math.round(value * gain));
    audio.samples.fill(0); bytes.fill(0);
    const seconds = samples.length / audio.sampleRate;
    try { await peer.evaluate((input) => window.mediaTest.playPcm(input), { samples, sampleRate: audio.sampleRate }); }
    finally { samples.fill(0); }
    return seconds;
  }

  try {
    if (!nativeGateway) services = await startTestVoiceServices(root, { agentReply: () => manifest[selected].reply });
    const agentSecretFile = path.join(data, "real-agent.secret"); const speechSecretFile = path.join(data, "real-speech.secret");
    await writeFile(speechSecretFile, speech.secret, { mode: 0o600 });
    const voiceFile = path.join(data, "real-voice.json");
    await waitFor(async () => (await peer.evaluate((id) => window.matrixTest.status(id), identity)).members === 1, "previous voice worker departure");
    for (const runtime of process.env.MATRIX_CALL_BROWSER_IMAGE ? ["native", "container"] : ["native"]) {
      const workerPort = nativeGateway ? await freePort() : undefined;
      if (nativeGateway) {
        gateway = await startMatrixGateway({ root, directory: path.join(directory, `gateway-${runtime}`),
          policy: { owners: [owner.userId], rooms: config.rooms, agents: ["main"] }, workerUrl: `http://127.0.0.1:${workerPort}`,
          controlSecretFile: env.MATRIX_CALL_SECRET_FILE, reply: () => manifest[selected].reply, freePort, waitFor, observations: services?.state, liveModelFile });
        services = gateway;
      }
      await writeFile(agentSecretFile, services.agentSecret, { mode: 0o600 });
      await writeFile(voiceFile, JSON.stringify({ agentId: nativeGateway ? "main" : "assistant", agent: { baseUrl: services.agentUrl, secretFile: agentSecretFile },
        speech: { baseUrl: speech.baseUrl, secretFile: speechSecretFile }, requestTimeoutMs: 70_000, timeoutMs: 120_000, allowInsecureLoopback: true }), { mode: 0o600 });
      const firstTurn = services.state.turns.length;
      let url;
      if (runtime === "native") {
        await writeFile(env.MATRIX_CALL_BROWSER_CONFIG, JSON.stringify({ ...config, voiceFile }));
        worker = await startBrowserWorker(nativeGateway ? { ...env, MATRIX_CALL_PORT: String(workerPort) } : env);
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
        url = `http://127.0.0.1:${worker.server.address().port}`;
      } else {
        const voice = JSON.parse(await readFile(voiceFile, "utf8"));
        voice.agent.secretFile = "/data/real-agent.secret"; voice.speech.secretFile = "/data/real-speech.secret";
        await writeFile(path.join(data, "real-container-voice.json"), JSON.stringify(voice), { mode: 0o600 });
        await writeFile(path.join(data, "real-container.json"), JSON.stringify({ ...config, credentialsFile: "/data/matrix.json", profileDir: "/data/profile",
          assetDir: "/app/assets", voiceFile: "/data/real-container-voice.json" }), { mode: 0o600 });
        const port = workerPort ?? await freePort();
        container = (await exec("docker", ["run", "--detach", "--init", "--user", `${process.getuid()}:${process.getgid()}`, "--network", "host",
          "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--security-opt", `seccomp=${path.join(root, "deployment/browser-seccomp.json")}`,
          "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--memory=768m", "--pids-limit=256", "--mount", `type=bind,src=${data},dst=/data`,
          "--env", "MATRIX_CALL_SECRET_FILE=/data/control.secret", "--env", "MATRIX_CALL_BROWSER_CONFIG=/data/real-container.json", "--env", `MATRIX_CALL_PORT=${port}`,
          process.env.MATRIX_CALL_BROWSER_IMAGE])).stdout.trim();
        url = `http://127.0.0.1:${port}`;
        await waitFor(async () => { try { return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, "real speech browser image startup", 45_000);
      }
      const request = await (gateway ? gateway.control(url) : control(url));
      const sessionId = await connect(request, container ?? null);
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
          await waitFor(async () => (await peer.evaluate((id) => window.mediaTest.measure(id), identity)).rms > 0.005, `${language} real Matrix synthesis and publication`, liveModelFile ? 100_000 : 30_000);
          let quietSince;
          await waitFor(async () => {
            const measured = await peer.evaluate((id) => window.mediaTest.measure(id), identity);
            if (measured.rms > 0.005) { quietSince = undefined; return false; }
            quietSince ??= Date.now();
            return Date.now() - quietSince >= 700 && !worker?.voice.busy;
          }, `${language} real Matrix playback completion`, 15_000);
        } finally { observation = await peer.evaluate(() => window.mediaTest.finishObservation()); }
        const turn = services.state.turns[before];
        assert.equal(turn.caller.userId, owner.userId); assert.equal(turn.caller.deviceId, owner.deviceId);
        assert.equal(turn.caller.roomId, config.rooms[0]); assert(turn.caller.deviceVerified && turn.caller.mediaEncrypted);
        const transcript = turn.messages.at(-1).text.toLowerCase();
        const keywords = language === "en" ? ["country"] : manifest[language].keywords;
        const missingKeywords = keywords.filter((keyword) => !transcript.includes(keyword));
        if (missingKeywords.length) console.error(JSON.stringify({ event: "matrix-speech-recognition-mismatch", runtime, language,
          fixture: manifest[language].file, fixtureSha256: manifest[language].sha256, inputSeconds: seconds,
          expectedKeywords: keywords, missingKeywords, recognizedCharacters: transcript.length, recognizedText: transcript.slice(0, 512) }));
        assert.equal(missingKeywords.length, 0, `Missing ${language} Matrix speech keyword`);
        assert(observation.activeFrames >= 10 && observation.peakRms > 0.005, `${language} synthesized speech must reach the Matrix peer`);
        assert.equal(observation.encryptedFrames, observation.activeFrames);
        assert.equal(services.state.turns.length, before + 1);
        if (nativeGateway) {
          assert.equal(turn.agentId, "main"); assert.equal(turn.messages.length, before === firstTurn ? 1 : 3);
          const reply = services.state.replies[before];
          assert.equal(reply.conversationId, turn.conversationId); assert.equal(reply.turnId, turn.turnId);
          if (before > firstTurn) assert.equal(turn.messages[1].text, services.state.replies[firstTurn].text);
          if (liveModelFile) {
            assert.equal(services.state.providerRequests.length, 0);
            assert(language === "ko" ? /[가-힣]/.test(reply.text) : /[a-zA-Z]/.test(reply.text), "Actual model must reply in the input language");
            const evidence = await gateway.conversationEvidence(turn.conversationId);
            assert.equal(evidence.userTurns, before - firstTurn + 1);
            const sessions = (await gateway.modelEvidence()).sessions;
            assert.equal(sessions.length, 1, "Disposable Gateway must not inherit an earlier call");
            modelEvidence.push({ runtime, language, replyCharacters: reply.text.length,
              replySha256: createHash("sha256").update(reply.text).digest("hex"), ...evidence });
          } else {
            const provider = services.state.providerRequests[before];
            assert(provider.tools === undefined || provider.tools.length === 0);
            assert(JSON.stringify(provider.messages).includes(turn.messages[0].text));
            if (before > firstTurn) {
              assert(JSON.stringify(provider.messages).includes(services.state.turns[firstTurn].messages[0].text));
              assert(JSON.stringify(provider.messages).includes(manifest.ko.reply));
              assert.equal(provider.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes(services.state.turns[firstTurn].messages[0].text)).length, 1);
            } else if (firstTurn) assert(!JSON.stringify(provider.messages).includes(services.state.turns[firstTurn - 1].messages[0].text));
          }
        }
        results.push({ runtime, language, inputStartSeconds: language === "en" ? 5 : 0, inputSeconds: seconds, peakNormalized: true, ...observation });
        console.log(JSON.stringify({ event: "matrix-speech-turn-passed", ...results.at(-1) }));
        if (worker) console.log(JSON.stringify({ event: "matrix-capture-probe", nodes: await getDriverPage().evaluate(() => window.matrixCaptureProbe) }));
      }
      assert.equal(services.state.turns[firstTurn].messages.length, 1);
      assert.equal(services.state.turns[firstTurn].conversationId, services.state.turns[firstTurn + 1].conversationId);
      assert.notEqual(services.state.turns[firstTurn].turnId, services.state.turns[firstTurn + 1].turnId);
      assert.equal(services.state.turns[firstTurn + 1].messages.length, 3);
      if (firstTurn) assert.notEqual(services.state.turns[firstTurn].conversationId, services.state.turns[firstTurn - 1].conversationId);
      assert.deepEqual(JSON.parse(await readFile(path.join(data, "profile/matrix-call-device.json"), "utf8")).keys, keys);
      if (container) {
        const probe = await readFile(path.join(root, "scripts/integration/renderer-probe.mjs"), "utf8");
        const sandbox = JSON.parse((await exec("docker", ["exec", container, "node", "--input-type=module", "-e", probe])).stdout);
        assert(sandbox.uid !== 0 && sandbox.renderers.some((renderer) => renderer.namespaces > 1 && renderer.filters >= 2 && renderer.seccomp && renderer.noNewPrivileges));
      }
      selected = "ko";
      await prepareInput();
      await play("ko");
      await waitFor(async () => await speech.engineCount() > 0, "real Matrix recognition child started", 10_000);
      if (gateway && runtime === "container") { await gateway.close(); gateway = undefined; }
      else assert.equal((await request("/v1/media/leave", { sessionId })).status, 200);
      await waitFor(async () => await speech.engineCount() === 0 && await speech.inputRemoved(), "real Matrix leave terminates recognition and removes input", 10_000);
      await closeWorker();
      assert.equal(services.state.turns.length, firstTurn + 2);
      await waitFor(async () => (await peer.evaluate((id) => window.matrixTest.status(id), identity)).members === 1, "real speech worker departure");
    }
    assert.equal(services.state.invalidRequests, 0); assert.equal(services.state.transcriptions.length, 0); assert.equal(services.state.syntheses, 0);
    if (liveModelFile) { assert.equal(modelEvidence.length, results.length); assert.equal(services.state.replies.length, services.state.turns.length); }
    const report = { model: speech.model, modelSha256: speech.modelSha256, imageId: speech.imageId, results, modelEvidence,
      verifiedMatrixCaller: true, encryptedInput: true, encryptedOutput: true, canceledRecognitionOnLeave: true,
      restoredBrowserProfile: results.some((result) => result.runtime === "container"),
      agentRuntime: liveModelFile ? "installed OpenClaw public SDK with operator-configured live model"
        : nativeGateway ? "installed OpenClaw public SDK with deterministic provider" : "signed deterministic fixture",
      nativeGatewayControl: nativeGateway, modelInference: Boolean(liveModelFile), releasedClient: false };
    await mkdir(path.join(root, ".cache/speech"), { recursive: true });
    await writeFile(path.join(root, liveModelFile ? ".cache/speech/matrix-live-integration-result.json" : ".cache/speech/matrix-integration-result.json"), JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (worker) console.log(JSON.stringify({ event: "matrix-capture-final-probe", nodes: await getDriverPage().evaluate(() => window.matrixCaptureProbe).catch(() => []) }));
    const cleanup = await Promise.allSettled([closeWorker(), services?.close(), speech.close()]);
    for (const result of cleanup) if (result.status === "rejected") throw result.reason;
  }
}
