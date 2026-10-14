import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

function installMicrophone(account) {
  localStorage.setItem("matrix-auth-store", JSON.stringify({ ...account, passwordlessUser: false }));
  const context = new AudioContext({ sampleRate: 48000 });
  const destinations = []; const analyzers = new Map();
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = constraints.video ? await original({ ...constraints, audio: false }) : new MediaStream();
    if (constraints.audio) { const destination = context.createMediaStreamDestination(); destinations.push(destination); stream.addTrack(destination.stream.getAudioTracks()[0]); }
    return stream;
  };
  window.releasedMicrophone = {
    async play({ samples, sampleRate }) {
      await context.resume();
      const buffer = context.createBuffer(1, samples.length, sampleRate); buffer.getChannelData(0).set(samples.map((sample) => sample / 32768));
      const source = context.createBufferSource(); source.buffer = buffer;
      for (const destination of destinations) source.connect(destination);
      try { await new Promise((resolve) => { source.onended = resolve; source.start(); }); }
      finally { source.disconnect(); source.buffer = null; buffer.getChannelData(0).fill(0); samples.fill(0); }
    },
    measure() {
      for (const element of document.querySelectorAll("audio")) {
        if (!(element.srcObject instanceof MediaStream) || analyzers.has(element.srcObject.id)) continue;
        const source = context.createMediaStreamSource(element.srcObject); const analyzer = context.createAnalyser(); const mute = context.createGain();
        analyzer.fftSize = 2048; mute.gain.value = 0; source.connect(analyzer).connect(mute).connect(context.destination); analyzers.set(element.srcObject.id, analyzer);
      }
      let rms = 0;
      for (const analyzer of analyzers.values()) {
        const samples = new Float32Array(analyzer.fftSize); analyzer.getFloatTimeDomainData(samples);
        rms = Math.max(rms, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length));
      }
      return { rms, streams: analyzers.size };
    },
  };
}

export async function startReleasedClient({ root, directory, chromium, account, homeserver, serverName, focusUrl, roomId }) {
  const pin = JSON.parse(await readFile(path.join(root, "tests/fixtures/clients/element-call.json"), "utf8"));
  const cache = path.join(root, ".cache/clients"); await mkdir(cache, { recursive: true });
  const archive = path.join(cache, `element-call-${pin.version}.tar.gz`);
  let bytes;
  try { bytes = await readFile(archive); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(60_000) }); assert(response.ok);
    assert(Number(response.headers.get("content-length")) <= 32_000_000); bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length <= 32_000_000); await writeFile(archive, bytes);
  }
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256); bytes.fill(0);
  const assets = path.join(directory, "released-client"); await mkdir(assets, { mode: 0o700 });
  await exec("tar", ["--extract", "--gzip", "--file", archive, "--directory", assets, "--strip-components=1", "--no-same-owner", "--no-same-permissions"]);
  const config = { default_server_config: { "m.homeserver": { base_url: homeserver, server_name: serverName } }, livekit: { livekit_service_url: focusUrl }, matrix_rtc_mode: "compatibility" };
  const server = createServer(async (request, response) => {
    try {
      const route = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      if (route === "/config.json") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(config)); return; }
      const file = ["/", "/room/"].includes(route) ? path.join(assets, "index.html") : path.resolve(assets, "." + route);
      assert(file.startsWith(assets + path.sep));
      response.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml" })[path.extname(file)] ?? "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let context;
  const close = async () => { await context?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
  try {
    context = await chromium.launchPersistentContext(path.join(directory, "released-profile"), { headless: true, chromiumSandbox: true,
      permissions: ["microphone", "camera"], args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    await context.addInitScript(installMicrophone, account);
    const page = context.pages()[0];
    const diagnostics = { errors: [], tokenResponses: [] };
    const redact = (text) => text.replaceAll(account.access_token, "[credential]").replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted]").slice(0, 500);
    page.on("console", (message) => { if (message.type() === "error") { diagnostics.errors.push(redact(message.text())); diagnostics.errors = diagnostics.errors.slice(-8); } });
    page.on("pageerror", (error) => { diagnostics.errors.push(redact(error.message)); diagnostics.errors = diagnostics.errors.slice(-8); });
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (url.origin !== new URL(focusUrl).origin || !["/sfu/get", "/get_token"].includes(url.pathname)) return;
      const record = { endpoint: url.pathname, status: response.status() };
      try {
        const { jwt } = await response.json(); const claims = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        record.legacyIdentity = claims.sub === `${account.user_id}:${account.device_id}`;
      } catch {}
      diagnostics.tokenResponses.push(record);
    });
    const url = `http://127.0.0.1:${server.address().port}/room/?roomId=${encodeURIComponent(roomId)}&perParticipantE2EE=true&noiseSuppression=false&echoCancellation=false`;
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.matrixclient?.getCrypto()));
    await page.getByRole("button", { name: "Join call", exact: true }).waitFor();
    const keys = await page.evaluate(() => window.matrixclient.getCrypto().getOwnDeviceKeys());
    const chat = {
      trust: (value) => page.evaluate(async ({ userId, deviceId, keys, roomId }) => {
        const client = window.matrixclient; const room = client.getRoom(roomId);
        if (!room?.hasEncryptionStateEvent()) throw new Error("Released-client encrypted command room is unavailable");
        const crypto = client.getCrypto(); crypto.prepareToEncrypt(room);
        const device = (await crypto.getUserDeviceInfo([userId], false)).get(userId)?.get(deviceId);
        if (!device) return false;
        if (device.getFingerprint() !== keys.ed25519 || device.getIdentityKey() !== keys.curve25519) throw new Error("Released-client messaging fingerprint mismatch");
        await crypto.setDeviceVerified(userId, deviceId, true); return true;
      }, { ...value, roomId }),
      send: (value) => page.evaluate(({ roomId, text, botId }) => {
        const client = window.matrixclient;
        if (!client.getRoom(roomId)?.hasEncryptionStateEvent()) throw new Error("Released-client encrypted command room is unavailable");
        return client.sendMessage(roomId, { msgtype: "m.text", body: text, "m.mentions": { user_ids: [botId] } });
      }, value),
      replies: (value) => page.evaluate(async ({ roomId, botId }) => {
        const client = window.matrixclient; const replies = [];
        for (const event of client.getRoom(roomId)?.getLiveTimeline().getEvents() ?? []) {
          if (event.getSender() !== botId) continue;
          await client.decryptEventIfNeeded(event);
          if (event.getType() === "m.room.message" && event.getContent().body?.startsWith("Matrix Call")) {
            replies.push({ id: event.getId(), type: event.getWireType(), algorithm: event.getWireContent().algorithm, text: event.getContent().body });
          }
        }
        return replies;
      }, value),
    };
    return { page, keys, pin, url, diagnostics, chat, close };
  } catch (error) { await close(); throw error; }
}
