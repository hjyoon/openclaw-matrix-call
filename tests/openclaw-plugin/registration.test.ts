import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import plugin, { matrixCallChannel } from "../../packages/openclaw-plugin/src/index.js";

const policy = { owners: ["@owner:example.org"], rooms: ["!room:example.org"], agents: ["assistant"] };
const enabled = { channels: { "matrix-call": { enabled: true, policy } } } satisfies OpenClawConfig;

describe("native SDK registration", () => {
  it.each(["full", "discovery", "cli-metadata", "tool-discovery"])("loads through the real channel SDK in %s mode", (registrationMode) => {
    const registerChannel = vi.fn();
    const registerCommand = vi.fn();
    const api = { registrationMode, registerChannel, registerCommand } as unknown as OpenClawPluginApi;
    plugin.register(api);
    expect(plugin.id).toBe("matrix-call");
    expect(plugin.channelPlugin).toBe(matrixCallChannel);
    expect(plugin.configSchema).toBeDefined();
    if (registrationMode === "full" || registrationMode === "discovery") {
      expect(registerChannel).toHaveBeenCalledWith({ plugin: matrixCallChannel });
    } else expect(registerChannel).not.toHaveBeenCalled();
    if (registrationMode === "full" || registrationMode === "tool-discovery") {
      const command = registerCommand.mock.calls[0]![0];
      expect(command.name).toBe("matrixcall");
      expect(command.requireAuth).toBe(true);
      expect(command.handler().text).toContain("RTC audio is not implemented");
    } else expect(registerCommand).not.toHaveBeenCalled();
  });
});

describe("development channel configuration", () => {
  it("describes one default account without advertising available audio", async () => {
    expect(matrixCallChannel.config.listAccountIds({})).toEqual(["default"]);
    expect(matrixCallChannel.config.defaultAccountId!({})).toBe("default");
    const account = matrixCallChannel.config.resolveAccount({});
    expect(account.enabled).toBe(false);
    expect(matrixCallChannel.config.isEnabled!(account, {})).toBe(false);
    expect(await matrixCallChannel.config.isConfigured!(account, {})).toBe(false);
    expect(matrixCallChannel.config.unconfiguredReason!(account, {})).toContain("not implemented");
    expect(matrixCallChannel.capabilities.media).toBe(false);
    expect(matrixCallChannel.configSchema!.schema).toBeDefined();
  });

  it("accepts explicit policy while remaining unconfigured until RTC is implemented", async () => {
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
    { channels: { "matrix-call": { enabled: false, unexpected: true } } },
    { channels: { "matrix-call": { enabled: true, policy: { ...policy, owners: [] } } } },
  ])("rejects invalid or incomplete configuration %#", (cfg) => {
    expect(() => matrixCallChannel.config.resolveAccount(cfg)).toThrow("invalid-input");
  });

  it("rejects an unknown account", () => {
    expect(() => matrixCallChannel.config.resolveAccount({}, "other")).toThrow("invalid-input");
  });
});
