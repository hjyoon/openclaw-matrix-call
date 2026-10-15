import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBrowserConfig, readBrowserConfig } from "../../packages/browser-worker/src/config.js";
import { credentials, configuration } from "../fixtures/browser.js";

describe("browser worker configuration", () => {
  it("separates credentials from frozen policy and uses a stable profile origin", () => {
    const config = parseBrowserConfig({ ...configuration, owners: [...configuration.owners, ...configuration.owners], rooms: ["!room", "!room"] }, credentials);
    expect(config.assetPort).toBe(19791);
    expect(config.credentials).toEqual(credentials);
    expect(config.policy).toEqual({ owners: configuration.owners, rooms: ["!room"], focusUrls: configuration.focusUrls, sfuUrls: configuration.sfuUrls, devices: configuration.devices, allowInsecureLoopback: false, roomAliasFormat: "json-array" });
    for (const value of [config, config.credentials, config.policy, ...Object.values(config.policy).filter(Array.isArray), config.policy.devices[0]]) expect(Object.isFrozen(value)).toBe(true);
  });

  it("permits explicitly opted-in loopback endpoints for isolated checks", () => {
    expect(parseBrowserConfig({ ...configuration, allowInsecureLoopback: true, focusUrls: ["http://localhost:8080/"], sfuUrls: ["ws://[::1]:7880/"] }, { ...credentials, baseUrl: "http://127.0.0.1:8008/" }).credentials.baseUrl).toBe("http://127.0.0.1:8008");
  });

  it("preserves an explicitly selected room alias format and rejects automatic negotiation", () => {
    expect(parseBrowserConfig({ ...configuration, roomAliasFormat: "legacy-pipe" }, credentials).policy.roomAliasFormat).toBe("legacy-pipe");
    expect(() => parseBrowserConfig({ ...configuration, roomAliasFormat: "auto" }, credentials)).toThrow();
  });

  it.each(["http://focus.example.org", "https://user:password@focus.example.org", "https://focus.example.org?q=1", "https://focus.example.org/#fragment"])("rejects insecure or ambiguous endpoints: %s", (url) => {
    expect(() => parseBrowserConfig({ ...configuration, focusUrls: [url] }, credentials)).toThrow("Invalid browser worker endpoint");
  });

  it("rejects remote plaintext endpoints even with the loopback option", () => {
    expect(() => parseBrowserConfig({ ...configuration, allowInsecureLoopback: true, sfuUrls: ["ws://sfu.example.org"] }, credentials)).toThrow("Invalid browser worker endpoint");
    expect(() => parseBrowserConfig({ ...configuration, allowInsecureLoopback: true, focusUrls: ["ws://localhost:8080"] }, credentials)).toThrow("Invalid browser worker endpoint");
    expect(() => parseBrowserConfig({ ...configuration, allowInsecureLoopback: true, sfuUrls: ["http://localhost:7880"] }, credentials)).toThrow("Invalid browser worker endpoint");
  });

  it.each([
    { ...configuration, devices: [{ ...configuration.devices[0], userId: "@unknown:example.org" }] },
    { ...configuration, devices: [...configuration.devices, ...configuration.devices] },
  ])("rejects unauthorized or ambiguous device enrollment", (value) => {
    expect(() => parseBrowserConfig(value, credentials)).toThrow("Invalid browser worker device pins");
  });

  it.each([{ ...configuration, credentialsFile: "relative" }, { ...configuration, assetPort: 0 }, { ...configuration, extra: true }, { ...configuration, rooms: ["#alias:example.org"] }])("rejects invalid paths, ports, fields, and room aliases", (value) => {
    expect(() => parseBrowserConfig(value, credentials)).toThrow();
  });

  it("reads external files and redacts malformed configuration and credentials", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-config-"));
    const file = path.join(directory, "config.json");
    const secret = path.join(directory, "credentials.json");
    try {
      await writeFile(secret, JSON.stringify(credentials), { mode: 0o600 });
      await writeFile(file, JSON.stringify({ ...configuration, credentialsFile: secret }));
      expect((await readBrowserConfig(file)).credentials).toEqual(credentials);
      await writeFile(secret, '{"accessToken":"sensitive-data"');
      await expect(readBrowserConfig(file)).rejects.toThrow(/^Invalid browser worker configuration or credential file$/);
      await expect(readBrowserConfig("relative")).rejects.toThrow("must be absolute");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

it("enrolls compared non-owner devices only with explicit self-call support", () => {
  const value = { ...configuration, selfCalls: true, devices: [{ ...configuration.devices[0]!, userId: "@visitor:example.org" }] };
  expect(parseBrowserConfig(value, credentials).policy.selfCalls).toBe(true);
  expect(() => parseBrowserConfig({ ...value, selfCalls: false }, credentials)).toThrow("Invalid browser worker device pins");
});
