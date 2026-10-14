import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { HttpAgentAdapter } from "../../packages/agent-http/src/index.js";
import { createNativeAgentService } from "../../packages/openclaw-plugin/src/service.js";
import { request } from "../fixtures/agent.js";

const secret = "ab".repeat(32);
const policy = { owners: [request.caller.userId], rooms: [request.caller.roomId], agents: ["assistant"] };
type Runner = PluginRuntime["agent"]["runCommandFromIngress"];
const result = { payloads: [], meta: { durationMs: 1, finalAssistantVisibleText: "Hello 한국어" } };

async function freePort(host: string) {
  const server = createServer();
  server.listen(0, host);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return port;
}

async function fixture(host = "127.0.0.1") {
  const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-native-test-"));
  const secretFile = path.join(directory, "agent.secret");
  await writeFile(secretFile, secret + "\n", { mode: 0o600 });
  const port = await freePort(host);
  const settings = { secretFile, host, port, timeoutMs: 30_000 };
  const context: OpenClawPluginServiceContext = {
    config: { channels: { "matrix-call": { enabled: true, policy, agentService: settings } } },
    stateDir: directory,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const run = vi.fn<Runner>().mockResolvedValue(result);
  const runtime = { version: "2026.10.2", agent: { runCommandFromIngress: run } } as unknown as PluginRuntime;
  const service = createNativeAgentService({ runtime } as OpenClawPluginApi);
  const baseUrl = `http://${host === "::1" ? "[::1]" : host}:${port}`;
  const cleanup = async () => { await service.stop!(context); await rm(directory, { recursive: true, force: true }); };
  return { directory, context, settings, runtime, service, run, baseUrl, cleanup };
}

function turn() {
  return { ...request, turnId: randomUUID(), conversationId: randomUUID(), caller: { ...request.caller, expiresAtMs: Date.now() + 60_000 }, signal: new AbortController().signal };
}

describe("native signed agent service lifecycle", () => {
  it.each(["127.0.0.1", "::1"])("serves delegated SDK ingress on %s without logging command output", async (host) => {
    const test = await fixture(host);
    try {
      expect(test.service.reload).toEqual({ configPrefixes: ["channels.matrix-call"] });
      test.run.mockImplementationOnce(async (options, runtime) => {
        expect(options.senderIsOwner).toBe(false);
        expect(options.toolsAllow).toEqual([]);
        expect(options.allowModelOverride).toBe(false);
        runtime.log("private prompt and reply");
        runtime.error("private provider credential");
        return result;
      });
      await test.service.start(test.context);
      const agent = await HttpAgentAdapter.connect({ baseUrl: test.baseUrl, secret });
      expect(agent.historyMode).toBe("host-session");
      expect(await agent.reply(turn())).toEqual({ text: "Hello 한국어" });
      expect(test.context.logger.info).toHaveBeenCalledExactlyOnceWith("Matrix Call agent service started with delegated, tool-free ingress");
      expect(test.context.logger.error).toHaveBeenCalledExactlyOnceWith("Matrix Call agent command failed");
    } finally { await test.cleanup(); }
  });

  it.each([{}, { enabled: false }, { enabled: true, policy }])("leaves the service inactive until explicitly configured %#", async (account) => {
    const test = await fixture();
    test.context.config = { channels: { "matrix-call": account } };
    try {
      await test.service.start(test.context);
      await test.service.stop!(test.context);
      await test.service.stop!(test.context);
      expect(test.context.logger.info).not.toHaveBeenCalled();
      expect(test.run).not.toHaveBeenCalled();
      await expect(fetch(test.baseUrl + "/capabilities")).rejects.toThrow();
    } finally { await test.cleanup(); }
  });

  it("reloads policy with a fresh audience and rejects the old adapter", async () => {
    const test = await fixture();
    try {
      await test.service.start(test.context);
      const old = await HttpAgentAdapter.connect({ baseUrl: test.baseUrl, secret });
      await old.reply(turn());
      test.context.config = { channels: { "matrix-call": { enabled: true, policy: { ...policy, owners: ["@other:example.org"] }, agentService: test.settings } } };
      await test.service.start(test.context);
      await expect(old.reply(turn())).rejects.toThrow("http-error");
      const agent = await HttpAgentAdapter.connect({ baseUrl: test.baseUrl, secret });
      await expect(agent.reply(turn())).rejects.toThrow("http-error");
      expect(test.run).toHaveBeenCalledTimes(1);
    } finally { await test.cleanup(); }
  });

  it("serializes concurrent start and stop calls", async () => {
    const test = await fixture();
    try {
      const first = test.service.start(test.context);
      const second = test.service.start(test.context);
      const stop = test.service.stop!(test.context);
      await Promise.all([first, second, stop]);
      await expect(fetch(test.baseUrl + "/capabilities")).rejects.toThrow();
      expect(test.context.logger.info).toHaveBeenCalledTimes(2);
    } finally { await test.cleanup(); }
  });

  it("does not let the SDK command runtime terminate the hosting Gateway", async () => {
    const test = await fixture();
    test.run.mockImplementationOnce(async (_options, runtime) => { runtime.exit(1); return result; });
    try {
      await test.service.start(test.context);
      const agent = await HttpAgentAdapter.connect({ baseUrl: test.baseUrl, secret });
      await expect(agent.reply(turn())).rejects.toThrow("http-error");
      expect(await agent.reply(turn())).toEqual({ text: "Hello 한국어" });
    } finally { await test.cleanup(); }
  });

  it("propagates worker disconnect to the host signal", async () => {
    const test = await fixture();
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    let cancelled!: () => void;
    const ended = new Promise<void>((resolve) => { cancelled = resolve; });
    test.run.mockImplementationOnce((options) => new Promise((_resolve, reject) => {
      options.abortSignal!.addEventListener("abort", () => { cancelled(); reject(options.abortSignal!.reason); }, { once: true });
      started();
    }));
    try {
      await test.service.start(test.context);
      const agent = await HttpAgentAdapter.connect({ baseUrl: test.baseUrl, secret });
      const controller = new AbortController();
      const response = agent.reply({ ...turn(), signal: controller.signal });
      const rejected = expect(response).rejects.toThrow();
      await began;
      controller.abort();
      await ended;
      await rejected;
    } finally { await test.cleanup(); }
  });

  it("waits for an unfinished cancelled host turn before allowing service replacement", async () => {
    const test = await fixture();
    let finish!: () => void;
    let observed!: AbortSignal;
    test.settings.timeoutMs = 20;
    test.run.mockImplementationOnce((options) => {
      observed = options.abortSignal!;
      return new Promise((resolve) => { finish = () => resolve(result); });
    });
    try {
      await test.service.start(test.context);
      const agent = await HttpAgentAdapter.connect({ baseUrl: test.baseUrl, secret });
      await expect(agent.reply(turn())).rejects.toThrow("http-error");
      expect(observed.aborted).toBe(true);
      let restarted = false;
      const restart = Promise.resolve(test.service.start(test.context)).then(() => { restarted = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(restarted).toBe(false);
      finish();
      await restart;
      const replacement = await HttpAgentAdapter.connect({ baseUrl: test.baseUrl, secret });
      expect(await replacement.reply(turn())).toEqual({ text: "Hello 한국어" });
    } finally { finish(); await test.cleanup(); }
  });

  it.each(["missing", "directory", "symlink", "hardlink", "oversized", "invalid-secret", "version", "invalid-account"])("redacts %s startup failure and recovers on a later start", async (kind) => {
    const test = await fixture();
    const original = test.settings.secretFile;
    try {
      const invalid = path.join(test.directory, "private-failure");
      if (kind === "directory") await mkdir(invalid);
      if (kind === "symlink") await symlink(original, invalid);
      if (kind === "hardlink") await link(original, invalid);
      if (kind === "oversized") await writeFile(invalid, "ab".repeat(33));
      if (kind === "invalid-secret") await writeFile(invalid, "private-invalid-credential");
      test.settings.secretFile = invalid;
      if (kind === "version") { test.settings.secretFile = original; test.runtime.version = "2026.10.3"; }
      if (kind === "invalid-account") test.context.config = { channels: { "matrix-call": { enabled: true } } };
      await expect(test.service.start(test.context)).rejects.toThrow(/^Matrix Call agent service could not start$/);
      if (kind === "hardlink") await rm(invalid);
      test.settings.secretFile = original;
      test.runtime.version = "2026.10.2";
      test.context.config = { channels: { "matrix-call": { enabled: true, policy, agentService: test.settings } } };
      await test.service.start(test.context);
      const agent = await HttpAgentAdapter.connect({ baseUrl: test.baseUrl, secret });
      expect(await agent.reply(turn())).toEqual({ text: "Hello 한국어" });
    } finally { await test.cleanup(); }
  });

  it("cleans up a failed listener and can start after its port becomes available", async () => {
    const test = await fixture();
    const occupied = createServer();
    occupied.listen(test.settings.port, test.settings.host);
    await once(occupied, "listening");
    try {
      await expect(test.service.start(test.context)).rejects.toThrow(/^Matrix Call agent service could not start$/);
      await new Promise<void>((resolve) => { occupied.close(() => resolve()); });
      await test.service.start(test.context);
      const agent = await HttpAgentAdapter.connect({ baseUrl: test.baseUrl, secret });
      expect(await agent.reply(turn())).toEqual({ text: "Hello 한국어" });
    } finally { occupied.close(); await test.cleanup(); }
  });
});
