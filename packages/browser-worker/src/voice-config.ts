import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

const endpointSchema = z.strictObject({ baseUrl: z.string().url().max(4096), secretFile: z.string().refine(isAbsolute) });
const schema = z.strictObject({
  agentId: z.string().min(1).max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  agent: endpointSchema, speech: endpointSchema,
  timeoutMs: z.number().int().min(1).max(300_000).default(90_000),
  requestTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  allowInsecureLoopback: z.boolean().default(false),
});

export function parseVoiceConfig(value: unknown) {
  const config = schema.parse(value);
  for (const { baseUrl } of [config.agent, config.speech]) {
    const url = new URL(baseUrl);
    const local = config.allowInsecureLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !local)) {
      throw new Error("Invalid voice service endpoint");
    }
  }
  return Object.freeze({ ...config, agent: Object.freeze(config.agent), speech: Object.freeze(config.speech) });
}

export async function readVoiceConfig(file: string) {
  if (!isAbsolute(file)) throw new Error("Voice config path must be absolute");
  try {
    const config = parseVoiceConfig(JSON.parse(await readFile(file, "utf8")));
    const agentSecret = (await readFile(config.agent.secretFile, "utf8")).trim();
    const speechSecret = (await readFile(config.speech.secretFile, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(agentSecret) || !/^[0-9a-f]{64}$/.test(speechSecret) || agentSecret === speechSecret) {
      throw new Error("Invalid dedicated voice secrets");
    }
    return Object.freeze({ ...config, agentSecret, speechSecret });
  } catch { throw new Error("Invalid voice configuration or secret file"); }
}
