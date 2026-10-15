import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { startTestVoiceServices } from "./voice-services.mjs";

export async function verifyOutboundCall({ root, directory, chromium, api, waitFor, homeserver, registrationSecret, origin, focusUrl, sfuUrl }) {
  const selfCalls = process.env.MATRIX_CALL_SELF_CALLS === "1";
  const { startBrowserWorker } = await import(pathToFileURL(path.join(root, "dist/browser-worker/index.js")));
  const { WorkerHttpClient } = await import(pathToFileURL(path.join(root, "dist/worker/index.js")));
  const accounts = [];
  for (const username of ["outboundbot", "recipient"]) {
    const endpoint = `${homeserver}/_synapse/admin/v1/register`;
    const { nonce } = await api(endpoint, "GET");
    const password = randomBytes(32).toString("hex");
    const mac = createHmac("sha1", registrationSecret).update([nonce, username, password, "notadmin"].join("\0")).digest("hex");
    const account = await api(endpoint, "POST", { nonce, username, password, admin: false, mac });
    accounts.push({ baseUrl: homeserver, userId: account.user_id, deviceId: account.device_id, accessToken: account.access_token });
  }
  const [bot, recipient] = accounts;
  const { room_id: roomId } = await api(`${homeserver}/_matrix/client/v3/createRoom`, "POST", {
    preset: "private_chat", invite: [bot.userId],
    initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    power_level_content_override: { users: { [bot.userId]: 100 } },
  }, recipient.accessToken);
  await api(`${homeserver}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, "POST", {}, bot.accessToken);
  const baselineRoom = selfCalls ? await api(`${homeserver}/_matrix/client/v3/createRoom`, "POST", { preset: "private_chat", initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }] }, bot.accessToken) : undefined;
  const data = path.join(directory, "outbound"); await mkdir(data, { mode: 0o700 });
  const context = await chromium.launchPersistentContext(path.join(data, "recipient"), { headless: true, chromiumSandbox: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  let worker;
  let services;
  const signal = () => AbortSignal.timeout(90_000);
  try {
    const peer = context.pages()[0]; await peer.goto(origin);
    await peer.waitForFunction(() => Boolean(window.matrixTest));
    await peer.evaluate((credentials) => window.matrixTest.init(credentials), recipient);
    await waitFor(() => peer.evaluate((id) => window.matrixTest.prepared(id), roomId), "outbound recipient sync");
    const keys = await peer.evaluate(() => window.matrixTest.keys());
    services = await startTestVoiceServices(root);
    const files = { credentialsFile: path.join(data, "matrix.json"), secret: path.join(data, "control.secret"),
      agent: path.join(data, "agent.secret"), speech: path.join(data, "speech.secret"), voiceFile: path.join(data, "voice.json"), config: path.join(data, "config.json") };
    const secret = randomBytes(32).toString("hex");
    for (const [file, content] of [[files.credentialsFile, JSON.stringify(bot)], [files.secret, secret], [files.agent, services.agentSecret], [files.speech, services.speechSecret]]) await writeFile(file, content, { mode: 0o600 });
    await writeFile(files.voiceFile, JSON.stringify({ agentId: "assistant", agent: { baseUrl: services.agentUrl, secretFile: files.agent },
      speech: { baseUrl: services.speechUrl, secretFile: files.speech }, allowInsecureLoopback: true }));
    const portServer = createServer(); portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
    const assetPort = portServer.address().port; await new Promise((resolve) => portServer.close(resolve));
    await writeFile(files.config, JSON.stringify({ credentialsFile: files.credentialsFile, profileDir: path.join(data, "profile"), assetDir: path.join(root, "dist/browser-worker/assets"),
      assetPort, owners: [selfCalls ? bot.userId : recipient.userId], rooms: [baselineRoom?.room_id ?? roomId], selfCalls, focusUrls: [focusUrl], sfuUrls: [sfuUrl],
      devices: [{ userId: recipient.userId, deviceId: recipient.deviceId, ...keys }], allowInsecureLoopback: true, voiceFile: files.voiceFile }));
    worker = await startBrowserWorker({ MATRIX_CALL_SECRET_FILE: files.secret, MATRIX_CALL_PORT: "0", MATRIX_CALL_BROWSER_CONFIG: files.config });
    await waitFor(() => peer.evaluate(({ userId, deviceId, keys }) => window.matrixTest.trust(userId, deviceId, keys), { ...bot, keys: worker.driver.deviceKeys }), "outbound bot device enrollment");
    const client = await WorkerHttpClient.connect({ baseUrl: `http://127.0.0.1:${worker.server.address().port}`, secret, allowInsecureLoopback: true, timeoutMs: 90_000 });
    assert(client.outboundCalls);
    if (selfCalls) assert.equal(await client.recipientRoom({ recipientId: recipient.userId }, signal()), roomId);
    const input = { roomId, recipientId: recipient.userId, message: "Fixture agent response", ringTimeoutMs: 30_000, ...(selfCalls ? { selfCall: true } : {}) };
    const pending = client.dial(input, signal()).then((value) => ({ value }), (error) => ({ error }));
    await waitFor(async () => (await peer.evaluate(({ roomId, botId }) => window.matrixTest.ringNotifications(roomId, botId), { roomId, botId: bot.userId })).length === 1, "real MatrixRTC ringing notification");
    const [notice] = await peer.evaluate(({ roomId, botId }) => window.matrixTest.ringNotifications(roomId, botId), { roomId, botId: bot.userId });
    assert.equal(notice.slot_id, "m.call#ROOM"); assert.equal(notice.lifetime, 30_000); assert(notice["m.relates_to"].event_id);
    assert.equal((await client.status(signal())).session.state, "ringing");
    assert.equal(services.state.syntheses, 0, "Opening speech must wait for the answer");
    await peer.evaluate(({ id, owners, focus }) => window.matrixTest.join(id, owners, focus), { id: roomId, owners: [recipient.userId, bot.userId], focus: focusUrl });
    await waitFor(async () => (await peer.evaluate(() => window.matrixTest.status("ignored"))).members === 2, "outbound answer membership");
    await peer.evaluate(({ focus, sfu }) => window.matrixTest.connectAuthorized(focus, sfu), { focus: focusUrl, sfu: sfuUrl });
    const identity = `${bot.userId}:${bot.deviceId}`;
    try {
      await waitFor(async () => { const audio = await peer.evaluate((id) => window.mediaTest.measure(id), identity); return audio.encrypted && audio.rms > 0.03 && Math.abs(audio.frequency - 1320) < 35; }, "encrypted opening without a microphone utterance");
    } catch (error) {
      const outcome = await pending;
      console.log(JSON.stringify({ event: "outbound-call-failed", error: outcome.error?.code ?? "unknown", status: worker.media.status(),
        syntheses: services.state.syntheses, invalidRequests: services.state.invalidRequests,
        peer: await peer.evaluate((id) => window.matrixTest.admissionDiagnostic(id), identity),
        audio: await peer.evaluate((id) => window.mediaTest.measure(id), identity) }));
      throw error;
    }
    const result = await pending; if (result.error) throw result.error;
    assert.equal((await peer.evaluate(() => window.mediaTest.diagnostics())).localEncrypted.length, 0, "The recipient must publish no microphone track before opening speech");
    assert.equal((await peer.evaluate(() => window.matrixTest.status("ignored"))).localKey, false, "No recipient media key is required for the opening");
    assert.equal(result.value.state, "connected");
    assert.equal(services.state.turns.length, 0); assert.equal(services.state.transcriptions.length, 0); assert.equal(services.state.syntheses, 1);
    if (selfCalls) {
      assert(await peer.evaluate(() => window.matrixTest.rotate(0)));
      await peer.evaluate(async () => { await window.mediaTest.publish(0); window.mediaTest.silence(); });
      await peer.evaluate(() => window.mediaTest.observe("outbound"));
      await peer.evaluate(() => window.mediaTest.sound(880));
      await new Promise((resolve) => setTimeout(resolve, 900));
      await peer.evaluate(() => window.mediaTest.silence());
      await waitFor(() => services.state.turns.length === 1, "non-owner voice turn with scoped participant policy");
      await waitFor(async () => { const audio = await peer.evaluate((id) => window.mediaTest.measure(id), identity); return audio.encrypted && audio.rms > 0.03 && Math.abs(audio.frequency - 1320) < 35; }, "non-owner encrypted voice reply");
      await waitFor(() => !worker.voice.busy, "non-owner voice completion");
      await peer.evaluate(() => window.mediaTest.finishObservation());
      assert.equal(services.state.turns[0].caller.userId, recipient.userId);
    }
    if (selfCalls) {
      await peer.evaluate(async () => { await window.matrixTest.leave(); await window.mediaTest.close(); });
      await waitFor(async () => (await client.status(signal())).session === null, "recipient hangup releases the shared call slot");
    } else {
      await client.leave(result.value.sessionId, signal());
      assert.equal((await client.status(signal())).session, null);
      await peer.evaluate(async () => { await window.matrixTest.leave(); await window.mediaTest.close(); });
    }
    await assert.rejects(client.dial({ ...input, ringTimeoutMs: 1000 }, signal()), (error) => error.code === "backend-failed");
    await waitFor(async () => (await client.status(signal())).session === null, "unanswered exact-session cleanup");
    assert.equal(services.state.syntheses, selfCalls ? 2 : 1, "An unanswered call must not synthesize an opening");
    assert.equal(services.state.invalidRequests, 0);
    console.log(JSON.stringify({ event: "outbound-call-verified", ringingNotification: true, verifiedAnswer: true, encryptedOpening: true, recipientMicrophoneTracksAtOpening: 0, recipientKeysAtOpening: 0, microphoneUtterances: 0, modelTurns: 0, unansweredCleanup: true }));
    return { outboundCall: true, verifiedOutboundAnswer: true, openingWithoutMicrophone: true, receiveOnlyOpening: true, unansweredCleanup: true, nonOwnerSelfCall: selfCalls, nonOwnerVoice: selfCalls };
  } finally {
    await worker?.close(); await services?.close(); await context.close();
  }
}
