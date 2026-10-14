import { describe, expect, it, vi } from "vitest";
import { MediaControlError, WorkerMediaController } from "../../packages/worker/src/media.js";

function fixture(timeoutMs = 30_000) {
  const transport = { connect: vi.fn(async (_room: string, _signal: AbortSignal) => {}), disconnect: vi.fn(async () => {}) };
  const controller = new WorkerMediaController({ rooms: ["!room"], transport, timeoutMs });
  return { transport, controller, signal: new AbortController().signal };
}

describe("WorkerMediaController", () => {
  it.each([0, 65537, 1.5])("rejects invalid session ledger limits %s", (maxSessions) => {
    const { transport } = fixture();
    expect(() => new WorkerMediaController({ rooms: ["!room"], transport, maxSessions })).toThrow("invalid-request");
  });

  it("retains completed IDs and refuses full capacity without eviction", async () => {
    const { transport, signal } = fixture();
    const controller = new WorkerMediaController({ rooms: ["!room"], transport, maxSessions: 1 });
    const joined = await controller.join({ roomId: "!room" }, signal);
    await controller.leave({ sessionId: joined.sessionId.toUpperCase() });
    await expect(controller.join({ roomId: "!room", sessionId: joined.sessionId.toUpperCase() }, signal)).rejects.toThrow("session-reused");
    await expect(controller.join({ roomId: "!room" }, signal)).rejects.toThrow("capacity-exceeded");
    expect(transport.connect).toHaveBeenCalledOnce();
    await controller.shutdown();
  });

  it("connects only configured rooms, returns immutable IDs, and closes the exact session", async () => {
    const { transport, controller, signal } = fixture();
    expect(controller.status()).toEqual({ available: true, session: null });
    const joined = await controller.join({ roomId: "!room" }, signal);
    expect(joined).toMatchObject({ roomId: "!room", state: "connected", sessionId: expect.any(String) });
    expect(Object.isFrozen(joined)).toBe(true);
    expect(transport.connect).toHaveBeenCalledWith("!room", expect.any(AbortSignal));
    expect(controller.status()).toEqual({ available: true, session: joined });
    expect(Object.isFrozen(controller.status().session)).toBe(true);
    await controller.leave({ sessionId: joined.sessionId });
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(controller.status().session).toBeNull();
    const next = await controller.join({ roomId: "!room" }, signal);
    expect(next.sessionId).not.toBe(joined.sessionId);
    await controller.shutdown();
  });

  it.each([{ rooms: [] }, { rooms: ["invalid"] }, { rooms: Array(257).fill("!room") }, { timeoutMs: 0 }, { timeoutMs: 300_001 }, { timeoutMs: 0.5 }])("rejects invalid configuration", (change) => {
    const { transport } = fixture();
    expect(() => new WorkerMediaController({ rooms: ["!room"], transport, ...change })).toThrow("invalid-request");
  });

  it.each([null, {}, { roomId: "room" }, { roomId: "!room", owner: true }])("rejects invalid requests without touching the transport", async (value) => {
    const { transport, controller, signal } = fixture();
    await expect(controller.join(value, signal)).rejects.toThrow("invalid-request");
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it("rejects unconfigured rooms and cancelled requests", async () => {
    const { controller, signal } = fixture();
    await expect(controller.join({ roomId: "!other" }, signal)).rejects.toThrow("forbidden-room");
    await expect(controller.join({ roomId: "!room" }, AbortSignal.abort())).rejects.toThrow("closed");
  });

  it("reserves capacity before connecting and during cancellation of a late backend", async () => {
    const { transport, controller, signal } = fixture();
    let finish!: () => void;
    transport.connect.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const request = new AbortController();
    const pending = controller.join({ roomId: "!room" }, request.signal);
    await Promise.resolve();
    expect(controller.status().session?.state).toBe("connecting");
    await expect(controller.join({ roomId: "!room" }, signal)).rejects.toThrow("busy");
    request.abort();
    await expect(pending).rejects.toThrow("closed");
    expect(controller.status().session?.state).toBe("closing");
    await expect(controller.join({ roomId: "!room" }, signal)).rejects.toThrow("busy");
    finish();
    await vi.waitFor(() => expect(controller.status().session).toBeNull());
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });

  it("redacts connection failure and releases capacity after cleanup", async () => {
    const { transport, controller, signal } = fixture();
    transport.connect.mockRejectedValueOnce(new Error("private credential"));
    await expect(controller.join({ roomId: "!room" }, signal)).rejects.toThrow(new MediaControlError("backend-failed"));
    await vi.waitFor(() => expect(controller.status().session).toBeNull());
    expect(transport.disconnect).toHaveBeenCalledOnce();
    await controller.join({ roomId: "!room" }, signal);
    await controller.shutdown();
  });

  it("times out connecting and keeps caller cancellation separate from connected media lifetime", async () => {
    const { transport, controller } = fixture(10);
    transport.connect.mockImplementationOnce((_room, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })));
    await expect(controller.join({ roomId: "!room" }, new AbortController().signal)).rejects.toThrow("closed");
    await vi.waitFor(() => expect(controller.status().session).toBeNull());
    const request = new AbortController();
    await controller.join({ roomId: "!room" }, request.signal);
    request.abort();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(controller.status().session?.state).toBe("connected");
    await controller.shutdown();
  });

  it("handles leave during connection and deduplicates overlapping shutdown", async () => {
    const { transport, controller, signal } = fixture();
    let finish!: () => void;
    transport.connect.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = controller.join({ roomId: "!room" }, signal);
    await Promise.resolve();
    const leaving = controller.leave({ sessionId: controller.status().session!.sessionId });
    const first = controller.shutdown();
    expect(controller.shutdown()).toBe(first);
    await expect(pending).rejects.toThrow("closed");
    finish();
    await Promise.all([leaving, first]);
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(controller.status()).toEqual({ available: false, session: null });
  });

  it("requires valid existing session IDs", async () => {
    const { controller, signal } = fixture();
    await expect(controller.leave({ sessionId: "bad" })).rejects.toThrow("invalid-request");
    await expect(controller.leave({ sessionId: crypto.randomUUID() })).rejects.toThrow("not-found");
    await controller.join({ roomId: "!room" }, signal);
    await expect(controller.leave({ sessionId: crypto.randomUUID() })).rejects.toThrow("not-found");
    await controller.shutdown();
  });

  it("fails closed when backend cleanup fails", async () => {
    const { transport, controller, signal } = fixture();
    const joined = await controller.join({ roomId: "!room" }, signal);
    transport.disconnect.mockRejectedValue(new Error("private backend error"));
    await expect(controller.leave({ sessionId: joined.sessionId })).rejects.toThrow(new MediaControlError("backend-failed"));
    expect(controller.status().available).toBe(false);
    await expect(controller.join({ roomId: "!room" }, signal)).rejects.toThrow("closed");
    await controller.shutdown();
  });

  it("shuts down idempotently without opening a backend", async () => {
    const { controller, transport, signal } = fixture();
    const first = controller.shutdown();
    expect(controller.shutdown()).toBe(first);
    await first;
    await expect(controller.join({ roomId: "!room" }, signal)).rejects.toThrow("closed");
    expect(transport.disconnect).not.toHaveBeenCalled();
  });
});
