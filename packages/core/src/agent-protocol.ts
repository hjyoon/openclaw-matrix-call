import { z } from "zod";
import { conversationSchema } from "./conversation.js";
import { CallError, participantSchema } from "./policy.js";

export const agentRequestSchema = z.strictObject({
  protocolVersion: z.literal(1),
  conversationId: z.uuid(),
  turnId: z.uuid(),
  agentId: z.string().min(1).max(512),
  caller: participantSchema,
  messages: conversationSchema.unwrap().shape.messages.unwrap().min(1).readonly(),
}).readonly();

export const agentResponseSchema = z.strictObject({
  protocolVersion: z.literal(1),
  conversationId: z.uuid(),
  turnId: z.uuid(),
  text: z.string().trim().min(1).max(16_000),
}).readonly();

export const agentCapabilitiesSchema = z.strictObject({
  protocolVersion: z.literal(1),
  audience: z.uuid(),
  historyMode: z.enum(["messages", "host-session"]),
}).readonly();

export type AgentRequest = z.infer<typeof agentRequestSchema>;
export type AgentResponse = z.infer<typeof agentResponseSchema>;

export function parseAgentRequest(value: unknown): AgentRequest {
  const result = agentRequestSchema.safeParse(value);
  if (!result.success) throw new CallError("invalid-input");
  return result.data;
}
