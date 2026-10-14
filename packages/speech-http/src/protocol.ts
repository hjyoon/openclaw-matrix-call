import { z } from "zod";
import { validatePcm, type PcmAudio } from "@matrix-call/core";

export const speechCapabilitiesSchema = z.strictObject({
  protocolVersion: z.literal(1), audience: z.uuid(),
  recognition: z.literal(true), synthesis: z.literal(true), encoding: z.literal("pcm-s16le"),
});

export const wirePcmSchema = z.strictObject({
  encoding: z.literal("pcm-s16le"), sampleRate: z.number().int().min(8000).max(48_000),
  channels: z.literal(1), data: z.string().min(4).max(1_280_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).superRefine((audio, context) => {
  const bytes = Buffer.from(audio.data, "base64");
  if (bytes.toString("base64") !== audio.data || bytes.length % 2 !== 0 || bytes.length > audio.sampleRate * 20) {
    context.addIssue({ code: "custom", message: "Invalid PCM payload" });
  }
});

const envelope = { protocolVersion: z.literal(1), requestId: z.uuid() };
export const transcriptionRequestSchema = z.strictObject({ ...envelope, audio: wirePcmSchema });
export const transcriptionResponseSchema = z.strictObject({ ...envelope, text: z.string().trim().max(16_000) });
export const synthesisRequestSchema = z.strictObject({ ...envelope, text: z.string().trim().min(1).max(16_000) });
export const synthesisResponseSchema = z.strictObject({ ...envelope, audio: wirePcmSchema });
export const synthesisLimitResponseSchema = z.strictObject({ ...envelope, error: z.literal("synthesis-too-long") });

export function encodePcm(audio: PcmAudio): z.infer<typeof wirePcmSchema> {
  validatePcm(audio);
  const bytes = Buffer.alloc(audio.samples.byteLength);
  for (let i = 0; i < audio.samples.length; i++) bytes.writeInt16LE(audio.samples[i]!, i * 2);
  return { encoding: "pcm-s16le", sampleRate: audio.sampleRate, channels: 1, data: bytes.toString("base64") };
}

export function decodePcm(value: unknown): PcmAudio {
  const audio = wirePcmSchema.parse(value);
  const bytes = Buffer.from(audio.data, "base64");
  const samples = new Int16Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
  return Object.freeze({ samples, sampleRate: audio.sampleRate, channels: 1 });
}
