import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { startReleasedClient } from "./released-client.mjs";
import { startMatrixGateway } from "./matrix-gateway.mjs";
import { startMatrixSpeechService } from "./matrix-speech-service.mjs";
import { provisionMatrixChat } from "./matrix-chat.mjs";
import { decodeWav } from "../../dist/speech-worker/index.js";
import { startReleasedWorker } from "./released-worker.mjs";

async function freePort() { const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }

export async function verifyReleasedCall({ root, directory, chromium, api, waitFor, homeserver, serverName, registrationSecret, roomId, creator, focusUrl, sfuUrl }) {
  const data = path.join(directory, "released-call"); await mkdir(data, { mode: 0o700 });
  const register = async (username) => {
    const endpoint = `${homeserver}/_synapse/admin/v1/register`; const { nonce } = await api(endpoint, "GET"); const password = randomBytes(32).toString("hex");
    const mac = createHmac("sha1", registrationSecret).update([nonce, username, password, "notadmin"].join("\0")).digest("hex");
    const account = await api(endpoint, "POST", { nonce, username, password, admin: false, mac });
    const identity = await api(`${homeserver}/_matrix/client/v3/account/whoami`, "GET", undefined, account.access_token);
    assert.equal(identity.user_id, account.user_id); assert.equal(identity.device_id, account.device_id);
    await api(`${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, "POST", { user_id: account.user_id }, creator.accessToken);
    await api(`${homeserver}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, "POST", {}, account.access_token);
    return account;
  };
  const owner = await register("releasedowner"); const bot = await register("releasedworker");
  const roomPath = `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
  const power = await api(roomPath + "/state/m.room.power_levels/", "GET", undefined, creator.accessToken);
  await api(roomPath + "/state/m.room.power_levels/", "PUT", { ...power, users: { ...power.users, [owner.user_id]: 100, [bot.user_id]: 100 } }, creator.accessToken);
  let app; let speech; let gateway; let worker; let selected; let failure; let report; let replacement;
  const results = [];
  const liveModelFile = process.env.MATRIX_CALL_LIVE_MODEL_FILE;
  const manifest = JSON.parse(await readFile(path.join(root, "tests/fixtures/speech/manifest.json"), "utf8"));
  try {
    app = await startReleasedClient({ root, directory: data, chromium, account: owner, homeserver, serverName, focusUrl, roomId });
    const matrixChat = await provisionMatrixChat({ api, homeserver, registrationSecret, roomId, creator,
      owner: { userId: owner.user_id, accessToken: owner.access_token }, chatPeer: app.chat, username: "releasedchat" });
    speech = await startMatrixSpeechService(root, data, process.env.MATRIX_CALL_MATRIX_SPEECH_IMAGE);
    const credentialsFile = path.join(data, "matrix.json"); const controlSecretFile = path.join(data, "control.secret");
    const agentSecretFile = path.join(data, "agent.secret"); const speechSecretFile = path.join(data, "speech.secret"); const voiceFile = path.join(data, "voice.json"); const configFile = path.join(data, "browser.json");
    await writeFile(credentialsFile, JSON.stringify({ baseUrl: homeserver, userId: bot.user_id, deviceId: bot.device_id, accessToken: bot.access_token }), { mode: 0o600 });
    await writeFile(controlSecretFile, randomBytes(32).toString("hex"), { mode: 0o600 }); const workerPort = speech.composition?.controlPort ?? await freePort();
    gateway = await startMatrixGateway({ root, directory: path.join(data, "gateway"), policy: { owners: [owner.user_id], rooms: [roomId], agents: ["main"] },
      workerUrl: `http://127.0.0.1:${workerPort}`, controlSecretFile, reply: () => manifest[selected].reply, freePort, waitFor, matrixChat, liveModelFile });
    await writeFile(agentSecretFile, gateway.agentSecret, { mode: 0o600 }); await writeFile(speechSecretFile, speech.secret, { mode: 0o600 });
    await writeFile(voiceFile, JSON.stringify({ agentId: "main", agent: { baseUrl: gateway.agentUrl, secretFile: agentSecretFile },
      speech: { baseUrl: speech.baseUrl, secretFile: speechSecretFile }, requestTimeoutMs: 70000, timeoutMs: 120000, allowInsecureLoopback: true }), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ credentialsFile, profileDir: path.join(data, "worker-profile"), assetDir: path.join(root, "dist/browser-worker/assets"),
      assetPort: await freePort(), owners: [owner.user_id], rooms: [roomId], focusUrls: [focusUrl], sfuUrls: [sfuUrl],
      devices: [{ userId: owner.user_id, deviceId: owner.device_id, ...app.keys }], allowInsecureLoopback: true, voiceFile }), { mode: 0o600 });
    worker = await startReleasedWorker({ root, data, configFile, controlSecretFile, port: workerPort, waitFor, composition: speech.composition });
    await waitFor(() => app.page.evaluate(async ({ bot, keys, roomId }) => {
      const client = window.matrixclient; const crypto = client.getCrypto(); crypto.prepareToEncrypt(client.getRoom(roomId));
      const device = (await crypto.getUserDeviceInfo([bot.user_id], false)).get(bot.user_id)?.get(bot.device_id);
      if (!device) return false;
      if (device.getFingerprint() !== keys.ed25519 || device.getIdentityKey() !== keys.curve25519) throw new Error("Released-client worker fingerprint mismatch");
      await crypto.setDeviceVerified(bot.user_id, bot.device_id, true); return true;
    }, { bot: { user_id: bot.user_id, device_id: bot.device_id }, keys: worker.driver.deviceKeys, roomId }), "released-client worker enrollment");
    await app.page.getByRole("button", { name: "Join call", exact: true }).click();
    await waitFor(() => app.page.evaluate((id) => window.matrixclient.matrixRTC.getRoomSession(window.matrixclient.getRoom(id)).memberships.length === 1, roomId), "released-client RTC membership");
    let request = await gateway.control(`http://127.0.0.1:${workerPort}`);
    assert.equal((await request("/v1/media/status", {})).status, 200);
    assert.equal((await request("/v1/media/join", { roomId: "!unconfigured" })).status, 403);
    console.log(JSON.stringify({ event: "released-client-transports", ...await app.page.evaluate((id) => {
      const session = window.matrixclient.matrixRTC.getRoomSession(window.matrixclient.getRoom(id));
      return { slot: session.slotId, memberships: session.memberships.map((member) => {
        const transport = member.getTransport(member);
        return { transportType: transport?.type, alias: transport?.livekit_alias, service: transport?.livekit_service_url, membershipId: member.membershipID };
      }) };
    }, roomId) }));
    let joined = await request("/v1/media/join", { roomId }); assert.equal(joined.status, 200);
    const mediaSessions = [joined.value.sessionId]; const conversations = [];
    const reference = { roomId, rtcSessionId: "m.call#ROOM", participantId: `${owner.user_id}:${owner.device_id}` };
    await waitFor(async () => {
      try { const proof = await worker.driver.verify(reference, new AbortController().signal); return proof.userId === owner.user_id && proof.deviceId === owner.device_id && proof.deviceVerified && proof.mediaEncrypted; }
      catch { return false; }
    }, "released-client encrypted microphone admission");
    for (const [index, language] of ["ko", "en", "ko"].entries()) {
      if (index === 2) {
        assert.equal((await request("/v1/media/status", {})).value.session.state, "connected");
        assert.equal((await request("/v1/media/leave", { sessionId: randomUUID() })).status, 404);
        assert.equal((await request("/v1/media/leave", { sessionId: joined.value.sessionId })).status, 200);
        await app.page.getByRole("button", { name: "End call", exact: true }).click();
        if (speech.composition && process.env.MATRIX_CALL_OPERATOR_REPLACEMENT !== "0") {
          const keys = worker.driver.deviceKeys; const before = gateway.state.providerRequests.length;
          await worker.close(); worker = undefined;
          replacement = { ...await gateway.restart(), ...await speech.restart() };
          const voice = JSON.parse(await readFile(voiceFile, "utf8")); voice.speech.baseUrl = speech.baseUrl;
          await writeFile(voiceFile, JSON.stringify(voice), { mode: 0o600 });
          worker = await startReleasedWorker({ root, data, configFile, controlSecretFile, port: workerPort, waitFor, composition: speech.composition });
          assert.deepEqual(worker.driver.deviceKeys, keys);
          request = await gateway.control(`http://127.0.0.1:${workerPort}`);
          assert.equal((await request("/v1/media/status", {})).value.session, null);
          assert.equal(gateway.state.providerRequests.length, before);
          replacement = { ...replacement, persistentWorkerDevice: true, noAutomaticCallOrModelReplay: true };
          console.log(JSON.stringify({ event: "operator-replacement-passed", ...replacement }));
        }
        await app.page.goto(app.url); await app.page.getByRole("button", { name: "Join call", exact: true }).waitFor();
        assert.deepEqual(await app.page.evaluate(() => window.matrixclient.getCrypto().getOwnDeviceKeys()), app.keys);
        await app.page.getByRole("button", { name: "Join call", exact: true }).click();
        await waitFor(() => app.page.evaluate((id) => window.matrixclient.matrixRTC.getRoomSession(window.matrixclient.getRoom(id)).memberships.length === 1, roomId), "released-client rejoin membership");
        joined = await request("/v1/media/join", { roomId }); assert.equal(joined.status, 200);
        assert.notEqual(joined.value.sessionId, mediaSessions[0]); mediaSessions.push(joined.value.sessionId);
        await waitFor(async () => {
          try { return (await worker.driver.verify(reference, new AbortController().signal)).mediaEncrypted; } catch { return false; }
        }, "released-client encrypted microphone after rejoin");
      }
      selected = language; const before = gateway.state.turns.length; const started = Date.now();
      const bytes = await readFile(path.join(root, "tests/fixtures/speech", manifest[language].file)); assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest[language].sha256);
      const audio = decodeWav(bytes); const input = audio.samples.subarray(language === "en" ? audio.sampleRate * 5 : 0);
      const peak = input.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0); const samples = Array.from(input, (value) => Math.round(value * 0.8 * 32767 / peak));
      audio.samples.fill(0); bytes.fill(0);
      try { await app.page.evaluate((audio) => window.releasedMicrophone.play(audio), { samples, sampleRate: audio.sampleRate }); }
      finally { samples.fill(0); }
      await waitFor(() => gateway.state.turns.length === before + 1, "released-client recognition and SDK dispatch", 90000);
      let peakRms = 0;
      await waitFor(async () => { const audio = await app.page.evaluate(() => window.releasedMicrophone.measure()); peakRms = Math.max(peakRms, audio.rms); return audio.rms > 0.005; }, "released-client synthesized audio", liveModelFile ? 100000 : 30000);
      const firstAudioMs = Date.now() - started;
      await worker.waitForPlayback(replacement && index === 2 ? 1 : index + 1);
      const turn = gateway.state.turns[before]; const text = turn.messages.at(-1).text.toLowerCase();
      assert((language === "en" ? ["country"] : manifest[language].keywords).every((keyword) => text.includes(keyword)));
      assert.equal(turn.caller.userId, owner.user_id); assert.equal(turn.caller.deviceId, owner.device_id); assert(turn.caller.deviceVerified && turn.caller.mediaEncrypted);
      const history = await gateway.conversationEvidence(turn.conversationId); assert.equal(history.userTurns, index === 2 ? 1 : index + 1);
      const reply = gateway.state.replies[before];
      if (liveModelFile) {
        assert.equal(gateway.state.providerRequests.length, 0);
        assert(language === "ko" ? /[가-힣]/.test(reply.text) : /[a-zA-Z]/.test(reply.text));
      }
      if (index === 0 || index === 2) conversations.push(turn.conversationId);
      if (index === 2) { assert.notEqual(conversations[0], conversations[1]); assert.equal(turn.messages.length, 1); }
      results.push({ call: index === 2 ? 2 : 1, language, peakRms, firstAudioMs, input: speech.state.inputs.at(-1),
        replyCharacters: reply.text.length, replySha256: createHash("sha256").update(reply.text).digest("hex"), ...history });
      console.log(JSON.stringify({ event: "released-client-speech-passed", client: app.pin.name, version: app.pin.version, ...results.at(-1) }));
    }
    assert.equal((await request("/v1/media/status", {})).value.session.state, "connected");
    assert.equal((await request("/v1/media/leave", { sessionId: joined.value.sessionId })).status, 200);
    assert.equal((await request("/v1/media/status", {})).value.session, null);
    await app.page.getByRole("button", { name: "End call", exact: true }).click();
    assert.equal(new Set(conversations).size, 2); assert.equal(gateway.state.turns.length, 3); assert.equal(gateway.state.providerRequests.length, liveModelFile ? 0 : 3);
    assert.equal((await gateway.modelEvidence()).sessions.filter((session) => session.key.startsWith("agent:main:matrix-call:call:")).length, 2);
    const commands = replacement ? 11 : 10;
    assert.deepEqual(matrixChat.evidence, { commands, replies: commands, encryptedCommands: commands, encryptedReplies: commands });
    await worker.verifySandbox();
    report = { client: app.pin.name, version: app.pin.version, artifactSha256: app.pin.sha256, mode: "standalone compatibility", worker: worker.evidence, perParticipantE2EE: true,
      microphone: "controlled browser MediaStream fixture", engines: "real local CPU speech",
      agent: liveModelFile ? "installed Gateway with operator-configured live model" : "installed Gateway with deterministic provider", results,
      leaveAndRejoin: true, persistentClientDevice: true, independentCallHistory: true, encryptedMatrixChat: matrixChat.evidence,
      coordinatedReplacement: replacement, modelInference: Boolean(liveModelFile) };
  } catch (error) {
    failure = error;
    console.log(JSON.stringify({ event: "released-client-call-failed", stage: worker ? "media" : app ? "worker setup" : "client setup", results: results.length,
      diagnostics: app?.diagnostics, worker: await worker?.diagnostics().catch(() => ({ unavailable: true })),
      agentRequests: gateway?.state.turns.length, agentReplies: gateway?.state.replies.length,
      speechInputs: speech?.state.inputs.length, syntheses: speech?.state.syntheses.length,
      body: await app?.page.locator("body").innerText().then((text) => text.slice(0, 500)).catch(() => "unavailable") }));
  } finally {
    const cleanup = await Promise.allSettled([gateway?.close(), worker?.close(), speech?.close(), app?.close()]);
    const rejected = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (rejected.length) failure = new AggregateError([...(failure ? [failure] : []), ...rejected], "Released-client verification cleanup failed");
  }
  if (failure) throw failure;
  await mkdir(path.join(root, ".cache/speech"), { recursive: true });
  const filename = `released-client${process.env.MATRIX_CALL_OPERATOR_COMPOSE === "1" ? "-operator" : process.env.MATRIX_CALL_RELEASED_BROWSER_IMAGE ? "-image" : ""}${liveModelFile ? "-live" : ""}-result.json`;
  await writeFile(path.join(root, ".cache/speech", filename), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ event: "released-client-call-passed", ...report }));
  return report;
}
