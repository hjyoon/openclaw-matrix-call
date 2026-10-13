import { randomUUID } from "node:crypto";
import { z } from "zod";
import { matrixRoomIdSchema } from "@matrix-call/core";
import type { RtcTransportPort } from "@matrix-call/core";

export class MediaControlError extends Error {
  constructor(readonly code: "invalid-request" | "forbidden-room" | "busy" | "not-found" | "closed" | "backend-failed") {
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
  cleanup?: Promise<void>;
};

const joinSchema = z.strictObject({ roomId: matrixRoomIdSchema });
const leaveSchema = z.strictObject({ sessionId: z.uuid() });
const statusSchema = z.strictObject({});

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
  readonly #transport: Pick<RtcTransportPort, "connect" | "disconnect">;
  readonly #timeout: number;
  #active: MediaSession | undefined;
  #closed = false;
  #shutdown: Promise<void> | undefined;

  constructor({ rooms, transport, timeoutMs = 30_000 }: { rooms: readonly string[]; transport: Pick<RtcTransportPort, "connect" | "disconnect">; timeoutMs?: number }) {
    const parsed = z.array(matrixRoomIdSchema).min(1).max(256).safeParse(rooms);
    if (!parsed.success || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new MediaControlError("invalid-request");
    this.#rooms = new Set(parsed.data);
    this.#transport = transport;
    this.#timeout = timeoutMs;
  }

  status(value: unknown = {}) {
    if (!statusSchema.safeParse(value).success) throw new MediaControlError("invalid-request");
    const active = this.#active;
    return Object.freeze({ available: !this.#closed, session: active ? Object.freeze({ sessionId: active.id, roomId: active.roomId,
      state: active.controller.signal.aborted ? "closing" : (active.connected ? "connected" : "connecting"),
    }) : null });
  }

  async join(value: unknown, signal: AbortSignal) {
    const parsed = joinSchema.safeParse(value);
    if (!parsed.success) throw new MediaControlError("invalid-request");
    if (!this.#rooms.has(parsed.data.roomId)) throw new MediaControlError("forbidden-room");
    if (this.#closed || signal.aborted) throw new MediaControlError("closed");
    if (this.#active) throw new MediaControlError("busy");
    const state: MediaSession = { id: randomUUID(), roomId: parsed.data.roomId, controller: new AbortController(), task: Promise.resolve(), connected: false };
    this.#active = state;
    const abort = () => state.controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.#timeout);
    state.task = Promise.resolve().then(async () => {
      state.controller.signal.throwIfAborted();
      await this.#transport.connect(state.roomId, state.controller.signal);
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
