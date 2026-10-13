import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentPort, AgentReply, CallPolicy, ConversationRecord, ConversationStore, ParticipantVerifier,
} from "./contracts.js";
import { parseConversation } from "./conversation.js";
import { authorizeParticipant, CallError, parsePolicy, participantReferenceSchema } from "./policy.js";

const openSchema = z.strictObject({
  reference: participantReferenceSchema,
  agentId: z.string().min(1).max(512),
});
const textSchema = z.string().trim().min(1).max(16_000);
const replySchema = z.strictObject({ text: textSchema });

type ActiveCall = {
  record: ConversationRecord;
  controller: AbortController;
  busy: boolean;
  write: Promise<void>;
};

export type CallCoordinatorOptions = {
  policy: CallPolicy;
  verifier: ParticipantVerifier;
  agent: AgentPort;
  store: ConversationStore;
  maxCalls?: number;
  now?: () => number;
};

export class CallCoordinator {
  readonly #policy: CallPolicy;
  readonly #verifier: ParticipantVerifier;
  readonly #agent: AgentPort;
  readonly #store: ConversationStore;
  readonly #maxCalls: number;
  readonly #now: () => number;
  readonly #calls = new Map<string, ActiveCall>();
  readonly #sessions = new Set<string>();

  constructor({ policy, verifier, agent, store, maxCalls = 8, now = Date.now }: CallCoordinatorOptions) {
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 64) {
      throw new CallError("invalid-input");
    }
    this.#policy = parsePolicy(policy);
    this.#verifier = verifier;
    this.#agent = agent;
    this.#store = store;
    this.#maxCalls = maxCalls;
    this.#now = now;
  }

  async open(input: unknown): Promise<ConversationRecord> {
    const parsed = openSchema.safeParse(input);
    if (!parsed.success) throw new CallError("invalid-input");
    const { reference, agentId } = parsed.data;
    if (!this.#policy.rooms.includes(reference.roomId) || !this.#policy.agents.includes(agentId)) {
      throw new CallError("forbidden");
    }
    const session = JSON.stringify([reference.roomId, reference.rtcSessionId]);
    if (this.#sessions.has(session)) throw new CallError("call-busy");
    if (this.#sessions.size >= this.#maxCalls) throw new CallError("capacity-exceeded");
    this.#sessions.add(session);
    const controller = new AbortController();
    try {
      const participant = await this.#verifier.verify(reference, controller.signal);
      authorizeParticipant(this.#policy, reference, participant, this.#now());
      const record = parseConversation({
        schemaVersion: 1,
        id: randomUUID(),
        roomId: reference.roomId,
        rtcSessionId: reference.rtcSessionId,
        agentId,
        createdAtMs: this.#now(),
        status: "active",
        messages: [],
      });
      await this.#store.put(record);
      this.#calls.set(record.id, { record, controller, busy: false, write: Promise.resolve() });
      return record;
    } catch (error) {
      this.#sessions.delete(session);
      throw error;
    }
  }

  async turn(id: string, participantId: string, text: unknown): Promise<AgentReply> {
    const entry = this.#entry(id);
    const parsed = textSchema.safeParse(text);
    if (!parsed.success) throw new CallError("invalid-input");
    if (entry.busy) throw new CallError("call-busy");
    if (entry.record.messages.length >= 256) throw new CallError("capacity-exceeded");
    entry.busy = true;
    const signal = entry.controller.signal;
    try {
      const parsedReference = participantReferenceSchema.safeParse({
        roomId: entry.record.roomId,
        rtcSessionId: entry.record.rtcSessionId,
        participantId,
      });
      if (!parsedReference.success) throw new CallError("invalid-input");
      const reference = parsedReference.data;
      const participant = await this.#verifier.verify(reference, signal);
      signal.throwIfAborted();
      const caller = authorizeParticipant(this.#policy, reference, participant, this.#now());
      const messages = parseConversation({
        ...entry.record,
        messages: [...entry.record.messages, {
          role: "user", text: parsed.data, senderId: caller.userId, timestampMs: this.#now(),
        }],
      }).messages;
      const reply = await this.#agent.reply(Object.freeze({
        protocolVersion: 1,
        conversationId: id,
        turnId: randomUUID(),
        agentId: entry.record.agentId,
        caller,
        messages,
        signal,
      }));
      signal.throwIfAborted();
      const validated = replySchema.safeParse(reply);
      if (!validated.success) throw new CallError("invalid-agent-reply");
      const record = parseConversation({
        ...entry.record,
        messages: [...messages, {
          role: "assistant", text: validated.data.text,
          senderId: entry.record.agentId, timestampMs: this.#now(),
        }],
      });
      await this.#persist(entry, record);
      signal.throwIfAborted();
      entry.record = record;
      return Object.freeze(validated.data);
    } finally {
      entry.busy = false;
    }
  }

  async close(id: string): Promise<void> {
    const entry = this.#entry(id);
    entry.controller.abort(new CallError("call-closed"));
    entry.record = parseConversation({ ...entry.record, status: "closed" });
    this.#calls.delete(id);
    this.#sessions.delete(JSON.stringify([entry.record.roomId, entry.record.rtcSessionId]));
    await this.#persist(entry, entry.record);
  }

  #entry(id: string): ActiveCall {
    const entry = this.#calls.get(id);
    if (!entry) throw new CallError("unknown-call");
    return entry;
  }

  #persist(entry: ActiveCall, record: ConversationRecord): Promise<void> {
    entry.write = entry.write.catch(() => undefined).then(() => this.#store.put(record));
    return entry.write;
  }
}
