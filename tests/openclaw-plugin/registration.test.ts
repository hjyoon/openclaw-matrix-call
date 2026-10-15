import { describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig, OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { createWorkerServer, WorkerMediaController } from "../../packages/worker/src/index.js";
import plugin, { matrixCallChannel } from "../../packages/openclaw-plugin/src/index.js";

const policy = { owners: ["@owner:example.org"], rooms: ["!room:example.org"], agents: ["assistant"] };
const enabled = { channels: { "matrix-call": { enabled: true, policy } } } satisfies OpenClawConfig;

describe("native SDK registration", () => {
  it.each(["full", "discovery", "cli-metadata", "tool-discovery"])("loads through the real channel SDK in %s mode", async (registrationMode) => {
    const registerChannel = vi.fn();
    const registerCommand = vi.fn();
    const registerService = vi.fn();
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();
    const api = { registrationMode, registerChannel, registerCommand, registerService, registerGatewayMethod, registerTool, lifecycle: {} } as unknown as OpenClawPluginApi;
    plugin.register(api);
    expect(plugin.id).toBe("matrix-call");
    expect(plugin.channelPlugin).toBe(matrixCallChannel);
    expect(plugin.configSchema).toBeDefined();
    if (registrationMode === "full" || registrationMode === "discovery") {
      expect(registerChannel).toHaveBeenCalledWith({ plugin: matrixCallChannel });
    } else expect(registerChannel).not.toHaveBeenCalled();
    if (registrationMode === "full" || registrationMode === "tool-discovery") {
      expect(registerTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ contextVersion: 2, create: expect.any(Function) }), { name: "matrix_call", optional: true });
      const command = registerCommand.mock.calls[0]![0];
      expect(command.name).toBe("matrixcall");
      expect(command.requireAuth).toBe(true);
      expect(command.channels).toEqual(["matrix"]);
      const result = await command.handler({ channel: "matrix", isAuthorizedSender: true, senderId: policy.owners[0] } as PluginCommandContext);
      expect(result.text).toContain("forbidden");
    } else { expect(registerCommand).not.toHaveBeenCalled(); expect(registerTool).not.toHaveBeenCalled(); }
    if (registrationMode === "full") {
      expect(registerService.mock.calls.map(([service]) => service.id)).toEqual(["matrix-call-agent", "matrix-call-worker"]);
      expect(registerGatewayMethod).toHaveBeenCalledWith("matrixcall.control", expect.any(Function), { scope: "operator.admin", profileAccess: "independent" });
    } else { expect(registerService).not.toHaveBeenCalled(); expect(registerGatewayMethod).not.toHaveBeenCalled(); }
  });

  it.each([
    [undefined, "forbidden"], [(): boolean => false, "forbidden"], [(): boolean => true, "worker-unavailable"],
    [(): boolean => { throw new Error("private transport error"); }, "control-failed"],
  ] as const)("requires current Gateway authority and redacts transport errors %#", async (authority, reason) => {
    const registerGatewayMethod = vi.fn();
    plugin.register({ registrationMode: "full", registerChannel: vi.fn(), registerCommand: vi.fn(), registerService: vi.fn(), registerGatewayMethod, registerTool: vi.fn(), lifecycle: {} } as unknown as OpenClawPluginApi);
    const handler = registerGatewayMethod.mock.calls[0]![1];
    const respond = vi.fn();
    await handler({ params: { operation: "status" }, respond, hasCurrentClientAuthority: authority });
    expect(respond).toHaveBeenCalledWith(false, undefined, { code: "UNAVAILABLE", message: `Matrix Call control unavailable: ${reason}` });
  });

  it("registers a live admin RPC with successful controls and a final authority check", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-rpc-test-"));
    const secret = "ab".repeat(32);
    const secretFile = path.join(directory, "control.secret");
    await writeFile(secretFile, secret, { mode: 0o600 });
    const media = new WorkerMediaController({ rooms: policy.rooms, transport: { connect: async () => {}, disconnect: async () => {} } });
    const { server } = createWorkerServer(secret, media);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const context: OpenClawPluginServiceContext = {
      config: { channels: { "matrix-call": { enabled: true, policy, workerControl: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secretFile, allowInsecureLoopback: true } } } },
      stateDir: directory, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
    const registerGatewayMethod = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
    const runInBackgroundContext = <T>(operation: () => T): T => operation();
    plugin.register({ registrationMode: "full", registerChannel: vi.fn(), registerCommand: vi.fn(), registerService, registerGatewayMethod, registerTool: vi.fn(), lifecycle: { runInBackgroundContext } } as unknown as OpenClawPluginApi);
    const service = registerService.mock.calls[1]![0] as OpenClawPluginService;
    const handler = registerGatewayMethod.mock.calls[0]![1];
    const respond = vi.fn();
    const invoke = (params: Record<string, unknown>, authority = () => true) => handler({ params, respond, hasCurrentClientAuthority: authority } as unknown as Parameters<typeof handler>[0]);
    try {
      await service.start(context);
      await invoke({ operation: "status" });
      expect(respond).toHaveBeenLastCalledWith(true, { available: true, session: null });
      await invoke({ operation: "join", roomId: policy.rooms[0] });
      expect(respond).toHaveBeenLastCalledWith(true, expect.objectContaining({ roomId: policy.rooms[0], state: "connected" }));
      await invoke({ operation: "join", roomId: policy.rooms[0] });
      expect(respond).toHaveBeenLastCalledWith(false, undefined, { code: "UNAVAILABLE", message: "Matrix Call control unavailable: busy" });
      let checks = 0;
      await invoke({ operation: "status" }, () => ++checks < 4);
      expect(respond).toHaveBeenLastCalledWith(false, undefined, { code: "UNAVAILABLE", message: "Matrix Call control unavailable: forbidden" });
    } finally {
      await service.stop!(context);
      await media.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("development channel configuration", () => {
  it.each(["complete", "agent", "worker", "disabled", "policy"])("reports %s native calling configuration accurately", async (state) => {
    const cfg = { channels: { "matrix-call": { enabled: true, policy,
      agentService: { secretFile: "/private/agent.secret" },
      workerControl: { baseUrl: "https://worker.example.org", secretFile: "/private/control.secret" } } } };
    const complete = matrixCallChannel.config.resolveAccount(cfg);
    const account = { ...complete,
      ...(state === "agent" ? { agentService: undefined } : {}),
      ...(state === "worker" ? { workerControl: undefined } : {}),
      ...(state === "disabled" ? { enabled: false } : {}),
      ...(state === "policy" ? { policy: undefined } : {}),
    };
    expect(await matrixCallChannel.config.isConfigured!(account, cfg)).toBe(state === "complete");
  });

  it("describes one default account without advertising available audio", async () => {
    expect(matrixCallChannel.config.listAccountIds({})).toEqual(["default"]);
    expect(matrixCallChannel.config.defaultAccountId!({})).toBe("default");
    const account = matrixCallChannel.config.resolveAccount({});
    expect(account.enabled).toBe(false);
    expect(account.thirdPartyCalls).toBe(false);
    expect(matrixCallChannel.config.isEnabled!(account, {})).toBe(false);
    expect(await matrixCallChannel.config.isConfigured!(account, {})).toBe(false);
    expect(matrixCallChannel.config.unconfiguredReason!(account, {})).toContain("agent service");
    expect(matrixCallChannel.capabilities.media).toBe(false);
    expect(matrixCallChannel.configSchema!.schema).toBeDefined();
  });

  it("accepts explicit policy while remaining unconfigured until native calls are wired", async () => {
    const account = matrixCallChannel.config.resolveAccount(enabled, "default");
    expect(account.enabled).toBe(true);
    expect(Object.isFrozen(account)).toBe(true);
    expect(matrixCallChannel.config.isEnabled!(account, enabled)).toBe(true);
    expect(await matrixCallChannel.config.isConfigured!(account, enabled)).toBe(false);
    expect(matrixCallChannel.config.resolveAllowFrom!({ cfg: enabled })).toEqual(policy.owners);
    expect(matrixCallChannel.config.resolveAllowFrom!({ cfg: { channels: {} } })).toEqual([]);
  });

  it.each([
    { channels: { "matrix-call": { enabled: true } } },
    { channels: { "matrix-call": { enabled: true, policy, thirdPartyCalls: true } } },
    { channels: { "matrix-call": { enabled: true, policy, selfCalls: false, thirdPartyCalls: true } } },
    { channels: { "matrix-call": { enabled: false, unexpected: true } } },
    { channels: { "matrix-call": { enabled: true, policy: { ...policy, owners: [] } } } },
    ...[
      { secretFile: "relative" }, { secretFile: "/secret", host: "0.0.0.0" },
      { secretFile: "/secret", port: 0 }, { secretFile: "/secret", port: 65536 },
      { secretFile: "/secret", timeoutMs: 0 }, { secretFile: "/secret", timeoutMs: 300001 },
      { secretFile: "/secret", secret: "inline" },
    ].map((agentService) => ({ channels: { "matrix-call": { enabled: true, policy, agentService } } })),
    ...[
      { baseUrl: "invalid", secretFile: "/secret" }, { baseUrl: "https://worker", secretFile: "relative" },
      { baseUrl: "https://worker", secretFile: "/secret", timeoutMs: 0 },
      { baseUrl: "https://worker", secretFile: "/secret", timeoutMs: 300001 },
      { baseUrl: "https://worker", secretFile: "/secret", allowInsecureLoopback: "yes" },
      { baseUrl: "https://worker", secretFile: "/secret", secret: "inline" },
    ].map((workerControl) => ({ channels: { "matrix-call": { enabled: true, policy, workerControl } } })),
  ])("rejects invalid or incomplete configuration %#", (cfg) => {
    expect(() => matrixCallChannel.config.resolveAccount(cfg)).toThrow("invalid-input");
  });

  it("rejects an unknown account", () => {
    expect(() => matrixCallChannel.config.resolveAccount({}, "other")).toThrow("invalid-input");
  });

  it("enables third-party recipient selection independently of control-owner admission", () => {
    const cfg = { channels: { "matrix-call": { enabled: true, policy, selfCalls: true, thirdPartyCalls: true } } };
    expect(matrixCallChannel.config.resolveAccount(cfg).thirdPartyCalls).toBe(true);
    expect(matrixCallChannel.config.resolveAllowFrom!({ cfg })).toEqual(policy.owners);
  });

  it("defaults a configured agent service to bounded loopback operation", () => {
    const account = matrixCallChannel.config.resolveAccount({ channels: { "matrix-call": { enabled: true, policy, agentService: { secretFile: "/private/secret" } } } });
    expect(account.agentService).toEqual({ secretFile: "/private/secret", host: "127.0.0.1", port: 19793, timeoutMs: 30000 });
    expect(Object.isFrozen(account.agentService)).toBe(true);
  });

  it("defaults worker control to encrypted transport and bounded operations", () => {
    const account = matrixCallChannel.config.resolveAccount({ channels: { "matrix-call": { enabled: true, policy, workerControl: { baseUrl: "https://worker.example.org", secretFile: "/private/control.secret" } } } });
    expect(account.workerControl).toEqual({ baseUrl: "https://worker.example.org", secretFile: "/private/control.secret", timeoutMs: 35000, allowInsecureLoopback: false });
    expect(Object.isFrozen(account.workerControl)).toBe(true);
  });
});
