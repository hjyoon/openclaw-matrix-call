import { randomUUID } from "node:crypto";
import { z } from "zod";
import { matrixRoomIdSchema } from "@matrix-call/core";
import type { RtcTransportPort } from "@matrix-call/core";
import { mediaDialSchema, recipientRoomSchema, recipientRoomResponseSchema, mediaJoinSchema as joinSchema, mediaLeaveSchema as leaveSchema, mediaStatusRequestSchema as statusSchema, type MediaDialRequest } from "./protocol.js";

type Transport = Pick<RtcTransportPort, "connect" | "disconnect"> & {
  dial?: (request: MediaDialRequest, signal: AbortSignal) => Promise<void>;
  recipientRoom?: (recipientId: string, preferredRoomId: string | undefined, signal: AbortSignal) => Promise<string>;
};

export class MediaControlError extends Error {
  constructor(readonly code: "invalid-request" | "forbidden-room" | "forbidden-recipient" | "transport-unavailable" | "busy" | "not-found" | "closed" | "backend-failed" | "session-reused" | "capacity-exceeded" | "private-room-required" | "verification-required") {
    super(code);
    this.name = "MediaControlError";
  }
}

type MediaSession = {
  id: string;
  roomId: string;
  controller: AbortController;
  task: Promise<void>;
  connected: boolean;
  outbound: boolean;
  cleanup?: Promise<void>;
};

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof MediaControlError ? signal.reason : new MediaControlError("closed"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export class WorkerMediaController {
  readonly #rooms: ReadonlySet<string>;
  readonly #transport: Transport;
  readonly #selfCalls: boolean;
  readonly #recipients: ReadonlySet<string>;
  readonly #timeout: number;
  readonly #maxSessions: number;
  readonly #accepted = new Set<string>();
  #active: MediaSession | undefined;
  #closed = false;
  #shutdown: Promise<void> | undefined;

  constructor({ rooms, transport, recipients = [], selfCalls = false, timeoutMs = 30_000, maxSessions = 4096 }: { rooms: readonly string[]; transport: Transport; recipients?: readonly string[]; selfCalls?: boolean; timeoutMs?: number; maxSessions?: number }) {
    const parsed = z.array(matrixRoomIdSchema).min(1).max(256).safeParse(rooms);
    if (!parsed.success || typeof selfCalls !== "boolean" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
        !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 65536 ||
        !z.array(mediaDialSchema.shape.recipientId).max(256).safeParse(recipients).success) throw new MediaControlError("invalid-request");
    this.#rooms = new Set(parsed.data);
    this.#transport = transport;
    this.#timeout = timeoutMs;
    this.#maxSessions = maxSessions;
    this.#recipients = new Set(recipients);
    this.#selfCalls = selfCalls;
  }

  get canDial(): boolean { return Boolean(this.#transport.dial && this.#recipients.size); }
  get canSelfCall(): boolean { return Boolean(this.#selfCalls && this.canDial && this.#transport.recipientRoom); }

  async recipientRoom(value: unknown, signal: AbortSignal) {
    const parsed = recipientRoomSchema.safeParse(value);
    if (!parsed.success) throw new MediaControlError("invalid-request");
    if (!this.canSelfCall) throw new MediaControlError("transport-unavailable");
    if (this.#closed) throw new MediaControlError("closed");
    const abort = AbortSignal.any([signal, AbortSignal.timeout(this.#timeout)]);
    try {
      const roomId = await cancellable(this.#transport.recipientRoom!(parsed.data.recipientId, parsed.data.preferredRoomId, abort), abort);
      return recipientRoomResponseSchema.parse({ recipientId: parsed.data.recipientId, roomId });
    } catch (error) { if (error instanceof MediaControlError) throw error; throw new MediaControlError("backend-failed"); }
  }

  status(value: unknown = {}) {
    if (!statusSchema.safeParse(value).success) throw new MediaControlError("invalid-request");
    const active = this.#active;
    return Object.freeze({ available: !this.#closed, session: active ? Object.freeze({ sessionId: active.id, roomId: active.roomId,
      state: active.controller.signal.aborted ? "closing" : (active.connected ? "connected" : (active.outbound ? "ringing" : "connecting")),
    }) : null });
  }

  async join(value: unknown, signal: AbortSignal) {
    const parsed = joinSchema.safeParse(value);
    if (!parsed.success) throw new MediaControlError("invalid-request");
    return this.#open(parsed.data, signal);
  }

  async dial(value: unknown, signal: AbortSignal) {
    const parsed = mediaDialSchema.safeParse(value);
    if (!parsed.success) throw new MediaControlError("invalid-request");
    if (!this.canDial) throw new MediaControlError("transport-unavailable");
    if (parsed.data.selfCall) { if (!this.canSelfCall) throw new MediaControlError("transport-unavailable"); }
    else if (!this.#recipients.has(parsed.data.recipientId)) throw new MediaControlError("forbidden-recipient");
    return this.#open(parsed.data, signal, parsed.data);
  }

  async #open(input: { roomId: string; sessionId?: string | undefined }, signal: AbortSignal, outbound?: MediaDialRequest) {
    if (!outbound?.selfCall && !this.#rooms.has(input.roomId)) throw new MediaControlError("forbidden-room");
    if (this.#closed || signal.aborted) throw new MediaControlError("closed");
    if (this.#active) throw new MediaControlError("busy");
    const id = input.sessionId ?? randomUUID();
    if (this.#accepted.has(id)) throw new MediaControlError("session-reused");
    if (this.#accepted.size >= this.#maxSessions) throw new MediaControlError("capacity-exceeded");
    this.#accepted.add(id);
    const state: MediaSession = { id, roomId: input.roomId, controller: new AbortController(), task: Promise.resolve(), connected: false, outbound: Boolean(outbound) };
    this.#active = state;
    const abort = () => state.controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, outbound ? outbound.ringTimeoutMs + this.#timeout : this.#timeout);
    state.task = Promise.resolve().then(async () => {
      state.controller.signal.throwIfAborted();
      if (outbound) await this.#transport.dial!(outbound, state.controller.signal);
      else await this.#transport.connect(state.roomId, state.controller.signal);
      state.controller.signal.throwIfAborted();
      state.connected = true;
    }).catch(async () => {
      state.controller.abort(new MediaControlError("backend-failed"));
      await this.#cleanup(state);
      throw new MediaControlError("backend-failed");
    });
    try {
      await cancellable(state.task, state.controller.signal);
      return Object.freeze({ sessionId: state.id, roomId: state.roomId, state: "connected" as const });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  async leave(value: unknown): Promise<void> {
    const parsed = leaveSchema.safeParse(value);
    if (!parsed.success) throw new MediaControlError("invalid-request");
    const state = this.#active;
    if (!state || state.id !== parsed.data.sessionId) throw new MediaControlError("not-found");
    state.controller.abort();
    await state.task.catch(() => undefined);
    await this.#cleanup(state);
  }

  async endSession(): Promise<void> {
    const state = this.#active;
    if (!state) return;
    state.controller.abort();
    await state.task.catch(() => undefined);
    await this.#cleanup(state);
  }

  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#closed = true;
    const state = this.#active;
    if (!state) this.#shutdown = Promise.resolve();
    else {
      state.controller.abort();
      this.#shutdown = state.task.catch(() => undefined).then(() => this.#cleanup(state));
    }
    return this.#shutdown;
  }

  #cleanup(state: MediaSession): Promise<void> {
    if (state.cleanup) return state.cleanup;
    state.cleanup = Promise.resolve().then(() => this.#transport.disconnect()).catch(() => {
      this.#closed = true;
      throw new MediaControlError("backend-failed");
    }).finally(() => { this.#active = undefined; });
    return state.cleanup;
  }
}
