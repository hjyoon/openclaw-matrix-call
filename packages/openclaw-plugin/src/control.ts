import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { readSecretFileSync } from "openclaw/plugin-sdk/secret-file";
import { matrixRoomIdSchema, type CallPolicy } from "@matrix-call/core";
import { WorkerHttpClient, WorkerHttpError } from "@matrix-call/worker";
import { matrixCallChannel } from "./channel.js";

const controlSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("status") }),
  z.strictObject({ operation: z.literal("join"), roomId: matrixRoomIdSchema }),
  z.strictObject({ operation: z.literal("leave"), sessionId: z.uuid().transform((value) => value.toLowerCase()) }),
]);

type State = {
  client: WorkerHttpClient; policy: CallPolicy; controller: AbortController; timeoutMs: number;
  pending: Set<Promise<unknown>>; owned: Set<string>;
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
        const client = await background(() => WorkerHttpClient.connect({ ...settings, secret, signal: controller.signal }));
        state = { client, policy: account.policy!, controller, timeoutMs: settings.timeoutMs, pending: new Set(), owned: new Set() };
        context.logger.info("Matrix Call worker control authenticated");
      } catch { throw new Error("Matrix Call worker control could not start"); }
    }),
    stop: () => schedule(close),
  };

  const execute = async (value: unknown, assertAuthorized: () => void, callerSignal?: AbortSignal) => {
    assertAuthorized();
    const parsed = controlSchema.safeParse(value);
    if (!parsed.success) throw new NativeControlError("invalid-request");
    const current = state;
    if (!current || current.controller.signal.aborted) throw new NativeControlError("worker-unavailable");
    if (current.pending.size >= maxPending) throw new WorkerHttpError("busy");
    if (parsed.data.operation === "join" && current.owned.size >= maxOwned) throw new WorkerHttpError("capacity-exceeded");
    const signal = callerSignal ? AbortSignal.any([current.controller.signal, callerSignal]) : current.controller.signal;
    const assertCurrent = () => { signal.throwIfAborted(); assertAuthorized(); };
    const operation = async () => {
      assertCurrent();
      const input = parsed.data;
      if (input.operation === "join") {
        if (!current.policy.rooms.includes(input.roomId)) throw new NativeControlError("forbidden");
        const id = randomUUID();
        current.owned.add(id);
        try { const result = await current.client.join(input.roomId, signal, id); assertCurrent(); return result; }
        catch (error) {
          if (error instanceof WorkerHttpError && ["busy", "session-reused", "capacity-exceeded", "forbidden-room", "invalid-request"].includes(error.code)) current.owned.delete(id);
          throw error;
        }
      }
      const status = await current.client.status(signal);
      assertCurrent();
      if (status.session && !current.policy.rooms.includes(status.session.roomId)) throw new NativeControlError("forbidden");
      if (input.operation === "status") return status;
      if (!status.session || status.session.sessionId !== input.sessionId) throw new WorkerHttpError("not-found");
      await current.client.leave(input.sessionId, signal);
      assertCurrent();
      current.owned.delete(input.sessionId);
      return Object.freeze({ closed: true });
    };
    const background = api.lifecycle.runInBackgroundContext!;
    const pending = Promise.resolve().then(() => background(operation));
    current.pending.add(pending);
    try { return await pending; }
    catch (error) { if (error instanceof NativeControlError || error instanceof WorkerHttpError) throw error; throw new NativeControlError("control-failed"); }
    finally { current.pending.delete(pending); }
  };

  const command = async (context: PluginCommandContext) => {
    const assertAuthorized = () => {
      if ((context.channelId ?? context.channel) !== "matrix" || !context.isAuthorizedSender || !context.senderId || !state?.policy.owners.includes(context.senderId)) throw new NativeControlError("forbidden");
    };
    try {
      assertAuthorized();
      const parts = (context.args?.trim() || "status").split(/\s+/);
      let request: unknown;
      if (parts.length === 1 && parts[0] === "status") request = { operation: "status" };
      else if (parts.length === 2 && parts[0] === "join") request = { operation: "join", roomId: parts[1] };
      else if (parts.length === 2 && parts[0] === "leave") request = { operation: "leave", sessionId: parts[1] };
      else return { text: "Usage: /matrixcall status | join <room-id> | leave <session-id>" };
      const result = await execute(request, assertAuthorized);
      return { text: `Matrix Call media control: ${JSON.stringify(result)}. Assistant readiness remains unverified.` };
    } catch (error) {
      const code = nativeControlErrorCode(error);
      return { text: `Matrix Call control unavailable: ${code}` };
    }
  };
  return Object.freeze({ service, execute, command });
}
