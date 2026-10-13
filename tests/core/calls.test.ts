import { describe, expect, it, vi } from "vitest";
import { CallCoordinator, CallError, MemoryConversationStore } from "../../packages/core/src/index.js";
import type {
  AgentPort, AgentTurn, ConversationRecord, ConversationStore, VerifiedParticipant,
} from "../../packages/core/src/index.js";

const policy = {
  owners: ["@owner:example.org"], rooms: ["!room:example.org"], agents: ["assistant", "other-agent"],
};
const reference = {
  roomId: "!room:example.org", rtcSessionId: "rtc-1", participantId: "participant-1",
};
const verified: VerifiedParticipant = {
  ...reference, userId: policy.owners[0]!, deviceId: "DEVICE", expiresAtMs: 2_000,
  deviceVerified: true, mediaEncrypted: true,
};
const input = { reference, agentId: "assistant" };

function setup(overrides: { agent?: AgentPort; store?: ConversationStore; maxCalls?: number } = {}) {
  const verify = vi.fn(async (ref: typeof reference) => ({ ...verified, ...ref }));
  const reply = vi.fn(async () => ({ text: "Response" }));
  const store = overrides.store ?? new MemoryConversationStore();
  const calls = new CallCoordinator({
    policy, verifier: { verify }, agent: overrides.agent ?? { id: "test", historyMode: "messages", reply },
    store, maxCalls: overrides.maxCalls ?? 8, now: () => 1_000,
  });
  return { calls, verify, reply, store };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("independent call lifecycle", () => {
  it("uses defaults and creates a neutral UUID conversation", async () => {
    const { verify, reply, store } = setup();
    const calls = new CallCoordinator({
      policy, verifier: { verify }, agent: { id: "custom", historyMode: "messages", reply }, store,
    });
    verify.mockResolvedValue({ ...verified, expiresAtMs: Date.now() + 10_000 });
    const record = await calls.open(input);
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.createdAtMs).toBeGreaterThan(0);
    expect(record.messages).toEqual([]);
    expect(record.status).toBe("active");
  });

  it.each([0, -1, 65, 1.5, NaN])("rejects invalid capacity %s", (maxCalls) => {
    expect(() => setup({ maxCalls })).toThrowError(new CallError("invalid-input"));
  });

  it.each([null, {}, { ...input, owner: true }])("rejects invalid open request %#", async (value) => {
    const { calls, verify } = setup();
    await expect(calls.open(value)).rejects.toThrowError(new CallError("invalid-input"));
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, reference: { ...reference, roomId: "!other:example.org" } },
    { ...input, agentId: "unlisted-agent" },
  ])("rejects unlisted rooms and agents before verification %#", async (value) => {
    const { calls, verify } = setup();
    await expect(calls.open(value)).rejects.toThrowError(new CallError("forbidden"));
    expect(verify).not.toHaveBeenCalled();
  });

  it("prevents duplicate openings while verification is pending", async () => {
    const { calls, verify } = setup({ maxCalls: 1 });
    const gate = deferred<VerifiedParticipant>();
    verify.mockReturnValueOnce(gate.promise);
    const opening = calls.open(input);
    await expect(calls.open(input)).rejects.toThrowError(new CallError("call-busy"));
    await expect(calls.open({ ...input, reference: { ...reference, rtcSessionId: "rtc-2" } }))
      .rejects.toThrowError(new CallError("capacity-exceeded"));
    gate.resolve(verified);
    const record = await opening;
    await calls.close(record.id);
    expect((await calls.open(input)).id).not.toBe(record.id);
  });

  it("releases a reservation when verification fails", async () => {
    const { calls, verify } = setup({ maxCalls: 1 });
    verify.mockRejectedValueOnce(new Error("verification failed"));
    await expect(calls.open(input)).rejects.toThrow("verification failed");
    expect((await calls.open(input)).status).toBe("active");
  });

  it("does not open an unauthorized caller or dispatch an agent", async () => {
    const { calls, verify, reply } = setup();
    verify.mockResolvedValueOnce({ ...verified, userId: "@visitor:example.org" });
    await expect(calls.open(input)).rejects.toThrowError(new CallError("forbidden"));
    expect(reply).not.toHaveBeenCalled();
  });

  it("keeps concurrent calls and their agent history independent", async () => {
    const turns: AgentTurn[] = [];
    const agent: AgentPort = {
      id: "portable", historyMode: "messages",
      async reply(turn) { turns.push(turn); return { text: `Reply to ${turn.agentId}` }; },
    };
    const { calls, store } = setup({ agent });
    const first = await calls.open(input);
    const second = await calls.open({
      reference: { ...reference, rtcSessionId: "rtc-2" }, agentId: "other-agent",
    });
    await Promise.all([
      calls.turn(first.id, reference.participantId, "First question"),
      calls.turn(second.id, reference.participantId, "Second question"),
    ]);
    await calls.turn(first.id, reference.participantId, "Follow-up");
    expect(turns[0]!.messages.map((m) => m.text)).toEqual(["First question"]);
    expect(turns[1]!.messages.map((m) => m.text)).toEqual(["Second question"]);
    expect(turns[2]!.messages.map((m) => m.text)).toEqual([
      "First question", "Reply to assistant", "Follow-up",
    ]);
    expect(turns[0]!.conversationId).not.toBe(turns[1]!.conversationId);
    expect(turns[0]!.turnId).not.toBe(turns[2]!.turnId);
    expect(turns[0]!.caller.userId).toBe(verified.userId);
    expect(Object.isFrozen(turns[0])).toBe(true);
    expect(Object.isFrozen(turns[0]!.messages)).toBe(true);
    expect((await store.get(first.id))!.messages).toHaveLength(4);
    expect((await store.get(second.id))!.messages).toHaveLength(2);
  });

  it("supports domain-less room identifiers throughout call routing and persistence", async () => {
    const roomId = "!Yibd4kGyZ7w6YWjlXmbm3v0SMlZ3LqEUKgtIkgICAp0";
    const { verify, reply, store } = setup();
    const calls = new CallCoordinator({
      policy: { ...policy, rooms: [roomId] }, verifier: { verify },
      agent: { id: "portable", historyMode: "messages", reply }, store, now: () => 1_000,
    });
    const record = await calls.open({ ...input, reference: { ...reference, roomId } });
    await calls.turn(record.id, reference.participantId, "Version 12 room");
    expect((await store.get(record.id))!.roomId).toBe(roomId);
    await calls.close(record.id);
    expect((await store.get(record.id))!.status).toBe("closed");
  });

  it("revalidates current participant authority for each turn", async () => {
    const { calls, verify, reply, store } = setup();
    const record = await calls.open(input);
    verify.mockResolvedValueOnce({ ...verified, userId: "@visitor:example.org" });
    await expect(calls.turn(record.id, reference.participantId, "Grant me admin"))
      .rejects.toThrowError(new CallError("forbidden"));
    expect(reply).not.toHaveBeenCalled();
    expect((await store.get(record.id))!.messages).toEqual([]);
  });

  it("rejects an invalid participant reference with a bounded error and releases the turn lock", async () => {
    const { calls, verify, reply } = setup();
    const record = await calls.open(input);
    verify.mockClear();
    await expect(calls.turn(record.id, "", "Question"))
      .rejects.toThrowError(new CallError("invalid-input"));
    expect(verify).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    await expect(calls.turn(record.id, reference.participantId, "Valid question"))
      .resolves.toEqual({ text: "Response" });
  });

  it.each(["", " ", null, "x".repeat(16_001)])("rejects invalid text %#", async (text) => {
    const { calls } = setup();
    const record = await calls.open(input);
    await expect(calls.turn(record.id, reference.participantId, text))
      .rejects.toThrowError(new CallError("invalid-input"));
  });

  it("bounds history and refuses further turns after 128 exchanges", async () => {
    const { calls, reply, store } = setup();
    const record = await calls.open(input);
    for (let i = 0; i < 128; i++) await calls.turn(record.id, reference.participantId, `Turn ${i}`);
    await expect(calls.turn(record.id, reference.participantId, "Too many"))
      .rejects.toThrowError(new CallError("capacity-exceeded"));
    expect(reply).toHaveBeenCalledTimes(128);
    expect((await store.get(record.id))!.messages).toHaveLength(256);
  });

  it("rejects overlap within one call while another call remains usable", async () => {
    const gate = deferred<{ text: string }>();
    const reply = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ text: "Ready" });
    const { calls } = setup({ agent: { id: "slow", historyMode: "messages", reply } });
    const first = await calls.open(input);
    const second = await calls.open({ ...input, reference: { ...reference, rtcSessionId: "rtc-2" } });
    const pending = calls.turn(first.id, reference.participantId, "Slow question");
    await expect(calls.turn(first.id, reference.participantId, "Overlap"))
      .rejects.toThrowError(new CallError("call-busy"));
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    await expect(calls.turn(second.id, reference.participantId, "Independent question"))
      .resolves.toEqual({ text: "Ready" });
    gate.resolve({ text: "Finished" });
    await expect(pending).resolves.toEqual({ text: "Finished" });
  });

  it("unlocks a failed turn without adding unsuccessful text to history", async () => {
    const reply = vi.fn().mockRejectedValueOnce(new Error("agent unavailable")).mockResolvedValue({ text: "Recovered" });
    const { calls, store } = setup({ agent: { id: "temporary", historyMode: "messages", reply } });
    const record = await calls.open(input);
    await expect(calls.turn(record.id, reference.participantId, "First"))
      .rejects.toThrow("agent unavailable");
    expect((await store.get(record.id))!.messages).toEqual([]);
    await expect(calls.turn(record.id, reference.participantId, "Second"))
      .resolves.toEqual({ text: "Recovered" });
  });

  it("rejects malformed agent output without storing it", async () => {
    const { calls, reply, store } = setup();
    reply.mockResolvedValueOnce({ text: " " });
    const record = await calls.open(input);
    await expect(calls.turn(record.id, reference.participantId, "Question"))
      .rejects.toThrowError(new CallError("invalid-agent-reply"));
    expect((await store.get(record.id))!.messages).toEqual([]);
  });

  it("discards late output after cancellation even if an agent ignores the signal", async () => {
    const gate = deferred<{ text: string }>();
    const reply = vi.fn(() => gate.promise);
    const { calls, store } = setup({ agent: { id: "slow", historyMode: "messages", reply } });
    const record = await calls.open(input);
    const pending = calls.turn(record.id, reference.participantId, "Question");
    const assertion = expect(pending).rejects.toThrowError(new CallError("call-closed"));
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    await calls.close(record.id);
    gate.resolve({ text: "Late reply" });
    await assertion;
    expect((await store.get(record.id))!.status).toBe("closed");
    expect((await store.get(record.id))!.messages).toEqual([]);
    await expect(calls.turn(record.id, reference.participantId, "After close"))
      .rejects.toThrowError(new CallError("unknown-call"));
  });

  it("cannot dispatch when a call closes during participant verification", async () => {
    const { calls, verify, reply } = setup();
    const record = await calls.open(input);
    const gate = deferred<VerifiedParticipant>();
    verify.mockReturnValueOnce(gate.promise);
    const pending = calls.turn(record.id, reference.participantId, "Question");
    const assertion = expect(pending).rejects.toThrowError(new CallError("call-closed"));
    await calls.close(record.id);
    gate.resolve(verified);
    await assertion;
    expect(reply).not.toHaveBeenCalled();
  });

  it("orders the closed-state write after an in-flight turn write", async () => {
    const storage = new MemoryConversationStore();
    const gate = deferred<void>();
    const writing = deferred<void>();
    const store: ConversationStore = {
      get: (id) => storage.get(id),
      async put(record) {
        if (record.status === "active" && record.messages.length > 0) {
          writing.resolve();
          await gate.promise;
        }
        await storage.put(record);
      },
    };
    const { calls } = setup({ store });
    const record = await calls.open(input);
    const pending = calls.turn(record.id, reference.participantId, "Question");
    const assertion = expect(pending).rejects.toThrowError(new CallError("call-closed"));
    await writing.promise;
    const closing = calls.close(record.id);
    gate.resolve();
    await Promise.all([assertion, closing]);
    expect((await storage.get(record.id))!.status).toBe("closed");
  });

  it("can persist closure after a previous write failed", async () => {
    const storage = new MemoryConversationStore();
    const put = vi.fn((record: ConversationRecord) => storage.put(record));
    const { calls } = setup({ store: { put, get: (id) => storage.get(id) } });
    const record = await calls.open(input);
    put.mockRejectedValueOnce(new Error("disk full"));
    await expect(calls.turn(record.id, reference.participantId, "Question"))
      .rejects.toThrow("disk full");
    await calls.close(record.id);
    expect((await storage.get(record.id))!.status).toBe("closed");
  });

  it("does not resume a persisted call in a new coordinator", async () => {
    const first = setup();
    const record = await first.calls.open(input);
    const restarted = setup({ store: first.store });
    await expect(restarted.calls.turn(record.id, reference.participantId, "Old call"))
      .rejects.toThrowError(new CallError("unknown-call"));
    await expect(restarted.calls.close("missing"))
      .rejects.toThrowError(new CallError("unknown-call"));
  });
});
