import { z } from "zod";
import { matrixRoomIdSchema } from "@matrix-call/core";

const sessionIdSchema = z.uuid().transform((value) => value.toLowerCase());
export const mediaJoinSchema = z.strictObject({ roomId: matrixRoomIdSchema, sessionId: sessionIdSchema.optional() });
export const mediaDialSchema = mediaJoinSchema.extend({
  recipientId: z.string().max(255).regex(/^@[^:\s]+:[^\s]+$/),
  message: z.string().trim().min(1).max(1000),
  ringTimeoutMs: z.number().int().min(1000).max(60_000).default(20_000),
  selfCall: z.boolean().optional(),
});
export const recipientRoomSchema = z.strictObject({ recipientId: mediaDialSchema.shape.recipientId, preferredRoomId: matrixRoomIdSchema.optional() });
export const recipientRoomResponseSchema = z.strictObject({ recipientId: mediaDialSchema.shape.recipientId, roomId: matrixRoomIdSchema });
export const mediaLeaveSchema = z.strictObject({ sessionId: sessionIdSchema });
export const mediaStatusRequestSchema = z.strictObject({});
export const mediaSessionSchema = z.strictObject({
  sessionId: z.uuid(), roomId: matrixRoomIdSchema, state: z.enum(["connecting", "ringing", "connected", "closing"]),
}).readonly();
export const mediaJoinResponseSchema = mediaSessionSchema.unwrap().extend({ state: z.literal("connected") }).readonly();
export const mediaStatusSchema = z.strictObject({ available: z.boolean(), session: mediaSessionSchema.nullable() }).readonly();
export const mediaLeaveResponseSchema = z.strictObject({ closed: z.literal(true) }).readonly();
export const workerCapabilitiesSchema = z.strictObject({ protocolVersion: z.literal(1), audience: z.uuid(), mediaControl: z.boolean(), clientSessionIds: z.literal(true), outboundCalls: z.boolean().optional(), selfCalls: z.boolean().optional() }).readonly();
export const mediaErrorSchema = z.strictObject({ error: z.enum([
  "invalid-request", "forbidden-room", "busy", "not-found", "closed", "backend-failed", "transport-unavailable",
  "session-reused", "capacity-exceeded", "forbidden-recipient", "private-room-required", "verification-required",
]) }).readonly();

export type MediaSessionSnapshot = z.infer<typeof mediaSessionSchema>;
export type MediaStatusSnapshot = z.infer<typeof mediaStatusSchema>;
export type MediaRemoteError = z.infer<typeof mediaErrorSchema>["error"];
export type MediaDialRequest = z.infer<typeof mediaDialSchema>;
