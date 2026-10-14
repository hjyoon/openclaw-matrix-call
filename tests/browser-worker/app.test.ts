import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBrowserWorker } from "../../packages/browser-worker/src/app.js";
import { configuration, credentials } from "../fixtures/browser.js";
import type { AgentTurn, ParticipantReference, PcmAudio } from "../../packages/core/src/index.js";

const { start, agentConnect, speechConnect } = vi.hoisted(() => ({ start: vi.fn(), agentConnect: vi.fn(), speechConnect: vi.fn() }));
vi.mock("../../packages/browser-worker/src/driver.js", () => ({ BrowserDriver: { start } }));
vi.mock("../../packages/agent-http/src/index.js", () => ({ HttpAgentAdapter: { connect: agentConnect } }));
vi.mock("../../packages/speech-http/src/index.js", () => ({ HttpSpeechAdapter: { connect: speechConnect } }));
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "matrix-call-browser-app-"));
  const secret = path.join(dir, "secret");
  const config = path.join(dir, "config.json");
  const identity = path.join(dir, "matrix.json");
  await writeFile(secret, "ab".repeat(32), { mode: 0o600 });
  await writeFile(identity, JSON.stringify(credentials), { mode: 0o600 });
  await writeFile(config, JSON.stringify({ ...configuration, credentialsFile: identity }));
  const driver = { available: true, verify: vi.fn(async (reference: ParticipantReference) => ({ ...reference, userId: configuration.owners[0]!, deviceId: "OWNER", expiresAtMs: Date.now() + 30000, mediaEncrypted: true, deviceVerified: true })), publish: vi.fn(async (_audio: PcmAudio) => {}), onAudio: vi.fn((_listener: (reference: ParticipantReference, audio: PcmAudio) => Promise<void>) => {}), connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), close: vi.fn(async () => {}), onEnded: vi.fn((_listener: () => Promise<void>) => {}) };
  start.mockReset().mockResolvedValue(driver);
  const agent = { id: "http-test", historyMode: "messages", check: vi.fn(async (_signal: AbortSignal) => {}), reply: vi.fn(async (_turn: AgentTurn) => ({ text: "Agent reply" })) };
  const speech = { check: vi.fn(async (_signal: AbortSignal) => {}), transcribe: vi.fn(async () => "Transcript"), synthesize: vi.fn(async () => ({ samples: new Int16Array([1, 2]), sampleRate: 16_000, channels: 1 as const })) };
  agentConnect.mockReset().mockResolvedValue(agent); speechConnect.mockReset().mockResolvedValue(speech);
  const voiceFile = path.join(dir, "voice.json"); const agentSecret = path.join(dir, "agent"); const speechSecret = path.join(dir, "speech");
  const enableVoice = async () => {
    await writeFile(agentSecret, "cd".repeat(32), { mode: 0o600 }); await writeFile(speechSecret, "ef".repeat(32), { mode: 0o600 });
    await writeFile(voiceFile, JSON.stringify({ agentId: "assistant", agent: { baseUrl: "https://agent.example.org", secretFile: agentSecret }, speech: { baseUrl: "https://speech.example.org", secretFile: speechSecret } }));
    await writeFile(config, JSON.stringify({ ...configuration, credentialsFile: identity, voiceFile }));
  };
  return { dir, secret, driver, agent, speech, enableVoice, agentSecret, speechSecret, env: { MATRIX_CALL_SECRET_FILE: secret, MATRIX_CALL_PORT: "0", MATRIX_CALL_BROWSER_CONFIG: config }, clean: () => rm(dir, { recursive: true, force: true }) };
}

describe("browser worker application", () => {
  it("reports readiness only for a live driver and authenticated voice services without running a turn", async () => {
    const f = await fixture(); await f.enableVoice(); const worker = await startBrowserWorker(f.env);
    try {
      const url = `http://127.0.0.1:${(worker.server.address() as { port: number }).port}/readyz`;
      expect((await fetch(url)).status).toBe(200);
      expect(f.agent.check).toHaveBeenCalledOnce(); expect(f.speech.check).toHaveBeenCalledOnce();
      expect(f.agent.reply).not.toHaveBeenCalled(); expect(f.speech.transcribe).not.toHaveBeenCalled();
      f.driver.available = false; expect((await fetch(url)).status).toBe(503);
      expect(f.agent.check).toHaveBeenCalledOnce();
    } finally { await worker.close(); await f.clean(); }
  });

  it.each(["agent", "speech"])("reports unavailable after %s service authentication changes", async (service) => {
    const f = await fixture(); await f.enableVoice(); const worker = await startBrowserWorker(f.env);
    try {
      (service === "agent" ? f.agent : f.speech).check.mockRejectedValueOnce(new Error("private backend error"));
      const response = await fetch(`http://127.0.0.1:${(worker.server.address() as { port: number }).port}/readyz`);
      expect(response.status).toBe(503); expect(await response.text()).not.toContain("private");
    } finally { await worker.close(); await f.clean(); }
  });

  it("does not remain ready when the driver closes during a service check", async () => {
    const f = await fixture(); await f.enableVoice(); const worker = await startBrowserWorker(f.env);
    try {
      f.agent.check.mockImplementationOnce(async () => { f.driver.available = false; });
      expect((await fetch(`http://127.0.0.1:${(worker.server.address() as { port: number }).port}/readyz`)).status).toBe(503);
    } finally { await worker.close(); await f.clean(); }
  });

  it("keeps a media-only worker unavailable as an assistant", async () => {
    const f = await fixture(); const worker = await startBrowserWorker(f.env);
    try { expect((await fetch(`http://127.0.0.1:${(worker.server.address() as { port: number }).port}/readyz`)).status).toBe(503); }
    finally { await worker.close(); await f.clean(); }
  });

  it("wires optional authenticated speech and agent ports without giving participant text control of endpoints", async () => {
    const f = await fixture(); await f.enableVoice(); const worker = await startBrowserWorker(f.env);
    try {
      expect(worker.voice).toBeDefined(); expect(start.mock.calls[0]![2]).toBe(true);
      expect(agentConnect).toHaveBeenCalledWith(expect.objectContaining({ secret: "cd".repeat(32), timeoutMs: 30000 }));
      expect(speechConnect).toHaveBeenCalledWith(expect.objectContaining({ secret: "ef".repeat(32), allowInsecureLoopback: false }));
      await worker.media.join({ roomId: "!room" }, new AbortController().signal);
      await f.driver.onAudio.mock.calls[0]![0]({ roomId: "!room", rtcSessionId: "m.call#ROOM", participantId: "speaker" }, { samples: new Int16Array([1]), sampleRate: 16000, channels: 1 });
      expect(f.agent.reply.mock.calls[0]![0].messages[0]!.text).toBe("Transcript");
      expect(f.driver.publish).toHaveBeenCalledOnce(); await worker.media.endSession();
      expect(f.driver.disconnect).toHaveBeenCalledOnce();
    } finally { await worker.close(); await f.clean(); }
  });

  it("cancels voice work when the portable media session ends", async () => {
    const f = await fixture(); await f.enableVoice(); const worker = await startBrowserWorker(f.env);
    try {
      await worker.media.join({ roomId: "!room" }, new AbortController().signal);
      f.agent.reply.mockImplementationOnce(() => new Promise(() => {}));
      const pending = f.driver.onAudio.mock.calls[0]![0]({ roomId: "!room", rtcSessionId: "m.call#ROOM", participantId: "speaker" }, { samples: new Int16Array([1]), sampleRate: 16000, channels: 1 });
      const assertion = expect(pending).rejects.toThrow("call-closed");
      await vi.waitFor(() => expect(f.agent.reply).toHaveBeenCalled());
      await worker.media.endSession(); await assertion; expect(f.speech.synthesize).not.toHaveBeenCalled();
    } finally { await worker.close(); await f.clean(); }
  });

  it.each(["agent", "speech"])("does not start Matrix crypto when %s authentication fails", async (service) => {
    const f = await fixture(); await f.enableVoice();
    (service === "agent" ? agentConnect : speechConnect).mockRejectedValueOnce(new Error("private provider error"));
    try { await expect(startBrowserWorker(f.env)).rejects.toThrow(/^Voice services could not be authenticated$/); expect(start).not.toHaveBeenCalled(); }
    finally { await f.clean(); }
  });

  it.each(["agent", "speech"])("rejects reuse of the control secret by %s", async (service) => {
    const f = await fixture(); await f.enableVoice(); await writeFile(service === "agent" ? f.agentSecret : f.speechSecret, "ab".repeat(32));
    try { await expect(startBrowserWorker(f.env)).rejects.toThrow("must be separate"); expect(start).not.toHaveBeenCalled(); }
    finally { await f.clean(); }
  });

  it("cleans optional voice state if listener registration or HTTP startup fails", async () => {
    const f = await fixture(); await f.enableVoice(); f.driver.onAudio.mockImplementationOnce(() => { throw new Error("registration failed"); });
    try { await expect(startBrowserWorker(f.env)).rejects.toThrow("registration failed"); expect(f.driver.close).toHaveBeenCalledOnce(); }
    finally { await f.clean(); }
  });

  it("serves the portable control plane and releases an idle browser on shutdown", async () => {
    const f = await fixture(); const worker = await startBrowserWorker(f.env);
    try {
      const port = (worker.server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await response.json()).toMatchObject({ transports: ["media-control"] });
      expect(worker.driver).toBe(f.driver);
      await worker.close(); await worker.close();
      expect(f.driver.close).toHaveBeenCalledOnce();
    } finally { await worker.close(); await f.clean(); }
  });

  it("ends failed calls without restoring authority and disables a failed driver", async () => {
    const f = await fixture(); const worker = await startBrowserWorker(f.env);
    try {
      const notify = f.driver.onEnded.mock.calls[0]![0];
      await notify();
      await worker.media.join({ roomId: "!room" }, new AbortController().signal);
      await notify();
      expect(worker.media.status().session).toBeNull(); expect(worker.media.status().available).toBe(true);
      f.driver.available = false;
      await notify();
      expect(worker.media.status().available).toBe(false);
      expect(worker.server.listening).toBe(false);
    } finally { await worker.close(); await f.clean(); }
  });

  it("cancels a pending media session and still closes the browser after transport failure", async () => {
    const f = await fixture(); const worker = await startBrowserWorker(f.env);
    try {
      const pending = worker.media.join({ roomId: "!room" }, new AbortController().signal).catch((error: Error) => error);
      await worker.media.endSession();
      expect(await pending).toBeInstanceOf(Error);
      await worker.media.join({ roomId: "!room" }, new AbortController().signal);
      f.driver.disconnect.mockRejectedValue(new Error("cleanup failed"));
      await expect(worker.close()).rejects.toThrow("backend-failed");
      expect(f.driver.close).toHaveBeenCalledOnce();
    } finally { await worker.close().catch(() => {}); await f.clean(); }
  });

  it("validates control authentication before starting a Matrix client", async () => {
    const f = await fixture();
    try {
      await writeFile(f.secret, "invalid-control-key");
      await expect(startBrowserWorker(f.env)).rejects.toThrow("invalid-auth");
      expect(start).not.toHaveBeenCalled();
      await writeFile(f.secret, "ab".repeat(32));
      await expect(startBrowserWorker({ MATRIX_CALL_SECRET_FILE: f.secret })).rejects.toThrow("must be absolute");
    } finally { await f.clean(); }
  });

  it("releases a started browser when the control port is occupied", async () => {
    const f = await fixture(); const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      await expect(startBrowserWorker({ ...f.env, MATRIX_CALL_PORT: String((server.address() as { port: number }).port) })).rejects.toThrow("EADDRINUSE");
      expect(f.driver.close).toHaveBeenCalledOnce();
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.clean(); }
  });

  it("starts through the actual process entry and logs only public service state", async () => {
    const f = await fixture();
    for (const [name, value] of Object.entries(f.env)) vi.stubEnv(name, value);
    vi.stubEnv("MATRIX_CALL_HOST", undefined);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { worker } = await import("../../packages/browser-worker/src/main.js");
    try {
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ event: "browser-worker-started", voiceEnabled: false, port: (worker.server.address() as { port: number }).port });
      expect(JSON.stringify(log.mock.calls)).not.toContain(credentials.accessToken);
    } finally { await worker.close(); await f.clean(); }
  });
});
