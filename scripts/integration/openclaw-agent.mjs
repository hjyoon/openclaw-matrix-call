import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { HttpAgentAdapter } from "../../dist/agent-http/index.js";
import { RequestAuthenticator } from "../../dist/core/index.js";
import { createWorkerServer, WorkerMediaController } from "../../dist/worker/index.js";

const exec = promisify(execFile);

async function poll(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function turn(conversationId, text) {
  return {
    protocolVersion: 1, conversationId, turnId: randomUUID(), agentId: "main",
    caller: {
      roomId: "!room:example.org", rtcSessionId: "integration-rtc", participantId: "integration-participant",
      userId: "@owner:example.org", deviceId: "INTEGRATION", expiresAtMs: Date.now() + 60_000,
      deviceVerified: true, mediaEncrypted: true,
    },
    messages: [{ role: "user", text, senderId: "@owner:example.org", timestampMs: Date.now() }],
    signal: new AbortController().signal,
  };
}

export async function verifyInstalledAgent({ cli, directory, env }) {
  const requests = [];
  const held = new Set();
  let mode = "reply";
  let disconnected = 0;
  const provider = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert(size <= 2_000_000);
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    if (mode === "hold") {
      held.add(response);
      response.once("close", () => { held.delete(response); disconnected += 1; });
      return;
    }
    if (mode === "fail") {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "integration provider failure", type: "invalid_request_error" } }));
      return;
    }
    const text = `Fixture reply ${requests.length}`;
    const envelope = { id: "fixture-completion", model: "fixture-model", created: 1 };
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...envelope, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let connected = 0;
  let closed = 0;
  const media = new WorkerMediaController({ rooms: ["!room:example.org"], transport: {
    connect: async () => { connected += 1; }, disconnect: async () => { closed += 1; },
  } });
  const controlSecret = randomBytes(32).toString("hex");
  const { server: worker } = createWorkerServer(controlSecret, media);
  worker.listen(0, "127.0.0.1");
  await once(worker, "listening");
  try {
    const providerPort = provider.address().port;
    const gatewayPort = await freePort();
    const agentPort = await freePort();
    const baseUrl = `http://127.0.0.1:${agentPort}`;
    const secret = randomBytes(32).toString("hex");
    const secretFile = path.join(directory, "agent.secret");
    const controlSecretFile = path.join(directory, "control.secret");
    const gatewayToken = randomBytes(32).toString("hex");
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(secretFile, secret + "\n", { mode: 0o600 });
    await writeFile(controlSecretFile, controlSecret + "\n", { mode: 0o600 });
    const patchFile = path.join(directory, "agent-config.patch.json");
    await writeFile(patchFile, JSON.stringify({
      gateway: { mode: "local", port: gatewayPort, bind: "loopback", auth: { mode: "token", token: gatewayToken }, controlUi: { enabled: false } },
      plugins: { slots: { memory: "none" } },
      channels: { "matrix-call": {
        enabled: true, policy: { owners: ["@owner:example.org"], rooms: ["!room:example.org"], agents: ["main"] },
        agentService: { secretFile, port: agentPort, timeoutMs: 20_000 },
        workerControl: { baseUrl: `http://127.0.0.1:${worker.address().port}`, secretFile: controlSecretFile, allowInsecureLoopback: true, timeoutMs: 2000 },
      } },
      agents: { ownership: "explicit", defaults: { workspace, systemAgent: { agentId: "main" }, model: { primary: "matrix-call-fixture/fixture-model" }, heartbeat: { every: "0m", agentId: "main" } }, entries: { main: { workspace } } },
      models: { providers: { "matrix-call-fixture": { baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "isolated-fixture-key", api: "openai-completions", models: [{ id: "fixture-model", name: "Integration fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] } } },
      cron: { enabled: false }, browser: { enabled: false },
      logging: { level: "error", consoleLevel: "error", file: path.join(directory, "gateway.log") },
    }), { mode: 0o600 });
    await exec(cli, ["config", "patch", "--file", patchFile], { cwd: directory, env, timeout: 60_000 });
    const configured = await exec(cli, ["config", "get", "channels.matrix-call", "--json"], { cwd: directory, env, timeout: 60_000 });
    assert(JSON.parse(configured.stdout).policy);
    let gateway;
    let stopped;
    let output = "";
    const control = async (params) => {
      const result = await exec(cli, ["gateway", "call", "matrixcall.control", "--params", JSON.stringify(params), "--port", String(gatewayPort), "--json"], { cwd: directory, env, timeout: 30_000 });
      return JSON.parse(result.stdout);
    };
    const rejectedControl = (params, reason) => assert.rejects(control(params), (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "UNAVAILABLE");
      assert.equal(result.error.message, `Matrix Call control unavailable: ${reason}`);
      return true;
    });
    const start = async () => {
      output = "";
      gateway = spawn(cli, ["gateway", "run", "--bind", "loopback", "--port", String(gatewayPort)], {
        cwd: directory, env: { ...env, OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SKIP_CANVAS_HOST: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      stopped = new Promise((resolve, reject) => {
        gateway.once("error", reject);
        gateway.once("exit", (code, signal) => resolve({ code, signal }));
      });
      for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString("utf8")).slice(-16_000); });
      await poll(async () => {
        if (gateway.exitCode !== null) throw new Error(`Isolated Gateway exited: ${output}`);
        if (output.includes("plugin service failed (matrix-call-agent")) throw new Error("Installed native agent service failed to start");
        try { return (await fetch(baseUrl + "/capabilities", { signal: AbortSignal.timeout(500) })).status === 200; }
        catch { return false; }
      }, "installed native agent service startup");
    };
    const stop = async () => {
      if (!gateway) return;
      gateway.kill("SIGTERM");
      const timeout = setTimeout(() => gateway.kill("SIGKILL"), 45_000);
      try {
        const exit = await stopped;
        assert.equal(exit.code, 0, `Isolated Gateway shutdown: ${JSON.stringify(exit)} ${output}`);
      } finally { clearTimeout(timeout); gateway = undefined; }
    };
    try {
      await start();
      await poll(async () => {
        try { return (await control({ operation: "status" })).session === null; }
        catch { return false; }
      }, "installed native worker control startup");
      assert.deepEqual(await control({ operation: "status" }), { available: true, session: null });
      let reader;
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Read-scoped Gateway connection timed out")), 10_000);
          reader = new GatewayClient({
            url: `ws://127.0.0.1:${gatewayPort}`, token: gatewayToken, env, deviceIdentity: null,
            clientName: "cli", mode: "cli", scopes: ["operator.read"],
            onHelloOk: () => { clearTimeout(timeout); resolve(); },
            onConnectError: (error) => { clearTimeout(timeout); reject(error); },
          });
          reader.start();
        });
        await assert.rejects(reader.request("matrixcall.control", { operation: "status" }), /operator.admin/);
        assert.equal(media.status().session, null);
      } finally { reader?.stop(); }
      await rejectedControl({ operation: "join", roomId: "!unlisted:example.org" }, "forbidden");
      await rejectedControl({ operation: "status", senderIsOwner: true }, "invalid-request");
      const firstSession = await control({ operation: "join", roomId: "!room:example.org" });
      assert.deepEqual(firstSession, media.status().session);
      await rejectedControl({ operation: "leave", sessionId: randomUUID() }, "not-found");
      await rejectedControl({ operation: "join", roomId: "!room:example.org" }, "busy");
      assert.deepEqual(await control({ operation: "leave", sessionId: firstSession.sessionId }), { closed: true });
      await control({ operation: "join", roomId: "!room:example.org" });
      const agent = await HttpAgentAdapter.connect({ baseUrl, secret });
      const capabilities = await fetch(baseUrl + "/capabilities");
      const capabilitiesBody = await capabilities.text();
      const auth = new RequestAuthenticator({ secret, audience: JSON.parse(capabilitiesBody).audience });
      auth.verify({ method: "RESPONSE_200", path: "/capabilities", body: capabilitiesBody }, Object.fromEntries(capabilities.headers));
      const signedTurn = async ({ signal, ...value }) => {
        const body = JSON.stringify(value);
        const response = await fetch(baseUrl + "/turns", { method: "POST", body, headers: auth.sign({ method: "POST", path: "/turns", body }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
        const reply = await response.text();
        auth.verify({ method: `RESPONSE_${response.status}`, path: "/turns", body: reply }, Object.fromEntries(response.headers));
        return { status: response.status, body: JSON.parse(reply) };
      };
      assert.equal(agent.historyMode, "host-session");
      const conversationId = randomUUID();
      const firstTurn = turn(conversationId, "matrix-call-fixture-first");
      assert.deepEqual(await agent.reply(firstTurn), { text: "Fixture reply 1" });
      assert.deepEqual(await signedTurn(firstTurn), { status: 409, body: { error: "turn-already-accepted" } });
      assert.deepEqual(await agent.reply(turn(conversationId, "matrix-call-fixture-second")), { text: "Fixture reply 2" });
      assert(JSON.stringify(requests[1].messages).includes("matrix-call-fixture-first"));
      assert(JSON.stringify(requests[1].messages).includes("Fixture reply 1"));
      assert.deepEqual(await agent.reply(turn(randomUUID(), "matrix-call-fixture-independent")), { text: "Fixture reply 3" });
      assert(!JSON.stringify(requests[2].messages).includes("matrix-call-fixture-first"));
      assert(requests.every((request) => request.tools === undefined || request.tools.length === 0));
      const unauthorized = turn(randomUUID(), "unlisted caller");
      unauthorized.caller.userId = "@visitor:example.org";
      unauthorized.messages[0].senderId = unauthorized.caller.userId;
      await assert.rejects(agent.reply(unauthorized), /http-error/);
      const rebound = turn(conversationId, "attempted conversation rebind");
      rebound.caller.rtcSessionId = "another-rtc-session";
      assert.deepEqual(await signedTurn(rebound), { status: 403, body: { error: "conversation-mismatch" } });
      assert.equal(requests.length, 3);
      mode = "hold";
      const controller = new AbortController();
      const pending = agent.reply({ ...turn(randomUUID(), "matrix-call-fixture-cancel"), signal: controller.signal });
      const rejected = assert.rejects(pending);
      await poll(() => held.size === 1, "host request reached provider fixture");
      controller.abort();
      await rejected;
      await poll(() => disconnected === 1, "host cancelled provider request");
      mode = "fail";
      const failureTurn = turn(randomUUID(), "matrix-call-fixture-fail");
      await poll(async () => {
        const failed = await signedTurn(failureTurn);
        if (failed.status === 409) { assert.deepEqual(failed.body, { error: "agent-busy" }); return false; }
        assert.deepEqual(failed, { status: 503, body: { error: "agent-failed" } });
        return true;
      }, "cancelled host turn settled before failure admission");
      assert.equal(requests.length, 5);
      mode = "reply";
      assert.deepEqual(await agent.reply(turn(randomUUID(), "matrix-call-fixture-recover")), { text: "Fixture reply 6" });
      await stop();
      await assert.rejects(fetch(baseUrl + "/capabilities"));
      assert.equal(media.status().session, null);
      assert.equal(closed, 2);
      await start();
      await poll(async () => {
        try { return (await control({ operation: "status" })).session === null; }
        catch { return false; }
      }, "worker control reauthenticated after Gateway restart");
      await assert.rejects(agent.reply(turn(randomUUID(), "old audience")), /http-error/);
      const replacement = await HttpAgentAdapter.connect({ baseUrl, secret });
      assert.deepEqual(await replacement.reply(turn(randomUUID(), "matrix-call-fixture-restart")), { text: "Fixture reply 7" });
      assert(!JSON.stringify(requests[6].messages).includes("matrix-call-fixture-first"));
      const oldAudience = (await (await fetch(baseUrl + "/capabilities")).json()).audience;
      const beforeReload = await control({ operation: "join", roomId: "!room:example.org" });
      await exec(cli, ["config", "set", "channels.matrix-call.agentService.timeoutMs", "2000", "--strict-json"], { cwd: directory, env, timeout: 60_000 });
      await poll(async () => {
        try { return (await (await fetch(baseUrl + "/capabilities", { signal: AbortSignal.timeout(500) })).json()).audience !== oldAudience; }
        catch { return false; }
      }, "Gateway channel configuration reloaded native service");
      await poll(() => media.status().session === null && closed === 3, "Gateway reload cleaned its owned worker session");
      await poll(async () => {
        try { return (await control({ operation: "status" })).session === null; }
        catch { return false; }
      }, "worker control authenticated after configuration reload");
      const afterReload = await control({ operation: "join", roomId: "!room:example.org" });
      assert.notEqual(afterReload.sessionId, beforeReload.sessionId);
      await assert.rejects(replacement.reply(turn(randomUUID(), "old reload audience")), /http-error/);
      const reloaded = await HttpAgentAdapter.connect({ baseUrl, secret });
      assert.deepEqual(await reloaded.reply(turn(randomUUID(), "matrix-call-fixture-reload")), { text: "Fixture reply 8" });
      mode = "hold";
      const stopping = reloaded.reply(turn(randomUUID(), "matrix-call-fixture-stop"));
      const stopRejected = assert.rejects(stopping);
      await poll(() => held.size === 1, "host provider request before Gateway stop");
      await stop();
      await stopRejected;
      assert.equal(media.status().session, null);
      assert.equal(connected, 4);
      assert.equal(closed, 4);
      assert.equal(disconnected, 2);
      assert.equal(requests.length, 9);
      assert(requests.every((request) => request.tools === undefined || request.tools.length === 0));
      await assert.rejects(fetch(baseUrl + "/capabilities"));
      console.log("Installed Gateway agent service: real public SDK dispatch, bound history, idempotency, tool-free requests, policy rejection, provider cancellation/failure, restart/reload audiences and active-turn shutdown passed. Model provider: deterministic HTTP fixture.");
      console.log("Installed Gateway worker control: public admin RPC, signed capabilities/status/join/leave, strict policy and session checks, restart and owned-session cleanup on reload/shutdown passed. Media transport: deterministic fixture.");
    } catch (error) {
      throw new Error(`Installed agent integration failed: ${error.message}\n${output}`, { cause: error });
    } finally {
      for (const response of held) response.destroy();
      await stop();
    }
  } finally {
    await media.shutdown();
    worker.closeAllConnections();
    await new Promise((resolve) => worker.close(resolve));
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
}
