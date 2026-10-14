import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { startTestSfu } from "./integration/sfu.mjs";
import { startTestAuthorization } from "./integration/authorization.mjs";
import { loadTestControl } from "./integration/control.mjs";
import { verifyBrowserDriver } from "./integration/browser-driver.mjs";
import { readLiveModel } from "./integration/live-model.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.env.MATRIX_CALL_LIVE_MODEL_REQUIRED === "1") assert(process.env.MATRIX_CALL_LIVE_MODEL_FILE, "Set MATRIX_CALL_LIVE_MODEL_FILE to private access-only model settings");
if (process.env.MATRIX_CALL_LIVE_MODEL_FILE) {
  assert.equal(process.env.MATRIX_CALL_NATIVE_GATEWAY, "1", "Live model checks require the installed native Gateway");
  assert(process.env.MATRIX_CALL_MATRIX_SPEECH_IMAGE, "Live model checks require actual speech engines");
  readLiveModel(process.env.MATRIX_CALL_LIVE_MODEL_FILE);
}
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, ".cache/browsers");
const { chromium } = await import("playwright-core");
const image = "ghcr.io/element-hq/synapse:v1.162.0@sha256:6b84a7bbac36f080b2d2e51e0289cf1b08b349598ea44a558df38d558f2c2311";
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-crypto-"));
const container = `matrix-call-crypto-${randomUUID()}`;
const registrationSecret = randomBytes(32).toString("hex");
const contexts = [];
const controls = [];
const dockerUser = `${process.getuid()}:${process.getgid()}`;
assert(process.getuid() !== 0, "Integration checks require a non-root user");
let server;
let running = false;
let sfu;
let authorization;
let tlsProxy;
let homeserver;
const openIdStatuses = [];
let succeeded = false;

async function waitFor(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function api(url, method, body, accessToken) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Test homeserver returned HTTP ${response.status}: ${error.errcode} ${error.error}`);
  }
  return response.json();
}

try {
  const keyFile = path.join(directory, "test.key");
  const certFile = path.join(directory, "test.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "pipe" });
  tlsProxy = createTlsServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, async (request, reply) => {
    try {
      const upstream = await fetch(`${homeserver}${request.url}`, { signal: AbortSignal.timeout(5000) });
      openIdStatuses.push(upstream.status);
      reply.writeHead(upstream.status, { "Content-Type": "application/json" });
      reply.end(await upstream.text());
    } catch { reply.writeHead(502); reply.end(); }
  });
  await new Promise((resolve) => tlsProxy.listen(0, "127.0.0.1", resolve));
  const serverName = `localhost:${tlsProxy.address().port}`;
  execFileSync("docker", ["run", "--rm", "--user", dockerUser, "--env", `SYNAPSE_SERVER_NAME=${serverName}`, "--env", "SYNAPSE_REPORT_STATS=no", "--mount", `type=bind,source=${directory},target=/data`, image, "generate"], { stdio: "pipe" });
  const configFile = path.join(directory, "homeserver.yaml");
  await writeFile(configFile, `server_name: ${serverName}\npid_file: /data/homeserver.pid\nreport_stats: false\nlisteners:\n  - port: 8008\n    type: http\n    tls: false\n    bind_addresses: [0.0.0.0]\n    resources:\n      - names: [client, federation]\n        compress: false\ndatabase:\n  name: sqlite3\n  args:\n    database: /data/homeserver.db\nlog_config: /data/${serverName}.log.config\nsigning_key_path: /data/${serverName}.signing.key\nmedia_store_path: /data/media_store\nregistration_shared_secret: ${registrationSecret}\nenable_registration: false\ntrusted_key_servers: []\nsuppress_key_server_warning: true\nrc_message:\n  per_second: 100\n  burst_count: 1000\nmax_event_delay_duration: 10000\n`, { mode: 0o600 });
  execFileSync("docker", ["run", "--detach", "--rm", "--name", container, "--user", dockerUser, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "768m", "--pids-limit", "128", "--publish", "127.0.0.1::8008", "--mount", `type=bind,source=${directory},target=/data`, image], { stdio: "pipe" });
  running = true;
  const port = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", container], { encoding: "utf8" }))["8008/tcp"][0].HostPort;
  homeserver = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try { return (await fetch(`${homeserver}/_matrix/client/versions`, { signal: AbortSignal.timeout(500) })).ok; }
    catch { return false; }
  }, "isolated homeserver startup");
  const accounts = [];
  for (const username of ["alice", "bob"]) {
    const endpoint = `${homeserver}/_synapse/admin/v1/register`;
    const { nonce } = await api(endpoint, "GET");
    const password = randomBytes(32).toString("hex");
    const mac = createHmac("sha1", registrationSecret).update([nonce, username, password, "notadmin"].join("\0")).digest("hex");
    const account = await api(endpoint, "POST", { nonce, username, password, admin: false, mac });
    accounts.push({ baseUrl: homeserver, userId: account.user_id, deviceId: account.device_id, accessToken: account.access_token });
  }
  const room = await api(`${homeserver}/_matrix/client/v3/createRoom`, "POST", { preset: "private_chat", invite: [accounts[1].userId], initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }], power_level_content_override: { users: { [accounts[1].userId]: 100 } } }, accounts[0].accessToken);
  const create = await api(`${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}/state/m.room.create/`, "GET", undefined, accounts[0].accessToken);
  assert.equal(create.room_version, "12");
  await api(`${homeserver}/_matrix/client/v3/join/${encodeURIComponent(room.room_id)}`, "POST", {}, accounts[1].accessToken);
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/integration/matrix-browser.js"], bundle: true, platform: "browser", format: "esm", target: "es2023", write: false, legalComments: "none", logLevel: "silent" });
  const matrixRequire = createRequire(import.meta.resolve("matrix-js-sdk"));
  const wasm = await readFile(path.join(path.dirname(matrixRequire.resolve("@matrix-org/matrix-sdk-crypto-wasm")), "pkg/matrix_sdk_crypto_wasm_bg.wasm"));
  const worker = await readFile(fileURLToPath(import.meta.resolve("livekit-client/e2ee-worker")));
  server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); }
    else if (request.url.endsWith("matrix_sdk_crypto_wasm_bg.wasm")) { response.setHeader("Content-Type", "application/wasm"); response.end(wasm); }
    else if (request.url === "/e2ee-worker.js") { response.setHeader("Content-Type", "text/javascript"); response.end(worker); }
    else { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><script type="module" src="/fixture.js"></script>'); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pages = [];
  for (let i = 0; i < accounts.length; i++) {
    const context = await chromium.launchPersistentContext(path.join(directory, `profile-${i}`), { headless: true, chromiumSandbox: true, args: ["--autoplay-policy=no-user-gesture-required"] });
    contexts.push(context);
    const page = context.pages()[0];
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.matrixTest));
    await page.evaluate((credentials) => window.matrixTest.init(credentials), accounts[i]);
    await waitFor(() => page.evaluate((id) => window.matrixTest.prepared(id), room.room_id), "Matrix initial sync");
    pages.push(page);
  }
  const fingerprints = await Promise.all(pages.map((page) => page.evaluate(() => window.matrixTest.keys())));
  for (let i = 0; i < accounts.length; i++) {
    const other = 1 - i;
    await waitFor(() => pages[i].evaluate(({ userId, deviceId, fingerprint }) => window.matrixTest.trust(userId, deviceId, fingerprint), { ...accounts[other], fingerprint: fingerprints[other] }), "published test device keys");
  }
  const owners = accounts.map((account) => account.userId);
  sfu = await startTestSfu(directory, { autoCreate: false });
  authorization = await startTestAuthorization(directory, sfu, serverName);
  for (const page of pages) await page.evaluate(({ id, owners, focus }) => window.matrixTest.join(id, owners, focus), { id: room.room_id, owners, focus: authorization.url });
  for (const page of pages) {
    await waitFor(async () => { const status = await page.evaluate((id) => window.matrixTest.status(id), "ignored"); return status.members === 2 && status.joined && status.localMember; }, "MatrixRTC membership");
  }
  for (const page of pages) assert(await page.evaluate(() => window.matrixTest.rotate(0)), "Locally generated key publication must succeed");
  for (let i = 0; i < pages.length; i++) {
    const identity = `${accounts[1 - i].userId}:${accounts[1 - i].deviceId}`;
    try {
      await waitFor(async () => {
        const status = await pages[i].evaluate((identity) => window.matrixTest.status(identity), identity);
        assert(!status.failed, "Matrix key callback failed");
        return status.members === 2 && status.localKey && status.remoteKey;
      }, "authenticated MatrixRTC keys", 30_000);
    } catch {
      const status = await pages[i].evaluate((identity) => window.matrixTest.status(identity), identity);
      throw new Error(`MatrixRTC key admission failed: ${JSON.stringify(status)}`);
    }
  }
  const identities = accounts.map((account) => `${account.userId}:${account.deviceId}`);
  const createControl = await loadTestControl(root, directory);
  const sessions = [];
  for (let i = 0; i < pages.length; i++) {
    const control = await createControl({ page: pages[i], roomId: room.room_id, focusUrl: authorization.url, sfuUrl: sfu.url });
    controls.push(control);
    const rejected = await control.request("/v1/media/join", { roomId: "!unconfigured" });
    assert.equal(rejected.status, 403);
    const connected = await control.request("/v1/media/join", { roomId: room.room_id });
    assert.equal(connected.status, 200);
    sessions.push(connected.value.sessionId);
    assert.equal((await control.request("/v1/media/status", {})).value.session.state, "connected");
    await pages[i].evaluate((frequency) => window.mediaTest.publish(frequency), i === 0 ? 440 : 660);
  }
  for (let i = 0; i < pages.length; i++) {
    const other = 1 - i;
    await waitFor(async () => {
      const measured = await pages[i].evaluate((id) => window.mediaTest.measure(id), identities[other]);
      return measured.encrypted && measured.rms > 0.03 && Math.abs(measured.frequency - (other === 0 ? 440 : 660)) < 35;
    }, "Matrix-distributed key audio");
    const proof = await pages[i].evaluate((id) => window.matrixTest.verify(id), identities[other]);
    assert.equal(proof.userId, accounts[other].userId);
    assert.equal(proof.deviceId, accounts[other].deviceId);
    assert(proof.deviceVerified && proof.mediaEncrypted);
  }
  const before = await pages[1].evaluate((id) => window.matrixTest.status(id), `${accounts[0].userId}:${accounts[0].deviceId}`);
  await pages[0].evaluate(({ target, id }) => window.matrixTest.sendKey(target.userId, target.deviceId, id, "WRONG-DEVICE", false), { target: accounts[1], id: room.room_id });
  await waitFor(async () => (await pages[1].evaluate((id) => window.matrixTest.status(id), "ignored")).rejected > before.rejected, "mismatched device rejection");
  const afterMismatch = await pages[1].evaluate((id) => window.matrixTest.status(id), "ignored");
  await pages[0].evaluate(({ target, id, claim }) => window.matrixTest.sendKey(target.userId, target.deviceId, id, claim, true), { target: accounts[1], id: room.room_id, claim: accounts[0].deviceId });
  await waitFor(async () => (await pages[1].evaluate((id) => window.matrixTest.status(id), "ignored")).rejected > afterMismatch.rejected, "plaintext key rejection");
  assert.equal((await controls[0].request("/v1/media/leave", { sessionId: sessions[0] })).status, 200);
  await contexts[0].close();
  await waitFor(async () => !(await pages[1].evaluate((id) => window.matrixTest.status(id), identities[0])).remoteKey, "departed key invalidation");
  const restored = await chromium.launchPersistentContext(path.join(directory, "profile-0"), { headless: true, chromiumSandbox: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  contexts[0] = restored;
  const page = restored.pages()[0];
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(window.matrixTest));
  await page.evaluate((credentials) => window.matrixTest.init(credentials), accounts[0]);
  await waitFor(() => page.evaluate((id) => window.matrixTest.prepared(id), room.room_id), "restart sync");
  assert.deepEqual(await page.evaluate(() => window.matrixTest.keys()), fingerprints[0]);
  assert(await page.evaluate(({ userId, deviceId }) => window.matrixTest.trusted(userId, deviceId), accounts[1]), "Device trust must persist across browser restart");
  assert.equal((await page.evaluate((id) => window.matrixTest.status(id), identities[1])).remoteKey, false, "Restart must not restore active-call key authority");
  await page.evaluate(({ id, owners, focus }) => window.matrixTest.join(id, owners, focus), { id: room.room_id, owners, focus: authorization.url });
  for (const participant of [page, pages[1]]) await waitFor(async () => { const status = await participant.evaluate((id) => window.matrixTest.status(id), "ignored"); return status.members === 2 && status.joined && status.localMember; }, "rejoined membership");
  assert(await page.evaluate(() => window.matrixTest.rotate(0)));
  assert(await pages[1].evaluate(() => window.matrixTest.rotate(1)));
  await waitFor(async () => (await page.evaluate((id) => window.matrixTest.status(id), identities[1])).remoteKey, "rejoined remote key");
  const restoredControl = await createControl({ page, roomId: room.room_id, focusUrl: authorization.url, sfuUrl: sfu.url });
  controls.push(restoredControl);
  const restoredSession = await restoredControl.request("/v1/media/join", { roomId: room.room_id });
  assert.equal(restoredSession.status, 200);
  assert.notEqual(restoredSession.value.sessionId, sessions[0]);
  await page.evaluate(() => window.mediaTest.publish(880));
  await waitFor(async () => {
    const measurement = await pages[1].evaluate((id) => window.mediaTest.measure(id), identities[0]);
    return measurement.encrypted && measurement.rms > 0.03 && Math.abs(measurement.frequency - 880) < 35;
  }, "rejoined encrypted audio");
  await waitFor(async () => {
    const measurement = await page.evaluate((id) => window.mediaTest.measure(id), identities[1]);
    return measurement.encrypted && measurement.rms > 0.03 && Math.abs(measurement.frequency - 660) < 35;
  }, "rotated remote audio after rejoin");
  await pages[1].evaluate((id) => window.matrixTest.verify(id), identities[0]);
  await page.evaluate((id) => window.matrixTest.verify(id), identities[1]);
  assert.equal((await restoredControl.request("/v1/media/leave", { sessionId: restoredSession.value.sessionId })).status, 200);
  assert.equal((await controls[1].request("/v1/media/leave", { sessionId: sessions[1] })).status, 200);
  const driver = await verifyBrowserDriver({ root, directory, api, waitFor, homeserver, registrationSecret, roomId: room.room_id,
    creator: accounts[0], owner: accounts[1], ownerKeys: fingerprints[1], peer: pages[1], focusUrl: authorization.url, sfuUrl: sfu.url });
  console.log(JSON.stringify({ browser: restored.browser().version(), synapse: "1.162.0", matrixSdk: "43.0.0", livekit: "1.13.9", authorization: "0.8.0", matrixRtcKeys: true, authenticatedDeviceBinding: true, plaintextRejected: true, deviceClaimRejected: true, persistentKeysAndTrust: true, matrixAudio: true, restartAndRejoin: true, focusAuthorization: true, authenticatedWorkerControl: true, ...driver }));
  succeeded = true;
} finally {
  if (!succeeded) console.log(JSON.stringify({ openIdStatuses }));
  await Promise.allSettled(controls.map((control) => control.shutdown()));
  await Promise.allSettled(contexts.map((context) => context.close()));
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
  await new Promise((resolve) => tlsProxy ? tlsProxy.close(resolve) : resolve());
  if (running) execFileSync("docker", ["rm", "--force", container], { stdio: "pipe" });
  sfu?.close();
  authorization?.close();
  await rm(directory, { recursive: true, force: true });
}
