import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { MemoryConversationStore, RequestAuthenticator } from "@matrix-call/core";
import { HttpAgentAdapter } from "../../agent-http/src/index.js";
import { HttpSpeechAdapter } from "../../speech-http/src/index.js";
import { VoiceAssistant, speakReply } from "../../voice/src/index.js";
import { startWorker, readWorkerConfig, WorkerMediaController, MediaControlError, type MediaDialRequest } from "../../worker/src/index.js";
import { readBrowserConfig } from "./config.js";
import { BrowserDriver } from "./driver.js";
import { readVoiceConfig } from "./voice-config.js";

export async function startBrowserWorker(env: NodeJS.ProcessEnv = process.env) {
  const workerConfig = readWorkerConfig(env);
  const controlSecret = (await readFile(workerConfig.secretFile, "utf8")).trim();
  new RequestAuthenticator({ secret: controlSecret, audience: randomUUID() });
  const config = await readBrowserConfig(env.MATRIX_CALL_BROWSER_CONFIG ?? "");
  const voiceConfig = config.voiceFile ? await readVoiceConfig(config.voiceFile) : undefined;
  if (voiceConfig && [voiceConfig.agentSecret, voiceConfig.speechSecret].includes(controlSecret)) throw new Error("Voice secrets must be separate from control authentication");
  let ports: { agent: HttpAgentAdapter; speech: HttpSpeechAdapter } | undefined;
  if (voiceConfig) {
    const results = await Promise.allSettled([
      HttpAgentAdapter.connect({ baseUrl: voiceConfig.agent.baseUrl, secret: voiceConfig.agentSecret, timeoutMs: voiceConfig.requestTimeoutMs }),
      HttpSpeechAdapter.connect({ baseUrl: voiceConfig.speech.baseUrl, secret: voiceConfig.speechSecret, timeoutMs: voiceConfig.requestTimeoutMs, allowInsecureLoopback: voiceConfig.allowInsecureLoopback }),
    ]);
    if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled") throw new Error("Voice services could not be authenticated");
    ports = { agent: results[0].value, speech: results[1].value };
  }
  const driver = await BrowserDriver.start(config, undefined, Boolean(ports));
  const makeVoice = (owners = config.policy.owners, rooms = config.policy.rooms) => ports && voiceConfig ? new VoiceAssistant({
    policy: { owners, rooms, agents: [voiceConfig.agentId] },
    agentId: voiceConfig.agentId, agent: ports.agent, store: new MemoryConversationStore(1),
    recognition: ports.speech, synthesis: ports.speech, verifier: driver, transport: driver, timeoutMs: voiceConfig.timeoutMs,
  }) : undefined;
  let voice = makeVoice();
  let opening = false;
  const outbound = ports ? {
    async dial(request: MediaDialRequest, signal: AbortSignal) {
      opening = true;
      try {
        await voice!.endSession();
        voice = request.selfCall ? makeVoice([request.recipientId], [request.roomId]) : makeVoice();
        await driver.connect(request.roomId, signal, { recipientId: request.recipientId, ringTimeoutMs: request.ringTimeoutMs, ...(request.selfCall === undefined ? {} : { selfCall: request.selfCall }) });
        const reference = await driver.waitForRecipient(request.recipientId, signal);
        await speakReply(request.message, { synthesis: ports.speech, transport: driver, verify: async () => {
          const proof = await driver.verify(reference, signal);
          if (proof.userId !== request.recipientId) throw new Error("Outbound recipient identity changed");
          return proof;
        } }, signal);
      } finally { opening = false; }
    },
    async recipientRoom(recipientId: string, preferredRoomId: string | undefined, signal: AbortSignal) {
      try { return await driver.recipientRoom(recipientId, preferredRoomId, signal); }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("Recipient device verification required")) throw new MediaControlError("verification-required");
        if (message.includes("Private encrypted two-person room required")) throw new MediaControlError("private-room-required");
        throw error;
      }
    },
  } : {};
  const transport = {
    ...outbound,
    async connect(roomId: string, signal: AbortSignal) { await voice?.endSession(); voice = makeVoice(); await driver.connect(roomId, signal); },
    async disconnect() { try { await voice?.endSession(); } finally { await driver.disconnect(); } },
  };
  const media = new WorkerMediaController({ rooms: config.policy.rooms, transport, recipients: ports ? config.policy.owners : [], selfCalls: config.policy.selfCalls === true });
  try {
    if (voice) driver.onAudio(async (reference, audio) => { if (!opening) await voice!.receive(reference, audio); });
    const worker = await startWorker(env, media, async () => { try { await voice?.endSession(); } finally { await driver.close(); } }, async (signal) => {
      if (!ports || !driver.available) return false;
      await Promise.all([ports.agent.check(signal), ports.speech.check(signal)]);
      return driver.available;
    });
    driver.onEnded(() => driver.available ? media.endSession() : worker.close());
    return Object.freeze({ ...worker, driver, media, get voice() { return voice; } });
  } catch (error) { try { await voice?.endSession(); } finally { await driver.close(); } throw error; }
}
