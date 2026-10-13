import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseVoiceConfig, readVoiceConfig } from "../../packages/browser-worker/src/voice-config.js";

const configuration = { agentId: "assistant", agent: { baseUrl: "https://agent.example.org/v1/agent", secretFile: "/run/secrets/agent" },
  speech: { baseUrl: "https://speech.example.org/v1/speech", secretFile: "/run/secrets/speech" } };

describe("explicit portable voice configuration", () => {
  it("defaults bounded deadlines and freezes operator-owned endpoints", () => {
    const config = parseVoiceConfig(configuration);
    expect(config).toMatchObject({ timeoutMs: 90000, requestTimeoutMs: 30000, allowInsecureLoopback: false });
    expect(Object.isFrozen(config)).toBe(true); expect(Object.isFrozen(config.agent)).toBe(true); expect(Object.isFrozen(config.speech)).toBe(true);
  });

  it.each([
    { ...configuration, agentId: "host/session" }, { ...configuration, owner: true },
    { ...configuration, agent: { ...configuration.agent, secretFile: "relative" } },
    { ...configuration, timeoutMs: 0 }, { ...configuration, requestTimeoutMs: 300001 },
  ])("rejects unsupported, incomplete and unbounded configuration %#", (value) => {
    expect(() => parseVoiceConfig(value)).toThrow();
  });

  it.each(["http://localhost", "http://remote.example.org", "ftp://localhost", "https://user:password@example.org", "https://example.org?token=secret", "https://example.org#fragment"])
    ("rejects unsafe or implicit plaintext endpoint %s", (baseUrl) => {
      expect(() => parseVoiceConfig({ ...configuration, speech: { ...configuration.speech, baseUrl } })).toThrow("Invalid voice service endpoint");
    });

  it("permits explicit loopback HTTP without extending it to private or public hostnames", () => {
    expect(parseVoiceConfig({ ...configuration, allowInsecureLoopback: true, agent: { ...configuration.agent, baseUrl: "http://[::1]/v1/agent" } }).agent.baseUrl).toBe("http://[::1]/v1/agent");
    expect(() => parseVoiceConfig({ ...configuration, allowInsecureLoopback: true, speech: { ...configuration.speech, baseUrl: "http://private.example.org" } })).toThrow();
  });

  it("loads separate dedicated secrets from external files and redacts read or validation errors", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "matrix-call-voice-config-")); const file = path.join(dir, "voice.json");
    const agent = path.join(dir, "agent"); const speech = path.join(dir, "speech");
    try {
      await writeFile(file, JSON.stringify({ ...configuration, agent: { ...configuration.agent, secretFile: agent }, speech: { ...configuration.speech, secretFile: speech } }));
      await expect(readVoiceConfig(file)).rejects.toThrow("Invalid voice configuration or secret file");
      await writeFile(agent, `${"cd".repeat(32)}\n`, { mode: 0o600 }); await writeFile(speech, "ef".repeat(32), { mode: 0o600 });
      expect(await readVoiceConfig(file)).toMatchObject({ agentSecret: "cd".repeat(32), speechSecret: "ef".repeat(32) });
      for (const [left, right] of [["private-invalid-secret", "ef".repeat(32)], ["cd".repeat(32), "private-invalid-secret"], ["cd".repeat(32), "cd".repeat(32)]]) {
        await writeFile(agent, left!); await writeFile(speech, right!);
        await expect(readVoiceConfig(file)).rejects.toThrow(/^Invalid voice configuration or secret file$/);
      }
      await writeFile(file, "{"); await expect(readVoiceConfig(file)).rejects.toThrow("Invalid voice configuration or secret file");
      await expect(readVoiceConfig("relative")).rejects.toThrow("must be absolute");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
