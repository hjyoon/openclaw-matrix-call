import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { agentResponseSchema, parseAgentRequest, RequestAuthenticator } from "../../dist/core/index.js";
import { readLiveModel } from "./live-model.mjs";
import { installMatrixMessaging } from "./matrix-messaging.mjs";

const exec = promisify(execFile);

export async function startMatrixGateway({ root, directory, policy, workerUrl, controlSecretFile, reply, freePort, waitFor, observations, liveModelFile, longReply = false, onAssistant, matrixChat }) {
  const live = liveModelFile ? readLiveModel(liveModelFile) : undefined;
  await mkdir(directory, { mode: 0o700 });
  const env = Object.fromEntries(["PATH", "HOME", "USER", "SHELL", "TERM"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  Object.assign(env, { OPENCLAW_STATE_DIR: path.join(directory, "state"), OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
    OPENCLAW_HOME: path.join(directory, "home"), HOME: path.join(directory, "home"), OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SKIP_CANVAS_HOST: "1", CI: "true" });
  const agentSecret = randomBytes(32).toString("hex");
  const secretFile = path.join(directory, "agent.secret");
  await writeFile(secretFile, agentSecret, { mode: 0o600 });
  const allowed = ["matrix-call", ...(matrixChat ? ["matrix"] : []), ...(live ? [live.credential.provider] : []), ...(live?.settings.agentRuntime?.id === "codex" ? ["codex"] : [])];
  await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ plugins: { allow: allowed } }), { mode: 0o600 });
  const cli = path.join(root, "node_modules/.bin/openclaw");
  if (matrixChat) await installMatrixMessaging(root, directory, env);
  await exec("pnpm", ["--dir", path.join(root, "packages/openclaw-plugin"), "pack", "--pack-destination", directory], { cwd: root, env: { ...env, HOME: process.env.HOME } });
  const archive = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
  assert(archive);
  await exec(cli, ["plugins", "install", path.join(directory, archive), "--force", "--no-enable", "--accept-capabilities"], { cwd: directory, env, timeout: 60_000 });
  await exec(cli, ["plugins", "enable", "matrix-call"], { cwd: directory, env, timeout: 60_000 });
  const state = observations ?? { turns: [], replies: [], providerRequests: [], upstreamStatuses: [], transcriptions: [], syntheses: 0, invalidRequests: 0 };
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/chat/completions");
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert(size <= 2_000_000); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.providerRequests.push(input);
      assert(input.tools === undefined || input.tools.length === 0);
      const text = reply();
      const envelope = { id: "matrix-fixture", model: "fixture", created: 1 };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
    } catch { state.invalidRequests++; response.writeHead(500).end(); }
  });
  if (!live) { provider.listen(0, "127.0.0.1"); await once(provider, "listening"); }
  const gatewayPort = await freePort(); const agentPort = await freePort();
  const token = randomBytes(32).toString("hex");
  const workspace = path.join(directory, "workspace"); await mkdir(workspace, { mode: 0o700 });
  if (live) await writeFile(path.join(workspace, "AGENTS.md"), longReply
    ? "Reply in the user's language with a spoken explanation. For Korean, write 180 to 240 characters. For English, write 300 to 360 characters. Use complete short sentences. Do not use tools.\n"
    : "Reply to the user's speech with one short sentence in the user's language. Keep spoken replies concise. Do not use tools.\n", { mode: 0o600 });
  const patchFile = path.join(directory, "config.patch.json");
  let gateway; let exited; let client; let connected; let probe; let closing; let output = "";
  const stopGateway = async () => {
    client?.stop(); client = undefined; connected = undefined;
    if (!gateway) return;
    const process = gateway; process.kill("SIGTERM");
    const timeout = setTimeout(() => process.kill("SIGKILL"), 90_000);
    try { const exit = await exited; assert.equal(exit.code, 0, `Matrix Gateway shutdown: ${JSON.stringify(exit)} ${output}`); }
    finally { clearTimeout(timeout); gateway = undefined; }
  };
  const startGateway = () => {
    output = "";
    gateway = spawn(cli, ["gateway", "run", "--bind", "loopback", "--port", String(gatewayPort)], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
    exited = new Promise((resolve, reject) => { gateway.once("error", reject); gateway.once("exit", (code, signal) => resolve({ code, signal })); });
    for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString("utf8")).slice(-16_000); });
  };
  const close = () => closing ??= (async () => {
    try {
      await stopGateway();
    } finally {
      for (const server of [probe, provider]) {
        if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
      }
    }
  })();
  try {
    await writeFile(patchFile, JSON.stringify({
      gateway: { mode: "local", port: gatewayPort, bind: "loopback", auth: { mode: "token", token }, controlUi: { enabled: false } },
      plugins: { slots: { memory: "none" } },
      channels: { ...(matrixChat ? { matrix: matrixChat.config } : {}), "matrix-call": { enabled: true, policy, agentService: { secretFile, port: agentPort, timeoutMs: live ? 90_000 : 15_000 },
        ...(workerUrl ? { workerControl: { baseUrl: workerUrl, secretFile: controlSecretFile, allowInsecureLoopback: true, timeoutMs: 60_000 } } : {}) } },
      ...(matrixChat ? { commands: { text: true, allowFrom: { matrix: policy.owners }, ownerAllowFrom: policy.owners.map((id) => `matrix:${id}`) } } : {}),
      agents: { ownership: "explicit", defaults: { workspace, systemAgent: { agentId: "main" }, model: { primary: live?.model ?? "matrix-fixture/fixture" },
        ...(live ? { models: { [live.model]: live.settings }, thinkingDefault: live.thinking } : {}), heartbeat: { every: "0m", agentId: "main" } }, entries: { main: { workspace } } },
      ...(live ? { auth: { profiles: { [live.profileId]: { provider: live.credential.provider, mode: "oauth" } }, order: { [live.credential.provider]: [live.profileId] } } }
        : { models: { providers: { "matrix-fixture": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "isolated-fixture-key", api: "openai-completions", models: [{ id: "fixture", name: "Matrix integration fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 256 }] } } } }),
      cron: { enabled: false }, browser: { enabled: false }, logging: { level: "error", consoleLevel: "error", file: path.join(directory, "gateway.log") },
    }), { mode: 0o600 });
    await exec(cli, ["config", "patch", "--file", patchFile], { cwd: directory, env, timeout: 60_000 });
    if (live) await exec(process.execPath, [path.join(root, "scripts/integration/prepare-live-model.mjs"), liveModelFile], { cwd: directory, env, timeout: 30_000 });
    startGateway();
    const agentBase = `http://127.0.0.1:${agentPort}`;
    let audience;
    const authenticateAgent = () => waitFor(async () => {
      if (gateway.exitCode !== null) throw new Error(`Matrix Gateway startup: ${output}`);
      try {
        const response = await fetch(agentBase + "/capabilities", { signal: AbortSignal.timeout(500) });
        const body = await response.text();
        audience = JSON.parse(body).audience;
        new RequestAuthenticator({ secret: agentSecret, audience }).verify({ method: "RESPONSE_200", path: "/capabilities", body }, Object.fromEntries(response.headers));
        return response.status === 200;
      } catch { return false; }
    }, "Matrix Gateway agent listener", 45_000);
    await authenticateAgent();
    let auth = new RequestAuthenticator({ secret: agentSecret, audience });
    probe = createServer(async (request, response) => {
      const controller = new AbortController(); const abort = () => controller.abort(); response.on("close", abort);
      try {
        assert(["/capabilities", "/turns"].includes(request.url));
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; assert(size <= 1_048_576); chunks.push(chunk); }
        const body = Buffer.concat(chunks).toString("utf8");
        let turn;
        if (request.method === "POST") {
          auth.verify({ method: "POST", path: request.url, body }, request.headers);
          turn = parseAgentRequest(JSON.parse(body)); state.turns.push(turn);
        } else assert.equal(request.method, "GET");
        const upstream = await fetch(agentBase + request.url, { method: request.method, headers: request.headers,
          ...(request.method === "POST" ? { body } : {}), signal: controller.signal });
        const reply = await upstream.text(); assert(Buffer.byteLength(reply) <= 65_536);
        if (turn && upstream.status === 200) {
          auth.verify({ method: "RESPONSE_200", path: request.url, body: reply }, Object.fromEntries(upstream.headers));
          const result = agentResponseSchema.parse(JSON.parse(reply));
          assert.equal(result.conversationId, turn.conversationId); assert.equal(result.turnId, turn.turnId);
          state.replies.push(result);
        }
        state.upstreamStatuses.push(upstream.status);
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers)).end(reply);
      } catch { state.invalidRequests++; if (!response.destroyed) response.writeHead(500).end(); }
      finally { response.off("close", abort); }
    });
    probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const connectClient = async () => {
      connected ??= new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Matrix Gateway control connection timed out")), 30_000);
        client = new GatewayClient({ url: `ws://127.0.0.1:${gatewayPort}`, token, env, deviceIdentity: null,
          clientName: "cli", mode: "cli", scopes: ["operator.admin"],
          onEvent: (frame) => {
            if (frame.event === "agent" && frame.payload?.stream === "assistant"
              && (frame.payload.data?.delta || frame.payload.data?.text)) onAssistant?.({ runId: frame.payload.runId, sessionKey: frame.payload.sessionKey });
          },
          onHelloOk: () => { clearTimeout(timeout); resolve(); }, onConnectError: (error) => { clearTimeout(timeout); reject(error); } });
        client.start();
      });
      await connected;
    };
    const ready = async () => {
      await connectClient();
      await waitFor(async () => {
        try { return (await client.request("matrixcall.control", { operation: "status" })).available; }
        catch { return false; }
      }, "Matrix Gateway worker authentication", 60_000);
    };
    const control = async (_url) => {
      await ready();
      if (matrixChat) {
        await waitFor(async () => {
          const status = await client.request("channels.status", { probe: false });
          return status.channelAccounts?.matrix?.some((account) => account.running && account.connected && account.configured);
        }, "encrypted Matrix channel connection", 45_000);
        await matrixChat.prepare(waitFor);
        return (pathname, value) => matrixChat.request(pathname, value, waitFor);
      }
      return async (pathname, value) => {
        try { return { status: 200, value: await client.request("matrixcall.control", { operation: pathname.split("/").at(-1), ...value }, { timeoutMs: 70_000 }) }; }
        catch (error) {
          const code = error.message.split(": ").at(-1);
          const status = { forbidden: 403, "invalid-request": 400, "not-found": 404, busy: 409 }[code];
          if (!status) throw error;
          return { status, value: { error: code } };
        }
      };
    };
    const modelEvidence = async () => { await connectClient(); return client.request("sessions.list", { limit: 20 }); };
    const subscribe = async (id) => { await connectClient(); return client.request("sessions.messages.subscribe", { key: `agent:main:matrix-call:call:${id}` }); };
    const history = async (id) => { await connectClient(); return client.request("chat.history", { sessionKey: `agent:main:matrix-call:call:${id}`, limit: 20 }); };
    const conversationEvidence = async (id) => {
      const turns = state.turns.filter((turn) => turn.conversationId === id);
      const replies = state.replies.filter((reply) => reply.conversationId === id);
      assert(turns.length > 0); assert.equal(replies.length, turns.length);
      const messages = (await history(id)).messages;
      assert(Array.isArray(messages));
      const users = messages.filter((message) => message.role === "user");
      const assistants = messages.filter((message) => message.role === "assistant");
      const textOf = (message) => typeof message.content === "string" ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      assert.equal(users.length, turns.length); assert.equal(assistants.length, replies.length);
      for (let i = 0; i < turns.length; i++) {
        assert(textOf(users[i]).includes(turns[i].messages.at(-1).text), "Host user history mismatch");
        assert.equal(replies[i].turnId, turns[i].turnId);
        assert(textOf(assistants[i]).trim() === replies[i].text.trim(), "Host assistant history mismatch");
      }
      const evidence = await modelEvidence();
      const sessions = evidence.sessions.filter((session) => session.key === `agent:main:matrix-call:call:${id}`);
      assert.equal(sessions.length, 1);
      const session = sessions[0];
      assert.equal(`${session.modelProvider}/${session.model}`, live?.model ?? "matrix-fixture/fixture");
      assert(session.outputTokens > 0);
      return { model: session.model, provider: session.modelProvider, inputTokens: session.inputTokens,
        outputTokens: session.outputTokens, agentRuntime: session.agentRuntime?.id, userTurns: users.length, assistantReplies: assistants.length };
    };
    const restart = async () => {
      const previous = audience; const stale = auth; const requests = state.providerRequests.length;
      await stopGateway(); startGateway(); await authenticateAgent();
      assert.notEqual(audience, previous); auth = new RequestAuthenticator({ secret: agentSecret, audience });
      const body = "{}";
      const rejected = await fetch(agentBase + "/turns", { method: "POST", body,
        headers: { "content-type": "application/json", ...stale.sign({ method: "POST", path: "/turns", body }) }, signal: AbortSignal.timeout(5000) });
      assert.equal(rejected.status, 401); assert.equal(state.providerRequests.length, requests);
      return { agentAudienceChanged: true, staleAgentRequestRejected: true };
    };
    return { state, agentSecret, agentUrl: `http://127.0.0.1:${probe.address().port}`, control, close, restart, modelEvidence, conversationEvidence, subscribe,
      model: live?.model ?? "matrix-fixture/fixture", live: Boolean(live) };
  } catch (error) { await close(); throw new Error(`Matrix Gateway integration failed: ${error.message}\n${output}`, { cause: error }); }
}
