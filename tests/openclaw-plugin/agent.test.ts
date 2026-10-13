import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { CallCoordinator, CallError, MemoryConversationStore } from "../../packages/core/src/index.js";
import type { AgentTurn } from "../../packages/core/src/index.js";
import { OpenClawAgentAdapter } from "../../packages/openclaw-plugin/src/agent.js";
import { request } from "../fixtures/agent.js";

type IngressRunner = PluginRuntime["agent"]["runCommandFromIngress"];
const policy = { owners: [request.caller.userId], rooms: [request.caller.roomId], agents: ["assistant", "other"] };

function setup(now?: () => number) {
  const run = vi.fn<IngressRunner>().mockResolvedValue({ payloads: [], meta: { durationMs: 1, finalAssistantVisibleText: "Hello" } });
  const commandRuntime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const options = {
    runtime: { version: "2026.10.2", agent: { runCommandFromIngress: run } },
    commandRuntime, policy,
  };
  const adapter = now ? new OpenClawAgentAdapter({ ...options, now }) : new OpenClawAgentAdapter(options);
  return { adapter, run, commandRuntime, options };
}

function turn(): AgentTurn {
  return { ...request, signal: new AbortController().signal };
}

describe("OpenClaw agent adapter", () => {
  it("uses the tested host version and a neutral port descriptor", async () => {
    const { adapter } = setup();
    expect(adapter.id).toBe("openclaw");
    expect(adapter.historyMode).toBe("host-session");
    const input = { ...turn(), caller: { ...request.caller, expiresAtMs: Date.now() + 60_000 } };
    expect(await adapter.reply(input)).toEqual({ text: "Hello" });
  });

  it("rejects an untested SDK version", () => {
    const { options } = setup();
    expect(() => new OpenClawAgentAdapter({ ...options, runtime: { ...options.runtime, version: "2026.10.3" } }))
      .toThrowError(new CallError("invalid-input"));
  });

  it("preserves verified caller context with delegated, tool-free ingress", async () => {
    const { adapter, run, commandRuntime } = setup(() => 1_000);
    await adapter.reply(turn());
    const options = run.mock.calls[0]![0];
    expect(options).toMatchObject({
      message: "Hello", agentId: "assistant", runId: request.turnId,
      sessionKey: `agent:assistant:matrix-call:call:${request.conversationId}`,
      messageChannel: "matrix-call", messageProvider: "matrix-call", accountId: "default",
      senderIsOwner: false, allowModelOverride: false, toolsAllow: [], deliver: false,
      runContext: {
        senderId: request.caller.userId, chatId: request.caller.roomId,
        currentChannelId: request.caller.roomId, currentThreadTs: request.conversationId,
        currentInboundAudio: true,
      },
    });
    expect(run.mock.calls[0]![1]).toBe(commandRuntime);
    expect(JSON.stringify(options)).not.toContain("gatewayToken");
  });

  it("dispatches only the latest user message to a host with its own session history", async () => {
    const { adapter, run } = setup(() => 1_000);
    await adapter.reply({ ...turn(), messages: [
      request.messages[0]!,
      { role: "assistant", text: "Earlier reply", senderId: "assistant", timestampMs: 1_001 },
      { role: "user", text: "Follow-up", senderId: request.caller.userId, timestampMs: 1_002 },
    ] });
    expect(run.mock.calls[0]![0].message).toBe("Follow-up");
  });

  it("uses only the host's final visible text instead of raw or diagnostic text", async () => {
    const { adapter, run } = setup(() => 1_000);
    run.mockResolvedValue({ payloads: [
      { text: "Raw diagnostic payload", mediaUrl: null },
    ], meta: { durationMs: 1, finalAssistantVisibleText: "Final answer\nSecond paragraph",
      finalAssistantRawText: "private reasoning", finalPromptText: "private prompt" } });
    expect(await adapter.reply(turn())).toEqual({ text: "Final answer\nSecond paragraph" });
  });

  it.each([
    { aborted: true },
    { error: { kind: "context_overflow" as const, message: "secret error text" } },
  ])("rejects failed host execution %#", async (meta) => {
    const { adapter, run } = setup(() => 1_000);
    run.mockResolvedValue({ payloads: [], meta: { durationMs: 1, finalAssistantVisibleText: "Not successful", ...meta } });
    await expect(adapter.reply(turn())).rejects.toThrowError(new CallError("invalid-agent-reply"));
  });

  it.each(["", " ", "x".repeat(16_001)])("rejects unusable visible replies %#", async (text) => {
    const { adapter, run } = setup(() => 1_000);
    run.mockResolvedValue({ payloads: [], meta: { durationMs: 1, finalAssistantVisibleText: text } });
    await expect(adapter.reply(turn())).rejects.toThrowError(new CallError("invalid-agent-reply"));
  });

  it("fails closed when the host has not provided final visible text", async () => {
    const { adapter, run } = setup(() => 1_000);
    run.mockResolvedValue({ payloads: [{ text: "Ambiguous payload", mediaUrl: null }], meta: { durationMs: 1 } });
    await expect(adapter.reply(turn())).rejects.toThrowError(new CallError("invalid-agent-reply"));
  });

  it.each([
    { caller: { ...request.caller, userId: "@visitor:example.org" } },
    { agentId: "unlisted" },
  ])("rejects unlisted callers and agents before host dispatch %#", async (extra) => {
    const { adapter, run } = setup(() => 1_000);
    await expect(adapter.reply({ ...turn(), ...extra })).rejects.toThrowError(new CallError("forbidden"));
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a request ending with an assistant message", async () => {
    const { adapter, run } = setup(() => 1_000);
    await expect(adapter.reply({ ...turn(), messages: [{ ...request.messages[0]!, role: "assistant" }] }))
      .rejects.toThrowError(new CallError("invalid-input"));
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a latest-message sender different from the verified caller", async () => {
    const { adapter, run } = setup(() => 1_000);
    await expect(adapter.reply({ ...turn(), messages: [{ ...request.messages[0]!, senderId: "@other:example.org" }] }))
      .rejects.toThrowError(new CallError("identity-mismatch"));
    expect(run).not.toHaveBeenCalled();
  });

  it("does not dispatch an already aborted turn", async () => {
    const { adapter, run } = setup(() => 1_000);
    await expect(adapter.reply({ ...turn(), signal: AbortSignal.abort(new Error("closed")) }))
      .rejects.toThrow("closed");
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates the signal and discards output after the host ignores cancellation", async () => {
    const { adapter, run } = setup(() => 1_000);
    const controller = new AbortController();
    run.mockImplementationOnce(async (options) => {
      expect(options.abortSignal).toBe(controller.signal);
      controller.abort(new Error("cancelled"));
      return { payloads: [], meta: { durationMs: 1, finalAssistantVisibleText: "Late" } };
    });
    await expect(adapter.reply({ ...turn(), signal: controller.signal })).rejects.toThrow("cancelled");
  });

  it("maps independent core calls to stable independent host sessions", async () => {
    const { adapter, run } = setup(() => 1_000);
    const store = new MemoryConversationStore();
    const calls = new CallCoordinator({
      policy, agent: adapter, store, now: () => 1_000,
      verifier: { async verify(reference) { return { ...request.caller, ...reference }; } },
    });
    const reference = { roomId: request.caller.roomId, rtcSessionId: "rtc-1", participantId: request.caller.participantId };
    const first = await calls.open({ reference, agentId: "assistant" });
    const second = await calls.open({ reference: { ...reference, rtcSessionId: randomUUID() }, agentId: "other" });
    await calls.turn(first.id, reference.participantId, "First");
    await calls.turn(second.id, reference.participantId, "Second");
    await calls.turn(first.id, reference.participantId, "Follow-up");
    expect(run.mock.calls[0]![0].sessionKey).toBe(run.mock.calls[2]![0].sessionKey);
    expect(run.mock.calls[0]![0].sessionKey).not.toBe(run.mock.calls[1]![0].sessionKey);
    expect(run.mock.calls[1]![0].agentId).toBe("other");
    expect((await store.get(first.id))!.messages.map((m) => m.text)).toEqual(["First", "Hello", "Follow-up", "Hello"]);
  });
});
