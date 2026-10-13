import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute).refine((value) => !value.includes("\0"));
const language = z.enum(["auto", "ko", "en"]);
const modelSchema = z.strictObject({
  file: absolutePath, bytes: z.number().int().min(1).max(2_147_483_647), sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const configSchema = z.strictObject({
  secretFile: absolutePath, host: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
  port: z.number().int().min(0).max(65_535).default(19792), temporaryDir: absolutePath.default(tmpdir()),
  timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
  whisper: z.strictObject({ binary: absolutePath, model: modelSchema, language: language.default("auto"), threads: z.number().int().min(1).max(8).default(2) }),
  espeak: z.strictObject({ binary: absolutePath, language: language.default("auto"), wordsPerMinute: z.number().int().min(80).max(300).default(175) }),
});

export async function readSpeechConfig(env: NodeJS.ProcessEnv = process.env) {
  try {
    const file = absolutePath.parse(env.MATRIX_CALL_SPEECH_CONFIG ?? "/run/config/speech.json");
    return Object.freeze(configSchema.parse(JSON.parse(await readFile(file, "utf8"))));
  } catch { throw new Error("Invalid speech worker configuration"); }
}

export async function verifySpeechModel(value: unknown): Promise<void> {
  try {
    const model = modelSchema.parse(value);
    const file = await open(model.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size !== model.bytes) throw new Error("Invalid model file");
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > model.bytes) throw new Error("Model changed during verification");
        hash.update(chunk);
      }
      if (bytes !== model.bytes || hash.digest("hex") !== model.sha256) throw new Error("Model integrity mismatch");
    } finally { await file.close(); }
  } catch { throw new Error("Invalid speech model"); }
}
