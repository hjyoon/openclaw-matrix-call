import { describe, expect, it } from "vitest";
import {
  CallError, exportConversation, importConversation, MemoryConversationStore, parseConversation,
} from "../../packages/core/src/index.js";
import type { ConversationRecord } from "../../packages/core/src/index.js";

const record: ConversationRecord = {
  schemaVersion: 1,
  id: "b45c5d9c-4e72-47df-b945-bde05545dbe8",
  roomId: "!room:example.org",
  rtcSessionId: "rtc-1",
  agentId: "assistant",
  createdAtMs: 1_000,
  status: "closed",
  messages: [
    { role: "user", text: "Hello", senderId: "@owner:example.org", timestampMs: 1_001 },
    { role: "assistant", text: "Welcome", senderId: "assistant", timestampMs: 1_002 },
  ],
};

describe("portable conversation records", () => {
  it("exports versioned JSON without host session keys or SDK objects", () => {
    const json = exportConversation(record);
    expect(JSON.parse(json)).toEqual(record);
    expect(importConversation(json)).toEqual(record);
  });

  it("imports active records as data without creating an active call", () => {
    expect(importConversation(JSON.stringify({ ...record, status: "active" }))).toEqual({
      ...record, status: "active",
    });
  });

  it("rejects invalid JSON", () => {
    expect(() => importConversation("{")).toThrowError(new CallError("invalid-input"));
  });

  it.each([
    null,
    { ...record, schemaVersion: 2 },
    { ...record, id: "host-session-secret" },
    { ...record, hostToken: "secret" },
    { ...record, messages: [{ ...record.messages[0], text: " " }] },
    { ...record, messages: Array(257).fill(record.messages[0]) },
  ])("rejects invalid or unsupported records %#", (value) => {
    expect(() => parseConversation(value)).toThrowError(new CallError("invalid-input"));
  });

  it("stores immutable snapshots without retaining mutable caller objects", async () => {
    const store = new MemoryConversationStore();
    const source = structuredClone(record);
    await store.put(source);
    Object.assign(source.messages[0]!, { text: "changed" });
    const stored = await store.get(record.id);
    expect(stored).toEqual(record);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored!.messages)).toBe(true);
    expect(Object.isFrozen(stored!.messages[0])).toBe(true);
    expect(await store.get("unknown")).toBeUndefined();
  });

  it("preserves the last valid record when a write is invalid", async () => {
    const store = new MemoryConversationStore();
    await store.put(record);
    await expect(store.put({ ...record, schemaVersion: 2 } as unknown as ConversationRecord))
      .rejects.toThrowError(new CallError("invalid-input"));
    expect(await store.get(record.id)).toEqual(record);
  });
});
