import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult, type OpenClawPluginToolFactory, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { readSecretFileSync } from "openclaw/plugin-sdk/secret-file";
import { matrixRoomIdSchema, type CallPolicy, type VerifiedParticipant } from "@matrix-call/core";
import { WorkerHttpClient, WorkerHttpError, mediaDialSchema } from "@matrix-call/worker";
import { matrixCallChannel } from "./channel.js";

const statusSchema = z.strictObject({ operation: z.literal("status") });
const dialSchema = mediaDialSchema.omit({ sessionId: true, selfCall: true }).extend({ operation: z.literal("dial") });
const leaveSchema = z.strictObject({ operation: z.literal("leave"), sessionId: z.uuid().transform((value) => value.toLowerCase()) });
const toolSchema = z.discriminatedUnion("operation", [statusSchema, dialSchema, leaveSchema]);
const selfSchema = z.discriminatedUnion("operation", [statusSchema, leaveSchema,
  dialSchema.extend({ roomId: matrixRoomIdSchema.optional(), recipientId: mediaDialSchema.shape.recipientId.optional() }),
]);
const controlSchema = z.discriminatedUnion("operation", [
  statusSchema, dialSchema, leaveSchema,
  z.strictObject({ operation: z.literal("join"), roomId: matrixRoomIdSchema }),
]);

type State = {
  client: WorkerHttpClient; policy: CallPolicy; controller: AbortController; timeoutMs: number;
  pending: Set<Promise<unknown>>; owned: Set<string>;
  selfCalls: boolean; thirdPartyCalls: boolean;
  callers: Map<string, { requesterId: string; recipientId: string; roomId: string; active: boolean }>;
};

export class NativeControlError extends Error {
  constructor(readonly code: "forbidden" | "invalid-request" | "worker-unavailable" | "control-failed") { super(code); }
}

export const nativeControlErrorCode = (error: unknown) => error instanceof NativeControlError || error instanceof WorkerHttpError ? error.code : "control-failed";

export function createNativeWorkerControl(api: Pick<OpenClawPluginApi, "lifecycle">, limits: { maxPending?: number; maxOwned?: number } = {}) {
  const maxPending = limits.maxPending ?? 16;
  const maxOwned = limits.maxOwned ?? 4096;
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 256 ||
    !Number.isInteger(maxOwned) || maxOwned < 1 || maxOwned > 65536) throw new NativeControlError("invalid-request");
  let state: State | undefined;
  let transition = Promise.resolve();
  const close = async (): Promise<void> => {
    if (!state) return;
    const current = state;
    current.controller.abort();
    await Promise.allSettled([...current.pending]);
    for (const id of current.owned) {
      try { await current.client.leave(id, AbortSignal.timeout(current.timeoutMs)); }
      catch (error) {
        if (!(error instanceof WorkerHttpError) || error.code !== "not-found") throw new NativeControlError("control-failed");
      }
      current.owned.delete(id);
    }
    state = undefined;
  };
  const schedule = (operation: () => Promise<void>) => {
    const result = transition.then(operation);
    transition = result.catch(() => {});
    return result;
  };
  const service: OpenClawPluginService = {
    id: "matrix-call-worker",
    reload: { configPrefixes: ["channels.matrix-call"] },
    start: (context) => schedule(async () => {
      await close();
      try {
        const account = matrixCallChannel.config.resolveAccount(context.config);
        if (!account.enabled || !account.workerControl) return;
        const settings = account.workerControl;
        const secret = readSecretFileSync(settings.secretFile, "Matrix Call worker secret", { maxBytes: 65, rejectSymlink: true });
        if (account.agentService) {
          const agentSecret = readSecretFileSync(account.agentService.secretFile, "Matrix Call agent secret", { maxBytes: 65, rejectSymlink: true });
          if (secret === agentSecret) throw new Error("Dedicated control secret required");
        }
        const background = api.lifecycle.runInBackgroundContext;
        if (!background) throw new Error("Managed plugin context required");
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(settings.timeoutMs)]);
        const client = await background(async () => {
          for (;;) {
            try { return await WorkerHttpClient.connect({ ...settings, secret, signal }); }
            catch (error) {
              signal.throwIfAborted();
              if (!(error instanceof TypeError) || !(error.cause instanceof Error) || !("code" in error.cause) || error.cause.code !== "ECONNREFUSED") throw error;
              await delay(100, undefined, { signal });
            }
          }
        });
        state = { client, policy: account.policy!, controller, timeoutMs: settings.timeoutMs, pending: new Set(), owned: new Set(), selfCalls: account.selfCalls, thirdPartyCalls: account.thirdPartyCalls, callers: new Map() };
        context.logger.info("Matrix Call worker control authenticated");
      } catch { throw new Error("Matrix Call worker control could not start"); }
    }),
    stop: () => schedule(close),
  };

  const execute = async (value: unknown, assertAuthorized: () => void, callerSignal?: AbortSignal, requester?: { userId: string; preferredRoomId?: string }) => {
    assertAuthorized();
    const parsed = (requester ? selfSchema : controlSchema).safeParse(value);
    if (!parsed.success) throw new NativeControlError("invalid-request");
    const current = state;
    if (!current || current.controller.signal.aborted) throw new NativeControlError("worker-unavailable");
    if (requester && (!current.selfCalls || !mediaDialSchema.shape.recipientId.safeParse(requester.userId).success)) throw new NativeControlError("forbidden");
    if (current.pending.size >= maxPending) throw new WorkerHttpError("busy");
    if ((parsed.data.operation === "join" || parsed.data.operation === "dial") && current.owned.size >= maxOwned) throw new WorkerHttpError("capacity-exceeded");
    const signal = callerSignal ? AbortSignal.any([current.controller.signal, callerSignal]) : current.controller.signal;
    const assertCurrent = () => { signal.throwIfAborted(); assertAuthorized(); };
    const operation = async () => {
      assertCurrent();
      const input = parsed.data;
      if (input.operation === "join" || input.operation === "dial") {
        const recipientId = input.operation === "dial" ? input.recipientId ?? requester?.userId : undefined;
        if (requester && !current.thirdPartyCalls && recipientId !== requester.userId) throw new NativeControlError("forbidden");
        let roomId = input.roomId;
        if (requester) {
          const preferredRoomId = input.roomId ?? requester.preferredRoomId;
          roomId = await current.client.recipientRoom({ recipientId: recipientId!, ...(preferredRoomId === undefined ? {} : { preferredRoomId }) }, signal);
          assertCurrent();
        } else {
          if (!current.policy.rooms.includes(roomId!)) throw new NativeControlError("forbidden");
          if (input.operation === "dial" && !current.policy.owners.includes(input.recipientId!)) throw new NativeControlError("forbidden");
        }
        if (current.owned.size >= maxOwned) throw new WorkerHttpError("capacity-exceeded");
        const id = randomUUID();
        current.owned.add(id);
        if (requester) current.callers.set(id, { requesterId: requester.userId, recipientId: recipientId!, roomId: roomId!, active: true });
        try {
          const result = input.operation === "join"
            ? await current.client.join(roomId!, signal, id)
            : await current.client.dial({ roomId: roomId!, recipientId: recipientId!, message: input.message, ringTimeoutMs: input.ringTimeoutMs, ...(requester ? { selfCall: true } : {}) }, signal, id);
          assertCurrent();
          return input.operation === "dial" ? Object.freeze({ ...result, recipientId, openingMessageDelivered: true }) : result;
        }
        catch (error) {
          const caller = current.callers.get(id); if (caller) caller.active = false;
          if (error instanceof WorkerHttpError && ["busy", "session-reused", "capacity-exceeded", "forbidden-room", "forbidden-recipient", "transport-unavailable", "invalid-request"].includes(error.code)) { current.owned.delete(id); current.callers.delete(id); }
          throw error;
        }
      }
      const status = await current.client.status(signal);
      assertCurrent();
      if (requester && status.session && current.callers.get(status.session.sessionId)?.requesterId !== requester.userId) {
        if (input.operation === "status") return Object.freeze({ available: status.available, session: null });
        throw new WorkerHttpError("not-found");
      }
      if (!requester && status.session && !current.owned.has(status.session.sessionId) && !current.policy.rooms.includes(status.session.roomId)) throw new NativeControlError("forbidden");
      if (input.operation === "status") return status;
      if (!status.session || status.session.sessionId !== input.sessionId) throw new WorkerHttpError("not-found");
      const caller = current.callers.get(input.sessionId); if (caller) caller.active = false;
      await current.client.leave(input.sessionId, signal);
      assertCurrent();
      current.owned.delete(input.sessionId);
      current.callers.delete(input.sessionId);
      return Object.freeze({ closed: true });
    };
    const background = api.lifecycle.runInBackgroundContext!;
    const pending = Promise.resolve().then(() => background(operation));
    current.pending.add(pending);
    try { return await pending; }
    catch (error) { if (error instanceof NativeControlError || error instanceof WorkerHttpError) throw error; throw new NativeControlError("control-failed"); }
    finally { current.pending.delete(pending); }
  };

  const tool: OpenClawPluginToolFactory<2> = {
    contextVersion: 2,
    create(context) {
      const allowed = () => context.messageChannel === "matrix" && Boolean(context.requesterSenderId && state &&
        mediaDialSchema.shape.recipientId.safeParse(context.requesterSenderId).success &&
        (state.selfCalls || (context.senderIsOwner === true && state.policy.owners.includes(context.requesterSenderId))));
      if (!allowed()) return null;
      const assertAuthorized = () => { context.assertInvocationCurrent(); if (!allowed()) throw new NativeControlError("forbidden"); };
      return {
        name: "matrix_call", label: "Matrix Call", catalogMode: "direct-only",
        description: state!.selfCalls
          ? `Call ${state!.thirdPartyCalls ? "a Matrix recipient explicitly requested by the user" : "the authenticated requester " + context.requesterSenderId}. Omit recipientId to call the requester. Discover the recipient's existing encrypted two-person room with the bot, ring and speak the opening message after a verified answer. Recipient devices must be verified first. Status and leave apply only to calls initiated by this requester. Use an exact Matrix ID, never infer identity from a display name. No automatic retries or scheduling.`
          : "Call a configured Matrix recipient, ring their client, and speak the opening message after a verified answer without waiting for them to speak. Use only for an explicit owner request. Requires a configured private two-person room. No automatic retries or scheduling. Status and exact-session leave are also available.",
        parameters: { type: "object", additionalProperties: false, required: ["operation"], properties: {
          operation: { type: "string", enum: ["dial", "status", "leave"] },
          roomId: { type: "string", ...(state!.selfCalls ? {} : { enum: [...state!.policy.rooms] }), description: "Optional preferred private room; membership is checked against the recipient" },
          recipientId: { type: "string", ...(state!.thirdPartyCalls ? {} : { enum: state!.selfCalls ? [context.requesterSenderId!] : [...state!.policy.owners] }), description: "Exact recipient Matrix ID (@user:server); defaults to the authenticated requester when selfCalls is enabled" },
          message: { type: "string", minLength: 1, maxLength: 1000, description: "Opening words to speak after the recipient answers" },
          ringTimeoutMs: { type: "integer", minimum: 1000, maximum: 60000 },
          sessionId: { type: "string", description: "Exact active session UUID, required for leave" },
        } } as AnyAgentTool["parameters"],
        getExecutionTimeoutMs: () => 300_000,
        async execute(_id, value, signal) {
          try {
            assertAuthorized();
            const input = (state!.selfCalls ? selfSchema : toolSchema).safeParse(value);
            if (!input.success) throw new NativeControlError("invalid-request");
            return jsonResult(await execute(input.data, assertAuthorized, signal, state!.selfCalls ? { userId: context.requesterSenderId!, ...(context.nativeChannelId && matrixRoomIdSchema.safeParse(context.nativeChannelId).success ? { preferredRoomId: context.nativeChannelId } : {}) } : undefined));
          } catch (error) {
            const code = nativeControlErrorCode(error);
            return { content: [{ type: "text", text: `Matrix Call control unavailable: ${code}. Do not retry automatically.` }], details: { error: code }, isError: true };
          }
        },
      };
    },
  };

  const command = async (context: PluginCommandContext) => {
    const assertAuthorized = () => {
      if ((context.channelId ?? context.channel) !== "matrix" || !context.isAuthorizedSender || !context.senderId || !(state?.selfCalls || state?.policy.owners.includes(context.senderId))) throw new NativeControlError("forbidden");
    };
    try {
      assertAuthorized();
      const parts = (context.args?.trim() || "status").split(/\s+/);
      let request: unknown;
      if (parts.length === 1 && parts[0] === "status") request = { operation: "status" };
      else if (parts.length === 2 && parts[0] === "join") request = { operation: "join", roomId: parts[1] };
      else if (parts.length === 2 && parts[0] === "leave") request = { operation: "leave", sessionId: parts[1] };
      else if (parts.length >= 4 && parts[0] === "dial") request = { operation: "dial", roomId: parts[1], recipientId: parts[2], message: parts.slice(3).join(" ") };
      else if (parts.length >= 3 && parts[0] === "call-to") request = { operation: "dial", recipientId: parts[1], message: parts.slice(2).join(" ") };
      else if (parts.length >= 2 && parts[0] === "call") request = { operation: "dial", message: parts.slice(1).join(" ") };
      else return { text: "Usage: /matrixcall status | call <opening-message> | call-to <recipient-id> <opening-message> | dial <room-id> <recipient-id> <opening-message> | join <room-id> | leave <session-id>" };
      const self = state!.selfCalls && !state!.policy.owners.includes(context.senderId!);
      const result = await execute(request, assertAuthorized, undefined, self || parts[0] === "call" || parts[0] === "call-to" ? { userId: context.senderId! } : undefined);
      return { text: `Matrix Call media control: ${JSON.stringify(result)}. ${parts[0] === "dial" || parts[0] === "call" || parts[0] === "call-to" ? "Opening speech sent after a verified answer." : "Assistant readiness remains unverified."}` };
    } catch (error) {
      const code = nativeControlErrorCode(error);
      return { text: `Matrix Call control unavailable: ${code}` };
    }
  };
  const policyForCaller = (caller: VerifiedParticipant): CallPolicy | undefined => {
    if (!state || state.controller.signal.aborted) return undefined;
    for (const entry of state.callers.values()) {
      if (entry.active && entry.recipientId === caller.userId && entry.roomId === caller.roomId) return Object.freeze({ owners: [entry.recipientId], rooms: [entry.roomId], agents: state.policy.agents });
    }
    return undefined;
  };
  return Object.freeze({ service, execute, command, tool, policyForCaller });
}
