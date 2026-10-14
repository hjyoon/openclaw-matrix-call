import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { createWorkerServer, WorkerMediaController } from "../dist/worker/index.js";
import { poll, startTestHomeserver } from "./integration/homeserver.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-commands-"));
let homeserver; let gateway; let stopped; let client; let worker; let media;
let output = "";
let failure;
const secrets = [];
let providerRequests = 0; let connections = 0; let disconnects = 0;
const workerRequests = [];
const provider = createServer((_request, response) => { providerRequests++; response.writeHead(503).end(); });
async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; }
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }
const stopGateway = async () => {
  if (!gateway) return;
  gateway.kill("SIGTERM"); const timeout = setTimeout(() => gateway.kill("SIGKILL"), 90_000);
  try { assert.equal((await stopped).code, 0, "Disposable command Gateway must shut down cleanly"); }
  finally { clearTimeout(timeout); gateway = undefined; }
};
try {
  homeserver = await startTestHomeserver(path.join(directory, "synapse"));
  const owner = await homeserver.register("owner"); const visitor = await homeserver.register("visitor"); const bot = await homeserver.register("bot");
  secrets.push(owner.access_token, visitor.access_token, bot.access_token);
  await homeserver.api(`/_matrix/client/v3/profile/${encodeURIComponent(visitor.user_id)}/displayname`, "PUT", { displayname: "owner" }, visitor.access_token);
  const { room_id: roomId } = await homeserver.api("/_matrix/client/v3/createRoom", "POST", { room_version: "12", preset: "private_chat",
    name: "Matrix Call command fixture", invite: [visitor.user_id, bot.user_id] }, owner.access_token);
  for (const account of [visitor, bot]) await homeserver.api(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, "POST", {}, account.access_token);
  const directRooms = new Map();
  for (const account of [owner, visitor]) {
    const { room_id } = await homeserver.api("/_matrix/client/v3/createRoom", "POST", { room_version: "12", preset: "private_chat", is_direct: true,
      invite: [bot.user_id] }, account.access_token);
    await homeserver.api(`/_matrix/client/v3/join/${encodeURIComponent(room_id)}`, "POST", {}, bot.access_token);
    await homeserver.api(`/_matrix/client/v3/user/${encodeURIComponent(account.user_id)}/account_data/m.direct`, "PUT", { [bot.user_id]: [room_id] }, account.access_token);
    directRooms.set(account.user_id, room_id);
  }
  await homeserver.api(`/_matrix/client/v3/user/${encodeURIComponent(bot.user_id)}/account_data/m.direct`, "PUT",
    Object.fromEntries([...directRooms].map(([id, room]) => [id, [room]])), bot.access_token);
  media = new WorkerMediaController({ rooms: [roomId], transport: { async connect(room) { assert.equal(room, roomId); connections++; }, async disconnect() { disconnects++; } } });
  const controlSecret = randomBytes(32).toString("hex"); secrets.push(controlSecret);
  ({ server: worker } = createWorkerServer(controlSecret, media)); const workerPort = await listen(worker);
  worker.on("request", (request) => workerRequests.push(request.url));
  const providerPort = await listen(provider); const gatewayPort = await freePort();
  const token = randomBytes(32).toString("hex"); secrets.push(token);
  const env = Object.fromEntries(["PATH", "USER", "SHELL", "TERM"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  Object.assign(env, { HOME: path.join(directory, "home"), OPENCLAW_HOME: path.join(directory, "home"), OPENCLAW_STATE_DIR: path.join(directory, "state"),
    OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"), OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SKIP_CANVAS_HOST: "1", CI: "true" });
  await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ plugins: { allow: ["matrix-call", "matrix"] } }), { mode: 0o600 });
  const cli = path.join(root, "node_modules/.bin/openclaw");
  const messaging = path.join(directory, "matrix-messaging");
  await cp(path.join(root, "node_modules/@openclaw/matrix"), messaging, { recursive: true, dereference: true, force: false, errorOnExist: true });
  assert.equal((await stat(path.join(messaging, "dist/index.js"))).nlink, 1);
  assert.equal(JSON.parse(await readFile(path.join(messaging, "package.json"), "utf8")).version, "2026.10.2");
  await exec(cli, ["plugins", "install", "--link", messaging, "--force", "--accept-capabilities"], { cwd: directory, env, timeout: 60_000 });
  await exec("pnpm", ["--dir", path.join(root, "packages/openclaw-plugin"), "pack", "--pack-destination", directory], { cwd: root, env: { ...env, HOME: process.env.HOME } });
  const archive = (await readdir(directory)).find((file) => file.endsWith(".tgz")); assert(archive);
  await exec(cli, ["plugins", "install", path.join(directory, archive), "--force", "--accept-capabilities"], { cwd: directory, env, timeout: 60_000 });
  const workspace = path.join(directory, "workspace"); await mkdir(workspace, { mode: 0o700 });
  const secretFile = path.join(directory, "control.secret"); await writeFile(secretFile, controlSecret, { mode: 0o600 });
  const patch = path.join(directory, "settings.json");
  await writeFile(patch, JSON.stringify({
    gateway: { mode: "local", port: gatewayPort, bind: "loopback", auth: { mode: "token", token }, controlUi: { enabled: false } },
    plugins: { slots: { memory: "none" } },
    channels: { matrix: { enabled: true, homeserver: homeserver.url, accessToken: bot.access_token, userId: bot.user_id, deviceId: bot.device_id,
      encryption: false, network: { dangerouslyAllowPrivateNetwork: true }, autoJoin: "off", joinIntro: false,
      dm: { policy: "allowlist", sessionScope: "per-room", allowFrom: [owner.user_id, visitor.user_id] }, groupPolicy: "allowlist", groupAllowFrom: [owner.user_id, visitor.user_id],
      groups: { [roomId]: { requireMention: false, users: [owner.user_id, visitor.user_id] } }, threadReplies: "off" },
      "matrix-call": { enabled: true, policy: { owners: [owner.user_id], rooms: [roomId], agents: ["main"] },
        workerControl: { baseUrl: `http://127.0.0.1:${workerPort}`, secretFile, allowInsecureLoopback: true, timeoutMs: 2000 } } },
    commands: { text: true, allowFrom: { matrix: [owner.user_id, visitor.user_id] }, ownerAllowFrom: [`matrix:${owner.user_id}`] },
    agents: { ownership: "explicit", defaults: { workspace, systemAgent: { agentId: "main" }, model: { primary: "command-fixture/unused" },
      heartbeat: { every: "0m", agentId: "main" } }, entries: { main: { workspace } } },
    models: { providers: { "command-fixture": { baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "isolated-unused-fixture",
      api: "openai-completions", models: [{ id: "unused", name: "Must not receive command inference", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 256 }] } } },
    cron: { enabled: false }, browser: { enabled: false }, logging: { level: "error", consoleLevel: "error", file: path.join(directory, "gateway.log") },
  }), { mode: 0o600 });
  await exec(cli, ["config", "patch", "--file", patch], { cwd: directory, env, timeout: 60_000 });
  gateway = spawn(cli, ["gateway", "run", "--bind", "loopback", "--port", String(gatewayPort)], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  stopped = new Promise((resolve, reject) => { gateway.once("error", reject); gateway.once("exit", (code, signal) => resolve({ code, signal })); });
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString("utf8")).slice(-16_000); });
  await poll(async () => { try { return (await fetch(`http://127.0.0.1:${gatewayPort}/healthz`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, "command Gateway startup");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Command Gateway connection timed out")), 15_000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gatewayPort}`, token, env, deviceIdentity: null, clientName: "cli", mode: "cli", scopes: ["operator.admin"],
      onHelloOk() { clearTimeout(timeout); resolve(); }, onConnectError(error) { clearTimeout(timeout); reject(error); } }); client.start();
  });
  await poll(async () => { try { return (await client.request("matrixcall.control", { operation: "status" })).available; } catch { return false; } }, "native command worker authentication");
  await poll(async () => {
    const channels = await client.request("channels.status", { probe: false });
    return channels.channelAccounts?.matrix?.some((account) => account.running && account.connected && account.configured);
  }, "actual Matrix channel sync connection", 45_000);
  const seen = new Set();
  const timeline = (room = roomId, account = owner) => homeserver.api(`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=100`, "GET", undefined, account.access_token);
  for (const [room, account] of [[roomId, owner], [directRooms.get(owner.user_id), owner], [directRooms.get(visitor.user_id), visitor]]) {
    for (const event of (await timeline(room, account)).chunk) seen.add(event.event_id);
  }
  let replies = 0;
  const command = async (account, text, extra = {}, chatRoom = roomId) => {
    const sender = account === owner ? "owner" : "visitor";
    console.log(JSON.stringify({ event: "matrix-command-started", sender, direct: chatRoom !== roomId, index: replies + 1, operation: text.split(/\s+/)[1] ?? "status" }));
    const content = { msgtype: "m.text", body: text, "m.mentions": { user_ids: [bot.user_id] }, ...extra };
    await homeserver.api(`/_matrix/client/v3/rooms/${encodeURIComponent(chatRoom)}/send/m.room.message/${randomUUID()}`, "PUT", content, account.access_token);
    let response;
    try { await poll(async () => {
      const events = (await timeline(chatRoom, account)).chunk.filter((event) => !seen.has(event.event_id) && event.sender === bot.user_id && event.type === "m.room.message");
      if (!events.length) return false;
      assert.equal(events.length, 1); response = events[0]; seen.add(response.event_id); return true;
    }, "actual Matrix command reply"); }
    catch (error) {
      const events = (await timeline(chatRoom, account)).chunk.slice(0, 12).map((event) => ({ type: event.type,
        sender: event.sender === bot.user_id ? "bot" : event.sender === owner.user_id ? "owner" : event.sender === visitor.user_id ? "visitor" : "other",
        seen: seen.has(event.event_id), message: event.content?.body?.slice(0, 256) }));
      console.log(JSON.stringify({ event: "matrix-command-missing-reply", sender, index: replies + 1, providerRequests, workerRequests, events }));
      throw error;
    }
    replies++; return response.content.body;
  };
  const result = (text) => {
    assert(text.startsWith("Matrix Call media control: "), `Unexpected fixture command reply: ${text}`);
    return JSON.parse(text.slice("Matrix Call media control: ".length).split(". Assistant readiness")[0]);
  };
  assert.equal(await command(visitor, "/matrixcall join " + roomId, { senderId: owner.user_id, senderIsOwner: true }), "Matrix Call control unavailable: forbidden");
  assert.equal(connections, 0);
  assert.equal(result(await command(owner, "/matrixcall status")).session, null);
  assert.equal(await command(owner, "/matrixcall join !unconfigured:matrix-call.test"), "Matrix Call control unavailable: forbidden");
  const joined = result(await command(owner, "/matrixcall join " + roomId));
  assert.equal(joined.roomId, roomId); assert.equal(joined.state, "connected"); assert.equal(connections, 1);
  assert.equal(await command(owner, "/matrixcall leave " + randomUUID()), "Matrix Call control unavailable: not-found"); assert.equal(disconnects, 0);
  assert.deepEqual(result(await command(owner, "/matrixcall leave " + joined.sessionId)), { closed: true }); assert.equal(disconnects, 1);
  assert.equal(result(await command(owner, "/matrixcall")).session, null);
  assert.equal(await command(visitor, "/matrixcall status", { senderId: owner.user_id }, directRooms.get(visitor.user_id)), "Matrix Call control unavailable: forbidden");
  const dm = (text) => command(owner, text, {}, directRooms.get(owner.user_id));
  assert.equal(result(await dm("/matrixcall status")).session, null);
  assert((await dm("/matrixcall status extra")).startsWith("Usage:"));
  assert.equal(await dm("/matrixcall leave invalid"), "Matrix Call control unavailable: invalid-request");
  const direct = result(await dm("/matrixcall join " + roomId)); assert.equal(connections, 2);
  assert.equal(await dm("/matrixcall join " + roomId), "Matrix Call control unavailable: busy"); assert.equal(connections, 2);
  assert.deepEqual(result(await dm("/matrixcall leave " + direct.sessionId)), { closed: true }); assert.equal(disconnects, 2);
  const owned = result(await dm("/matrixcall join " + roomId)); assert.equal(connections, 3); assert.equal(disconnects, 2);
  assert.equal(new Set([joined.sessionId, direct.sessionId, owned.sessionId]).size, 3);
  assert.equal(media.status().session.sessionId, owned.sessionId);
  assert.equal(providerRequests, 0);
  await stopGateway();
  assert.equal(disconnects, 3); assert.equal(media.status().session, null);
  console.log(JSON.stringify({ event: "matrix-command-integration-passed", replies, connections, disconnects, senderBoundToHomeserver: true,
    displayNameAndRoleSpoofRejected: true, exactSessionLeave: true, nativePlugins: ["matrix@2026.10.2", "matrix-call"],
    directRooms: 2, ownedSessionCleanup: true, chatEncryption: false, mediaTransport: "fixture", modelInference: false, releasedClient: false }));
} catch (error) {
  let detail = `${error.message}\n${error.stderr ?? ""}\n${output}`;
  for (const secret of secrets) detail = detail.replaceAll(secret, "[secret]");
  failure = new Error(detail.slice(-16_000));
} finally {
  client?.stop();
  const cleanup = await Promise.allSettled([stopGateway(), media?.shutdown()]);
  for (const server of [worker, provider]) if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await homeserver?.close(); await rm(directory, { recursive: true, force: true });
  const rejected = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (rejected.length) failure = new AggregateError([...(failure ? [failure] : []), ...rejected], "Matrix command verification cleanup failed");
}
if (failure) throw failure;
