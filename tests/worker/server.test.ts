import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { RequestAuthenticator } from "../../packages/core/src/index.js";
import { createWorkerServer } from "../../packages/worker/src/index.js";

const secret = "ab".repeat(32);

async function setup() {
  const { server, audience } = createWorkerServer(secret);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  return {
    server, audience, baseUrl: `http://127.0.0.1:${address.port}`,
    auth: new RequestAuthenticator({ secret, audience }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

describe("worker control plane", () => {
  it("reports liveness and an explicit unavailable transport", async () => {
    const worker = await setup();
    try {
      const health = await fetch(`${worker.baseUrl}/healthz`);
      expect(health.status).toBe(200);
      expect(health.headers.get("cache-control")).toBe("no-store");
      expect(await health.json()).toEqual({
        protocolVersion: 1, status: "development", audience: worker.audience, ready: false, transports: [],
      });
      const ready = await fetch(`${worker.baseUrl}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ ready: false, error: "transport-unavailable" });
    } finally { await worker.close(); }
  });

  it.each([
    ["GET", "/unknown"], ["POST", "/healthz"], ["GET", "/v1/calls"], ["POST", "/v1/unknown"],
  ])("rejects unknown method/path %s %s", async (method, path) => {
    const worker = await setup();
    try { expect((await fetch(`${worker.baseUrl}${path}`, { method })).status).toBe(404); }
    finally { await worker.close(); }
  });

  it("rejects unauthenticated caller claims", async () => {
    const worker = await setup();
    try {
      const response = await fetch(`${worker.baseUrl}/v1/calls`, {
        method: "POST", body: JSON.stringify({ owner: true }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    } finally { await worker.close(); }
  });

  it("authenticates internal requests without claiming implemented calling support", async () => {
    const worker = await setup();
    try {
      const body = "{}";
      const response = await fetch(`${worker.baseUrl}/v1/calls`, {
        method: "POST", body, headers: worker.auth.sign({ method: "POST", path: "/v1/calls", body }),
      });
      expect(response.status).toBe(501);
      const reply = await response.text();
      expect(JSON.parse(reply)).toEqual({ error: "transport-unavailable" });
      worker.auth.verify({ method: "RESPONSE_501", path: "/v1/calls", body: reply }, Object.fromEntries(response.headers));
    } finally { await worker.close(); }
  });

  it("rejects replay even for unavailable operations", async () => {
    const worker = await setup();
    try {
      const body = "{}";
      const headers = worker.auth.sign({ method: "POST", path: "/v1/calls", body });
      expect((await fetch(`${worker.baseUrl}/v1/calls`, { method: "POST", headers, body })).status).toBe(501);
      expect((await fetch(`${worker.baseUrl}/v1/calls`, { method: "POST", headers, body })).status).toBe(401);
    } finally { await worker.close(); }
  });

  it("limits request bytes", async () => {
    const worker = await setup();
    try {
      const response = await fetch(`${worker.baseUrl}/v1/calls`, { method: "POST", body: "x".repeat(65_537) });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "invalid-request-body" });
    } finally { await worker.close(); }
  });

  it("rejects invalid UTF-8", async () => {
    const worker = await setup();
    try {
      const response = await fetch(`${worker.baseUrl}/v1/calls`, { method: "POST", body: Buffer.from([0xff]) });
      expect(response.status).toBe(400);
    } finally { await worker.close(); }
  });

  it("redacts unexpected stream failures", async () => {
    const worker = createWorkerServer(secret);
    const handler = worker.server.listeners("request")[0] as (req: unknown, res: unknown) => Promise<void>;
    const request = Object.assign(new PassThrough(), { method: "POST", url: "/v1/calls", headers: {} });
    const response = Object.assign(new EventEmitter(), { status: 0, body: "", writeHead(status: number) { this.status = status; }, end(body: string) { this.body = body; } });
    const pending = handler(request, response);
    request.destroy(new Error("private stream details"));
    await pending;
    expect(response.status).toBe(500);
    expect(response.body).toBe('{"error":"internal-error"}');
  });
});
