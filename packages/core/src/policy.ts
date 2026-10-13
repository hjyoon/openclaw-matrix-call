import { z } from "zod";
import type { CallPolicy, ParticipantReference, VerifiedParticipant } from "./contracts.js";

const nonempty = z.string().min(1).max(512);
const matrixUserId = nonempty.regex(/^@[^:\s]+:[^\s]+$/);
export const matrixRoomIdSchema = nonempty.regex(/^![^:\s]+:[^\s]+$/);

export const policySchema = z.strictObject({
  owners: z.array(matrixUserId).min(1).max(256).readonly(),
  rooms: z.array(matrixRoomIdSchema).min(1).max(256).readonly(),
  agents: z.array(nonempty.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)).min(1).max(256).readonly(),
}).readonly();

export const participantReferenceSchema = z.strictObject({
  roomId: matrixRoomIdSchema,
  rtcSessionId: nonempty,
  participantId: nonempty,
}).readonly();

export const participantSchema = z.strictObject({
  ...participantReferenceSchema.unwrap().shape,
  userId: matrixUserId,
  deviceId: nonempty,
  expiresAtMs: z.number().int().nonnegative(),
  deviceVerified: z.boolean(),
  mediaEncrypted: z.boolean(),
}).readonly();

export type CallErrorCode =
  | "invalid-input"
  | "forbidden"
  | "identity-mismatch"
  | "expired-membership"
  | "unverified-device"
  | "unencrypted-media"
  | "unknown-call"
  | "call-busy"
  | "call-closed"
  | "capacity-exceeded"
  | "invalid-agent-reply";

export class CallError extends Error {
  constructor(readonly code: CallErrorCode) {
    super(code);
    this.name = "CallError";
  }
}

export function parsePolicy(value: unknown): CallPolicy {
  const result = policySchema.safeParse(value);
  if (!result.success) throw new CallError("invalid-input");
  return result.data;
}

export function authorizeParticipant(
  policy: CallPolicy,
  reference: ParticipantReference,
  participant: VerifiedParticipant,
  nowMs: number,
): VerifiedParticipant {
  const result = participantSchema.safeParse(participant);
  if (!result.success) throw new CallError("invalid-input");
  const verified = result.data;
  if (
    verified.roomId !== reference.roomId ||
    verified.rtcSessionId !== reference.rtcSessionId ||
    verified.participantId !== reference.participantId
  ) throw new CallError("identity-mismatch");
  if (!policy.rooms.includes(verified.roomId) || !policy.owners.includes(verified.userId)) {
    throw new CallError("forbidden");
  }
  if (verified.expiresAtMs <= nowMs) throw new CallError("expired-membership");
  if (!verified.deviceVerified) throw new CallError("unverified-device");
  if (!verified.mediaEncrypted) throw new CallError("unencrypted-media");
  return verified;
}
