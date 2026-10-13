import { z } from "zod";
import type { ConversationRecord, ConversationStore } from "./contracts.js";
import { CallError, matrixRoomIdSchema } from "./policy.js";

export const conversationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  roomId: matrixRoomIdSchema,
  rtcSessionId: z.string().min(1).max(512),
  agentId: z.string().min(1).max(512),
  createdAtMs: z.number().int().nonnegative(),
  status: z.enum(["active", "closed"]),
  messages: z.array(z.strictObject({
    role: z.enum(["user", "assistant"]),
    text: z.string().trim().min(1).max(16_000),
    senderId: z.string().min(1).max(512),
    timestampMs: z.number().int().nonnegative(),
  }).readonly()).max(256).readonly(),
}).readonly();

export function parseConversation(value: unknown): ConversationRecord {
  const result = conversationSchema.safeParse(value);
  if (!result.success) throw new CallError("invalid-input");
  return result.data;
}

export function exportConversation(record: ConversationRecord): string {
  return JSON.stringify(parseConversation(record));
}

export function importConversation(json: string): ConversationRecord {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new CallError("invalid-input");
  }
  return parseConversation(value);
}

export class MemoryConversationStore implements ConversationStore {
  readonly #records = new Map<string, ConversationRecord>();

  constructor(readonly maxRecords = 1024) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 65_536) throw new CallError("invalid-input");
  }

  async put(record: ConversationRecord): Promise<void> {
    const parsed = parseConversation(record);
    if (!this.#records.has(parsed.id) && this.#records.size >= this.maxRecords) {
      this.#records.delete(this.#records.keys().next().value!);
    }
    this.#records.set(parsed.id, parsed);
  }

  async get(id: string): Promise<ConversationRecord | undefined> {
    return this.#records.get(id);
  }
}
