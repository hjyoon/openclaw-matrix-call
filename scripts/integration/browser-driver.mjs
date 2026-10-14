import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startTestVoiceServices } from "./voice-services.mjs";
import { verifyMatrixSpeech } from "./matrix-speech.mjs";
import { installCaptureProbe } from "../../tests/integration/capture-probe.js";

async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}

export async function verifyBrowserDriver({ root, directory, api, waitFor, homeserver, registrationSecret, roomId, creator, owner, ownerKeys, peer, focusUrl, sfuUrl }) {
  const { startBrowserWorker, BrowserDriver } = await import(pathToFileURL(path.join(root, "dist/browser-worker/index.js")));
  const { chromium } = await import("playwright-core");
  const { RequestAuthenticator } = await import(pathToFileURL(path.join(root, "dist/core/index.js")));
  const endpoint = `${homeserver}/_synapse/admin/v1/register`;
  const { nonce } = await api(endpoint, "GET");
  const username = "workerbot";
  const password = randomBytes(32).toString("hex");
  const mac = createHmac("sha1", registrationSecret).update([nonce, username, password, "notadmin"].join("\0")).digest("hex");
  const account = await api(endpoint, "POST", { nonce, username, password, admin: false, mac });
  const credentials = { baseUrl: homeserver, userId: account.user_id, deviceId: account.device_id, accessToken: account.access_token };
  const issuedIdentity = await api(`${homeserver}/_matrix/client/v3/account/whoami`, "GET", undefined, credentials.accessToken);
  assert.equal(issuedIdentity.user_id, credentials.userId, "The new test token must belong to the registered account");
  assert.equal(issuedIdentity.device_id, credentials.deviceId, "The new test token must belong to the registered device");
  const roomPath = `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
  await api(`${roomPath}/invite`, "POST", { user_id: credentials.userId }, creator.accessToken);
  await api(`${homeserver}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, "POST", {}, credentials.accessToken);
  const power = await api(`${roomPath}/state/m.room.power_levels/`, "GET", undefined, creator.accessToken);
  await api(`${roomPath}/state/m.room.power_levels/`, "PUT", { ...power, users: { ...power.users, [credentials.userId]: 100 } }, creator.accessToken);
  await peer.reload(); await peer.waitForFunction(() => Boolean(window.matrixTest));
  await peer.evaluate((credentials) => window.matrixTest.init(credentials), owner);
  await waitFor(() => peer.evaluate((id) => window.matrixTest.prepared(id), roomId), "production-driver peer sync");
  assert.deepEqual(await peer.evaluate(() => window.matrixTest.keys()), ownerKeys, "The test owner's private keys must survive its reload");
  const data = path.join(directory, "browser-worker"); await mkdir(data, { mode: 0o700 });
  const credentialFile = path.join(data, "matrix.json");
  const secretFile = path.join(data, "control.secret");
  const configFile = path.join(data, "config.json");
  const secret = randomBytes(32).toString("hex");
  await writeFile(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  await writeFile(secretFile, secret, { mode: 0o600 });
  const config = {
    credentialsFile: credentialFile, profileDir: path.join(data, "profile"), assetDir: path.join(root, "dist/browser-worker/assets"),
    assetPort: await freePort(), owners: [owner.userId], rooms: [roomId], focusUrls: [focusUrl], sfuUrls: [sfuUrl],
    devices: [{ userId: owner.userId, deviceId: owner.deviceId, ...ownerKeys }], allowInsecureLoopback: true,
  };
  await writeFile(configFile, JSON.stringify(config));
  const env = { MATRIX_CALL_SECRET_FILE: secretFile, MATRIX_CALL_PORT: "0", MATRIX_CALL_BROWSER_CONFIG: configFile };
  let worker;
  let container;
  let peerJoined = false;
  let keys;
  let previousId;
  let voiceServices;
  let voiceConfiguration;
  let rotation = 0;
  let failure = "none";
  let driverPage;
  const network = { focusStatuses: [], failed: [], csp: false };
  const originalStart = BrowserDriver.start;
  BrowserDriver.start = (config, _launcher, captureAudio) => originalStart(config, { async launchPersistentContext(...args) {
    const context = await chromium.launchPersistentContext(...args);
    if (process.env.MATRIX_CALL_MATRIX_SPEECH_IMAGE) await context.addInitScript(installCaptureProbe);
    context.on("page", (page) => {
      driverPage = page;
      const evaluate = page.evaluate.bind(page);
      page.evaluate = async (operation, ...args) => {
        try { return await evaluate(operation, ...args); }
        catch (error) {
          if (operation.toString().includes("window.matrixCall.prepare")) {
            const codes = ["Matrix device fingerprint does not match enrollment", "Matrix crypto is unavailable", "Matrix runtime is unavailable", "TimeoutError"];
            const reason = codes.find((code) => error.message.includes(code))
              ?? error.message.split("\n")[0].replaceAll(credentials.accessToken, "[credential]").replaceAll(owner.accessToken, "[credential]").replace(/[A-Za-z0-9_.-]{32,}/g, "[redacted]").slice(0, 180);
            console.log(JSON.stringify({ event: "matrix-enrollment-failed", reason }));
          }
          throw error;
        }
      };
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).origin === new URL(focusUrl).origin) network.failed.push(request.failure()?.errorText === "net::ERR_FAILED" ? "network-failed" : "other");
      });
      page.on("response", (response) => { if (new URL(response.url()).origin === new URL(focusUrl).origin) network.focusStatuses.push(response.status()); });
      page.on("console", (message) => { if (message.text().includes("Content Security Policy")) network.csp = true; });
    });
    return context;
  } }, captureAudio);
  const identity = `${credentials.userId}:${credentials.deviceId}`;

  async function control(url) {
    const health = await (await fetch(`${url}/healthz`)).json();
    assert.equal(health.ready, false);
    const auth = new RequestAuthenticator({ secret, audience: health.audience });
    return async (pathname, value) => {
      const body = JSON.stringify(value);
      const response = await fetch(`${url}${pathname}`, { method: "POST", body, headers: auth.sign({ method: "POST", path: pathname, body }), signal: AbortSignal.timeout(35_000) });
      const result = await response.text();
      auth.verify({ method: `RESPONSE_${response.status}`, path: pathname, body: result }, Object.fromEntries(response.headers));
      return { status: response.status, value: JSON.parse(result) };
    };
  }

  async function connect(request, diagnosticContainer = container) {
    assert.equal((await request("/v1/media/join", { roomId: "!unconfigured" })).status, 403);
    const response = await request("/v1/media/join", { roomId });
    if (response.status !== 200 && diagnosticContainer) {
      const lines = execFileSync("docker", ["logs", diagnosticContainer], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n");
      for (const line of lines) { try { const record = JSON.parse(line); if (record.event === "browser-call-failed") failure = record.reason; } catch {} }
    }
    assert.equal(response.status, 200, `Production driver connection: ${failure}; network ${JSON.stringify(network)}`);
    assert.notEqual(response.value.sessionId, previousId);
    previousId = response.value.sessionId;
    await waitFor(async () => (await peer.evaluate((id) => window.matrixTest.status(id), identity)).members === 2, "production-driver Matrix membership");
    await waitFor(async () => (await peer.evaluate((id) => window.matrixTest.status(id), identity)).remoteKey, "production-driver authenticated outbound key");
    assert(await peer.evaluate((index) => window.matrixTest.rotate(index), rotation++));
    return response.value.sessionId;
  }

  async function utterance(frequency, label, pcm = false) {
    await peer.evaluate((id) => window.mediaTest.observe(id), identity);
    let observation;
    try {
      if (pcm) {
        const samples = Array.from({ length: 43_200 }, (_, i) => Math.round(Math.sin(2 * Math.PI * frequency * i / 48_000) * 8192));
        await peer.evaluate((samples) => window.mediaTest.playPcm({ samples, sampleRate: 48_000 }), samples);
        samples.fill(0);
      } else {
        await peer.evaluate((frequency) => window.mediaTest.sound(frequency), frequency);
        await delay(900);
        await peer.evaluate(() => window.mediaTest.silence());
      }
      await waitFor(async () => {
        const audio = await peer.evaluate((id) => window.mediaTest.measure(id), identity);
        return audio.encrypted && audio.rms > 0.03 && Math.abs(audio.frequency - 1320) < 35;
      }, label);
      await delay(100);
    } finally { observation = await peer.evaluate(() => window.mediaTest.finishObservation()); }
    assert(observation.activeFrames > 0);
    assert.equal(observation.encryptedFrames, observation.activeFrames);
  }

  try {
    for (let restart = 0; restart < 2; restart++) {
      worker = await startBrowserWorker(env);
      const originalConnect = worker.driver.connect.bind(worker.driver);
      worker.driver.connect = async (...args) => {
        try { await originalConnect(...args); }
        catch (error) {
          const codes = ["MatrixRTC local membership is unavailable", "MatrixRTC listener is not authorized", "MatrixRTC listener device is not verified", "Matrix listener membership changed during key rotation", "unsupported-call", "untrusted-focus", "membership-changed", "invalid-response", "untrusted-sfu", "identity-mismatch", "http-error", "signal connection", "could not establish"];
          failure = codes.find((code) => error.message.includes(code)) ?? error.message.split("\n")[0].replaceAll(credentials.accessToken, "[credential]").replaceAll(owner.accessToken, "[credential]").replace(/[A-Za-z0-9_.-]{32,}/g, "[redacted]").slice(0, 180);
          throw error;
        }
      };
      if (!keys) keys = worker.driver.deviceKeys;
      else assert.deepEqual(worker.driver.deviceKeys, keys, "Device keys must survive a production driver restart");
      assert.equal(worker.media.status().session, null, "Restart must not restore a call");
      if (!peerJoined) {
        await waitFor(() => peer.evaluate(({ userId, deviceId, keys }) => window.matrixTest.trust(userId, deviceId, keys), { ...credentials, keys }), "published production-driver device keys");
        await peer.evaluate(({ id, owners, focus }) => window.matrixTest.join(id, owners, focus), { id: roomId, owners: [owner.userId, credentials.userId], focus: focusUrl });
        peerJoined = true;
      }
      const request = await control(`http://127.0.0.1:${worker.server.address().port}`);
      const sessionId = await connect(request);
      if (restart === 0) {
        await peer.evaluate(({ focus, sfu }) => window.matrixTest.connectAuthorized(focus, sfu), { focus: focusUrl, sfu: sfuUrl });
        await peer.evaluate(() => window.mediaTest.publish(660));
      }
      const reference = { roomId, rtcSessionId: "m.call#ROOM", participantId: `${owner.userId}:${owner.deviceId}` };
      await waitFor(async () => {
        try { const proof = await worker.driver.verify(reference, new AbortController().signal); return proof.userId === owner.userId && proof.deviceVerified && proof.mediaEncrypted; }
        catch { return false; }
      }, "production-driver authenticated inbound participant");
      const frequency = restart === 0 ? 880 : 1100;
      const samples = new Int16Array(48_000 * 3);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(2 * Math.PI * frequency * i / 48_000) * 8192);
      await Promise.all([
        worker.driver.publish({ samples, sampleRate: 48_000, channels: 1 }, new AbortController().signal),
        waitFor(async () => { const audio = await peer.evaluate((id) => window.mediaTest.measure(id), identity); return audio.encrypted && audio.rms > 0.03 && Math.abs(audio.frequency - frequency) < 35; }, "production-driver PCM audio"),
      ]);
      assert.equal((await request("/v1/media/leave", { sessionId })).status, 200);
      await worker.close(); worker = undefined;
      await waitFor(async () => (await peer.evaluate((id) => window.matrixTest.status(id), identity)).members === 1, "production-driver departure");
    }
    await peer.evaluate(() => window.mediaTest.silence());
    voiceServices = await startTestVoiceServices(root);
    await writeFile(path.join(data, "agent.secret"), voiceServices.agentSecret, { mode: 0o600 });
    await writeFile(path.join(data, "speech.secret"), voiceServices.speechSecret, { mode: 0o600 });
    voiceConfiguration = { agentId: "assistant", agent: { baseUrl: voiceServices.agentUrl, secretFile: path.join(data, "agent.secret") },
      speech: { baseUrl: voiceServices.speechUrl, secretFile: path.join(data, "speech.secret") }, allowInsecureLoopback: true };
    const voiceFile = path.join(data, "voice.json"); await writeFile(voiceFile, JSON.stringify(voiceConfiguration));
    await writeFile(configFile, JSON.stringify({ ...config, voiceFile }));
    worker = await startBrowserWorker(env); assert(worker.voice, "Voice must be explicitly configured");
    const request = await control(`http://127.0.0.1:${worker.server.address().port}`);
    let sessionId = await connect(request);
    await utterance(660, "encrypted audio to speech, agent and synthesized PCM", true);
    await waitFor(() => !worker.voice.busy, "first voice turn completion");
    assert.equal(voiceServices.state.turns.length, 1);
    assert(Math.abs(voiceServices.state.transcriptions[0].frequency - 660) < 45);
    assert.equal(voiceServices.state.turns[0].caller.userId, owner.userId);
    assert.equal(voiceServices.state.turns[0].caller.deviceId, owner.deviceId);
    await utterance(770, "second half-duplex voice turn");
    await waitFor(() => !worker.voice.busy, "second voice turn completion");
    assert.equal(voiceServices.state.turns.length, 2);
    assert.equal(voiceServices.state.turns[0].conversationId, voiceServices.state.turns[1].conversationId);
    assert.notEqual(voiceServices.state.turns[0].turnId, voiceServices.state.turns[1].turnId);
    assert.equal(voiceServices.state.turns[1].messages.length, 3);
    voiceServices.state.holdRecognition = true;
    await peer.evaluate(() => window.mediaTest.sound(880)); await delay(900); await peer.evaluate(() => window.mediaTest.silence());
    await waitFor(() => voiceServices.state.transcriptions.length === 3, "pending real speech HTTP request");
    assert.equal((await request("/v1/media/leave", { sessionId })).status, 200);
    await waitFor(() => voiceServices.state.canceledRecognition === 1, "speech HTTP cancellation on leave");
    voiceServices.release(); assert.equal(voiceServices.state.turns.length, 2);
    await worker.close(); worker = undefined;
    await waitFor(async () => (await peer.evaluate((id) => window.matrixTest.status(id), identity)).members === 1, "voice worker departure");
    let containerChecked = false;
    if (process.env.MATRIX_CALL_BROWSER_IMAGE) {
      const containerVoice = { ...voiceConfiguration, agent: { ...voiceConfiguration.agent, secretFile: "/data/agent.secret" }, speech: { ...voiceConfiguration.speech, secretFile: "/data/speech.secret" } };
      await writeFile(path.join(data, "container-voice.json"), JSON.stringify(containerVoice));
      const containerConfig = { ...config, credentialsFile: "/data/matrix.json", profileDir: "/data/profile", assetDir: "/app/assets", voiceFile: "/data/container-voice.json" };
      await writeFile(path.join(data, "container.json"), JSON.stringify(containerConfig));
      const port = await freePort();
      container = `matrix-call-browser-${randomUUID()}`;
      execFileSync("docker", ["run", "--detach", "--name", container, "--init", "--user", `${process.getuid()}:${process.getgid()}`, "--network", "host", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${path.join(root, "deployment/browser-seccomp.json")}`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--memory", "768m", "--pids-limit", "256", "--mount", `type=bind,source=${data},target=/data`, "--env", "MATRIX_CALL_SECRET_FILE=/data/control.secret", "--env", "MATRIX_CALL_BROWSER_CONFIG=/data/container.json", "--env", `MATRIX_CALL_PORT=${port}`, process.env.MATRIX_CALL_BROWSER_IMAGE], { stdio: "pipe" });
      const url = `http://127.0.0.1:${port}`;
      await waitFor(async () => { try { return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, "browser image startup", 45_000);
      const request = await control(url);
      const sessionId = await connect(request);
      await utterance(660, "voice pipeline inside the browser container");
      assert.equal(voiceServices.state.turns.length, 3);
      assert.notEqual(voiceServices.state.turns[2].conversationId, voiceServices.state.turns[1].conversationId);
      assert.equal(voiceServices.state.turns[2].messages.length, 1);
      const probe = await readFile(path.join(root, "scripts/integration/renderer-probe.mjs"), "utf8");
      const sandbox = JSON.parse(execFileSync("docker", ["exec", container, "node", "--input-type=module", "-e", probe], { encoding: "utf8" }));
      assert(sandbox.uid !== 0 && sandbox.renderers.some((renderer) => renderer.namespaces > 1 && renderer.filters >= 2 && renderer.seccomp && renderer.noNewPrivileges), `The production renderer must retain PID and seccomp isolation: ${JSON.stringify(sandbox)}`);
      const manifest = JSON.parse(await readFile(path.join(data, "profile/matrix-call-device.json"), "utf8"));
      assert.deepEqual(manifest.keys, keys);
      assert.equal((await request("/v1/media/leave", { sessionId })).status, 200);
      execFileSync("docker", ["stop", "--time", "15", container], { stdio: "pipe" });
      const state = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .State}}", container], { encoding: "utf8" }));
      assert.equal(state.ExitCode, 0); assert.equal(state.OOMKilled, false);
      containerChecked = true;
    }
    assert.equal(voiceServices.state.invalidRequests, 0);
    const realSpeech = process.env.MATRIX_CALL_MATRIX_SPEECH_IMAGE ? await verifyMatrixSpeech({ root, directory, data, config, env, peer, identity,
      owner, keys, waitFor, control, connect, startBrowserWorker, freePort, getDriverPage: () => driverPage }) : undefined;
    return { productionBrowserDriver: true, persistentDeviceBinding: true, pcmPublication: true, voicePipeline: true,
      speechModel: "protocol-fixture", agentRuntime: "protocol-fixture", browserContainer: containerChecked, realSpeech };
  } finally {
    BrowserDriver.start = originalStart;
    await worker?.close();
    await voiceServices?.close();
    if (container) execFileSync("docker", ["rm", "--force", container], { stdio: "pipe" });
    if (peerJoined) await peer.evaluate(async () => { await window.matrixTest.leave(); await window.mediaTest.close(); });
  }
}
