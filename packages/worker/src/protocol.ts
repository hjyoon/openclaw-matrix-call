import { z } from "zod";
import { matrixRoomIdSchema } from "@matrix-call/core";

const sessionIdSchema = z.uuid().transform((value) => value.toLowerCase());
export const mediaJoinSchema = z.strictObject({ roomId: matrixRoomIdSchema, sessionId: sessionIdSchema.optional() });
export const mediaLeaveSchema = z.strictObject({ sessionId: sessionIdSchema });
export const mediaStatusRequestSchema = z.strictObject({});
export const mediaSessionSchema = z.strictObject({
  sessionId: z.uuid(), roomId: matrixRoomIdSchema, state: z.enum(["connecting", "connected", "closing"]),
}).readonly();
export const mediaJoinResponseSchema = mediaSessionSchema.unwrap().extend({ state: z.literal("connected") }).readonly();
export const mediaStatusSchema = z.strictObject({ available: z.boolean(), session: mediaSessionSchema.nullable() }).readonly();
export const mediaLeaveResponseSchema = z.strictObject({ closed: z.literal(true) }).readonly();
export const workerCapabilitiesSchema = z.strictObject({ protocolVersion: z.literal(1), audience: z.uuid(), mediaControl: z.boolean(), clientSessionIds: z.literal(true) }).readonly();
export const mediaErrorSchema = z.strictObject({ error: z.enum([
  "invalid-request", "forbidden-room", "busy", "not-found", "closed", "backend-failed", "transport-unavailable",
  "session-reused", "capacity-exceeded",
]) }).readonly();

export type MediaSessionSnapshot = z.infer<typeof mediaSessionSchema>;
export type MediaStatusSnapshot = z.infer<typeof mediaStatusSchema>;
export type MediaRemoteError = z.infer<typeof mediaErrorSchema>["error"];
