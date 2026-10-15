import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import {
  authorizeParticipant, CallError, parseAgentRequest, parsePolicy,
} from "@matrix-call/core";
import type { AgentPort, AgentReply, AgentTurn, CallPolicy, VerifiedParticipant } from "@matrix-call/core";

type IngressRunner = PluginRuntime["agent"]["runCommandFromIngress"];

export class OpenClawAgentAdapter implements AgentPort {
  readonly id = "openclaw";
  readonly historyMode = "host-session";
  readonly #run: IngressRunner;
  readonly #commandRuntime: Parameters<IngressRunner>[1];
  readonly #policy: CallPolicy;
  readonly #now: () => number;
  readonly #policyForCaller: ((caller: VerifiedParticipant) => CallPolicy | undefined) | undefined;

  constructor(options: {
    runtime: { version: string; agent: { runCommandFromIngress: IngressRunner } };
    commandRuntime: Parameters<IngressRunner>[1];
    policy: CallPolicy;
    now?: () => number;
    policyForCaller?: ((caller: VerifiedParticipant) => CallPolicy | undefined) | undefined;
  }) {
    const { runtime, commandRuntime, policy, now = Date.now } = options;
    if (runtime.version !== "2026.10.2") throw new CallError("invalid-input");
    this.#run = runtime.agent.runCommandFromIngress.bind(runtime.agent);
    this.#commandRuntime = commandRuntime;
    this.#policy = parsePolicy(policy);
    this.#now = now;
    this.#policyForCaller = options.policyForCaller;
  }

  async reply(turn: AgentTurn): Promise<AgentReply> {
    turn.signal.throwIfAborted();
    const { signal, ...input } = turn;
    const request = parseAgentRequest(input);
    const policy = parsePolicy(this.#policyForCaller?.(request.caller) ?? this.#policy);
    const caller = authorizeParticipant(policy, request.caller, request.caller, this.#now());
    if (!policy.agents.includes(request.agentId)) throw new CallError("forbidden");
    const latest = request.messages[request.messages.length - 1]!;
    if (latest.role !== "user") throw new CallError("invalid-input");
    if (latest.senderId !== caller.userId) throw new CallError("identity-mismatch");
    const result = await this.#run({
      message: latest.text,
      agentId: request.agentId,
      sessionKey: `agent:${request.agentId}:matrix-call:call:${request.conversationId}`,
      runId: request.turnId,
      messageChannel: "matrix-call",
      messageProvider: "matrix-call",
      accountId: "default",
      senderIsOwner: false,
      allowModelOverride: false,
      toolsAllow: [],
      deliver: false,
      abortSignal: signal,
      runContext: {
        messageChannel: "matrix-call",
        accountId: "default",
        chatId: caller.roomId,
        currentChannelId: caller.roomId,
        currentThreadTs: request.conversationId,
        senderId: caller.userId,
        currentInboundAudio: true,
      },
    }, this.#commandRuntime);
    signal.throwIfAborted();
    if (result.meta.aborted || result.meta.error) throw new CallError("invalid-agent-reply");
    const text = result.meta.finalAssistantVisibleText;
    if (!text?.trim() || text.length > 16_000) throw new CallError("invalid-agent-reply");
    return Object.freeze({ text });
  }
}
