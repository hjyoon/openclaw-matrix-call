import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createWorkerServer, WorkerMediaController } from "../../packages/worker/src/index.js";

async function setup(probe: Parameters<typeof createWorkerServer>[2], withMedia = true) {
  const media = new WorkerMediaController({ rooms: ["!room:example.org"], transport: { connect: async () => {}, disconnect: async () => {} } });
  const { server } = createWorkerServer("ab".repeat(32), withMedia ? media : undefined, probe);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { media, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/readyz`,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await media.shutdown(); } };
}

describe("bounded worker readiness", () => {
  it("requires a media controller and an explicit readiness implementation", async () => {
    const probe = vi.fn(async () => true);
    for (const worker of [await setup(undefined), await setup(probe, false)]) {
      try {
        const response = await fetch(worker.url); expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ ready: false, error: "transport-unavailable" });
      } finally { await worker.close(); }
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("shares only an in-flight check and performs a fresh check afterward", async () => {
    let finish!: (ready: boolean) => void;
    const probe = vi.fn(async () => new Promise<boolean>((resolve) => { finish = resolve; }));
    const worker = await setup(probe);
    try {
      const first = fetch(worker.url); const second = fetch(worker.url);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 20)); finish(true);
      for (const response of await Promise.all([first, second])) {
        expect(response.status).toBe(200); expect(await response.json()).toEqual({ ready: true });
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      probe.mockResolvedValueOnce(false);
      expect((await fetch(worker.url)).status).toBe(503); expect(probe).toHaveBeenCalledTimes(2);
    } finally { await worker.close(); }
  });

  it.each([false, "true", 1])("does not accept an invalid or unavailable readiness result %s", async (result) => {
    const worker = await setup(async () => result as boolean);
    try { const response = await fetch(worker.url); expect(response.status).toBe(503); expect(await response.json()).toEqual({ ready: false, error: "service-unavailable" }); }
    finally { await worker.close(); }
  });

  it("does not expose a private probe failure", async () => {
    const worker = await setup(async () => { throw new Error("private credential and path"); });
    try { const response = await fetch(worker.url); expect(response.status).toBe(503); expect(await response.text()).not.toContain("private"); }
    finally { await worker.close(); }
  });

  it("bounds a probe that ignores cancellation and discards its late rejection", async () => {
    let signal!: AbortSignal; let reject!: (error: Error) => void;
    const worker = await setup(async (current) => { signal = current; return new Promise((_, no) => { reject = no; }); });
    try {
      const response = await fetch(worker.url); expect(response.status).toBe(503); expect(signal.aborted).toBe(true);
      reject(new Error("late private failure")); await new Promise((resolve) => setImmediate(resolve));
    } finally { await worker.close(); }
  });

  it("rejects a closed media controller before probing", async () => {
    const probe = vi.fn(async () => true); const worker = await setup(probe);
    try { await worker.media.shutdown(); expect((await fetch(worker.url)).status).toBe(503); expect(probe).not.toHaveBeenCalled(); }
    finally { await worker.close(); }
  });

  it("rechecks media availability after a pending probe", async () => {
    let worker!: Awaited<ReturnType<typeof setup>>;
    worker = await setup(async () => { await worker.media.shutdown(); return true; });
    try { expect((await fetch(worker.url)).status).toBe(503); }
    finally { await worker.close(); }
  });
});
