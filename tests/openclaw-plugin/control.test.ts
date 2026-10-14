import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { createNativeWorkerControl, NativeControlError } from "../../packages/openclaw-plugin/src/control.js";
import { createWorkerServer, WorkerHttpClient, WorkerHttpError, WorkerMediaController } from "../../packages/worker/src/index.js";

const secret = "ab".repeat(32);
const policy = { owners: ["@owner:example.org"], rooms: ["!room:example.org"], agents: ["main"] };
const join = { operation: "join", roomId: policy.rooms[0]! };
const authorized = () => {};
const signal = () => new AbortController().signal;

async function fixture(limits = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-control-test-"));
  const secretFile = path.join(directory, "worker.secret");
  await writeFile(secretFile, secret + "\n", { mode: 0o600 });
  const transport = { connect: vi.fn(async (_room: string, _signal: AbortSignal) => {}), disconnect: vi.fn(async () => {}) };
  const media = new WorkerMediaController({ rooms: [...policy.rooms, "!other:example.org"], transport });
  const { server } = createWorkerServer(secret, media);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const settings = { baseUrl, secretFile, allowInsecureLoopback: true, timeoutMs: 1000 };
  const context: OpenClawPluginServiceContext = {
    config: { channels: { "matrix-call": { enabled: true, policy, workerControl: settings } } },
    stateDir: directory, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const background = vi.fn(() => {});
  const runBackground = <T>(operation: () => T): T => { background(); return operation(); };
  const api = { lifecycle: { runInBackgroundContext: runBackground, registerRuntimeLifecycle: vi.fn() } } as unknown as OpenClawPluginApi;
  const control = createNativeWorkerControl(api, limits);
  const command = (args?: string, overrides: Partial<PluginCommandContext> = {}) => control.command({
    channel: "matrix", senderId: policy.owners[0], isAuthorizedSender: true,
    commandBody: "/matrixcall", config: context.config, ...(args === undefined ? {} : { args }), ...overrides,
  } as PluginCommandContext);
  const cleanup = async () => {
    await Promise.resolve(control.service.stop!(context)).catch(() => {});
    await media.shutdown().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, settings, context, background, runBackground, api, control, command, transport, media, server, cleanup };
}

describe("native worker control", () => {
  it("authenticates capabilities and controls exact sessions through managed callbacks", async () => {
    const test = await fixture();
    try {
      expect(test.control.service.reload).toEqual({ configPrefixes: ["channels.matrix-call"] });
      await test.control.service.start(test.context);
      expect(test.context.logger.info).toHaveBeenCalledExactlyOnceWith("Matrix Call worker control authenticated");
      expect(await test.control.execute({ operation: "status" }, authorized)).toEqual({ available: true, session: null });
      const connected = await test.control.execute(join, authorized) as { sessionId: string };
      expect(test.transport.connect).toHaveBeenCalledExactlyOnceWith(join.roomId, expect.any(AbortSignal));
      expect(await test.control.execute({ operation: "status" }, authorized)).toEqual(test.media.status());
      expect(await test.control.execute({ operation: "leave", sessionId: connected.sessionId.toUpperCase() }, authorized)).toEqual({ closed: true });
      await test.control.service.stop!(test.context);
      expect(test.background).toHaveBeenCalledTimes(5);
      expect(test.transport.disconnect).toHaveBeenCalledTimes(1);
    } finally { await test.cleanup(); }
  });

  it.each([{}, { enabled: false }, { enabled: true, policy }])("stays inactive without explicit worker configuration %#", async (account) => {
    const test = await fixture();
    try {
      test.context.config = { channels: { "matrix-call": account } };
      await test.control.service.start(test.context);
      await expect(test.control.execute({ operation: "status" }, authorized)).rejects.toThrow("worker-unavailable");
      expect(test.background).not.toHaveBeenCalled();
    } finally { await test.cleanup(); }
  });

  it.each(["missing", "directory", "symlink", "invalid-key", "invalid-account", "lifecycle", "wrong-key", "shared-key"])("redacts %s startup failure and supports a later valid start", async (kind) => {
    const test = await fixture();
    const original = test.settings.secretFile;
    try {
      const invalid = path.join(test.directory, "private-invalid");
      if (kind === "directory") await mkdir(invalid);
      if (kind === "symlink") await symlink(original, invalid);
      if (kind === "invalid-key") await writeFile(invalid, "private-invalid-credential", { mode: 0o600 });
      test.settings.secretFile = invalid;
      if (kind === "invalid-account") test.context.config = { channels: { "matrix-call": { enabled: true } } };
      if (kind === "lifecycle") { test.settings.secretFile = original; test.api.lifecycle = { registerRuntimeLifecycle: vi.fn() }; }
      if (kind === "wrong-key") await writeFile(invalid, "cd".repeat(32), { mode: 0o600 });
      if (kind === "shared-key") {
        test.settings.secretFile = original;
        test.context.config = { channels: { "matrix-call": { enabled: true, policy, workerControl: test.settings, agentService: { secretFile: original } } } };
      }
      await expect(test.control.service.start(test.context)).rejects.toThrow("Matrix Call worker control could not start");
      test.settings.secretFile = original;
      test.api.lifecycle = { runInBackgroundContext: test.runBackground, registerRuntimeLifecycle: vi.fn() };
      test.context.config = { channels: { "matrix-call": { enabled: true, policy, workerControl: test.settings } } };
      await test.control.service.start(test.context);
      expect(await test.control.execute({ operation: "status" }, authorized)).toEqual({ available: true, session: null });
    } finally { await test.cleanup(); }
  });

  it("accepts a distinct agent key without exposing it to the worker", async () => {
    const test = await fixture();
    try {
      const agentSecret = path.join(test.directory, "agent.secret");
      await writeFile(agentSecret, "cd".repeat(32), { mode: 0o600 });
      test.context.config = { channels: { "matrix-call": { enabled: true, policy, workerControl: test.settings, agentService: { secretFile: agentSecret } } } };
      await test.control.service.start(test.context);
      expect(await test.command()).toEqual({ text: 'Matrix Call media control: {"available":true,"session":null}. Assistant readiness remains unverified.' });
      expect(await test.command("  ")).toEqual(await test.command("status"));
    } finally { await test.cleanup(); }
  });

  it.each([
    { senderId: "@visitor:example.org" }, { senderId: undefined }, { isAuthorizedSender: false },
    { channel: "telegram" }, { channelId: "telegram" },
    { senderId: "@visitor:example.org", from: policy.owners[0], senderIsOwner: true },
  ])("rejects a Matrix command without exact current owner identity %#", async (overrides) => {
    const test = await fixture();
    try {
      await test.control.service.start(test.context);
      expect(await test.command("join " + join.roomId, overrides as Partial<PluginCommandContext>)).toEqual({ text: "Matrix Call control unavailable: forbidden" });
      expect(test.transport.connect).not.toHaveBeenCalled();
    } finally { await test.cleanup(); }
  });

  it("honors canonical Matrix channel identity and strict command arguments", async () => {
    const test = await fixture();
    try {
      await test.control.service.start(test.context);
      expect((await test.command("join " + join.roomId, { channel: "Matrix", channelId: "matrix" })).text).toContain('"state":"connected"');
      const sessionId = test.media.status().session!.sessionId;
      expect((await test.command("leave " + sessionId)).text).toContain('"closed":true');
      expect((await test.command("join !unlisted")).text).toContain("forbidden");
      expect((await test.command("leave invalid")).text).toContain("invalid-request");
      expect((await test.command("join")).text).toContain("Usage:");
      expect((await test.command("status extra")).text).toContain("Usage:");
      expect((await test.command("unknown")).text).toContain("Usage:");
    } finally { await test.cleanup(); }
  });

  it("rejects caller authority before parsing, and rejects strict invalid requests", async () => {
    const test = await fixture();
    try {
      const deny = () => { throw new NativeControlError("forbidden"); };
      await expect(test.control.execute({ operation: "invented" }, deny)).rejects.toThrow("forbidden");
      await test.control.service.start(test.context);
      for (const value of [null, { operation: "status", role: "owner" }, { operation: "join", roomId: "not-room" }]) {
        await expect(test.control.execute(value, authorized)).rejects.toThrow("invalid-request");
      }
      await expect(test.control.execute({ operation: "join", roomId: "!unlisted" }, authorized)).rejects.toThrow("forbidden");
      await expect(test.control.execute({ operation: "leave", sessionId: randomUUID() }, authorized)).rejects.toThrow("not-found");
    } finally { await test.cleanup(); }
  });

  it("preserves independent worker sessions and hides unconfigured rooms", async () => {
    const test = await fixture();
    try {
      const external = await test.media.join({ roomId: "!other:example.org" }, signal());
      await test.control.service.start(test.context);
      await expect(test.control.execute({ operation: "status" }, authorized)).rejects.toThrow("forbidden");
      await expect(test.control.execute({ operation: "leave", sessionId: external.sessionId }, authorized)).rejects.toThrow("forbidden");
      await test.control.service.stop!(test.context);
      expect(test.media.status().session?.sessionId).toBe(external.sessionId);
      expect(test.transport.disconnect).not.toHaveBeenCalled();
    } finally { await test.cleanup(); }
  });

  it("does not discard ownership after a lost success response", async () => {
    const test = await fixture();
    const original = WorkerHttpClient.prototype.join;
    try {
      await test.control.service.start(test.context);
      const lost = vi.spyOn(WorkerHttpClient.prototype, "join").mockImplementationOnce(async function (this: WorkerHttpClient, ...args) {
        await original.apply(this, args); throw new Error("private lost response");
      });
      await expect(test.control.execute(join, authorized)).rejects.toThrow("control-failed");
      expect(test.media.status().session).not.toBeNull();
      lost.mockRestore();
      await test.control.service.stop!(test.context);
      expect(test.media.status().session).toBeNull();
      expect(test.transport.disconnect).toHaveBeenCalledTimes(1);
    } finally { await test.cleanup(); }
  });

  it("retains exact IDs after backend failure and safely observes already-ended sessions", async () => {
    const test = await fixture();
    try {
      await test.control.service.start(test.context);
      test.transport.connect.mockRejectedValueOnce(new Error("private transport failure"));
      await expect(test.control.execute(join, authorized)).rejects.toThrow("backend-failed");
      await test.control.service.stop!(test.context);
      expect(test.media.status().session).toBeNull();
      await test.control.service.start(test.context);
      const connected = await test.control.execute(join, authorized) as { sessionId: string };
      await expect(test.control.execute({ operation: "leave", sessionId: randomUUID() }, authorized)).rejects.toThrow("not-found");
      expect(test.media.status().session?.sessionId).toBe(connected.sessionId);
    } finally { await test.cleanup(); }
  });

  it("bounds admitted operations and cancels pending joins before owned cleanup", async () => {
    const test = await fixture({ maxPending: 1 });
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    test.transport.connect.mockImplementationOnce(async (_room, abort) => {
      began(); await once(abort, "abort"); throw abort.reason;
    });
    try {
      await test.control.service.start(test.context);
      const pending = test.control.execute(join, authorized);
      const rejected = expect(pending).rejects.toThrow("control-failed");
      await started;
      await expect(test.control.execute({ operation: "status" }, authorized)).rejects.toThrow("busy");
      const stop = test.control.service.stop!(test.context);
      await rejected;
      await stop;
      expect(test.media.status().session).toBeNull();
      expect(test.transport.disconnect).toHaveBeenCalledTimes(1);
    } finally { await test.cleanup(); }
  });

  it("releases unaccepted IDs after busy rejection and bounds retained ownership", async () => {
    const test = await fixture({ maxOwned: 1 });
    try {
      await test.control.service.start(test.context);
      const external = await test.media.join({ roomId: join.roomId }, signal());
      await expect(test.control.execute(join, authorized)).rejects.toThrow("busy");
      await test.media.leave({ sessionId: external.sessionId });
      await test.control.execute(join, authorized);
      await expect(test.control.execute(join, authorized)).rejects.toThrow("capacity-exceeded");
    } finally { await test.cleanup(); }
  });

  it("blocks replacement when exact-session cleanup fails, then recovers safely", async () => {
    const test = await fixture();
    try {
      await test.control.service.start(test.context);
      const connected = await test.control.execute(join, authorized) as { sessionId: string };
      const leave = vi.spyOn(WorkerHttpClient.prototype, "leave").mockRejectedValueOnce(new Error("private connection loss"));
      await expect(test.control.service.stop!(test.context)).rejects.toThrow("control-failed");
      await expect(test.control.execute({ operation: "status" }, authorized)).rejects.toThrow("worker-unavailable");
      leave.mockRejectedValueOnce(new WorkerHttpError("http-error"));
      await expect(test.control.service.start(test.context)).rejects.toThrow("control-failed");
      expect(test.media.status().session?.sessionId).toBe(connected.sessionId);
      leave.mockRestore();
      await test.control.service.start(test.context);
      expect(test.media.status().session).toBeNull();
    } finally { await test.cleanup(); }
  });

  it("rechecks current authority after a reply and preserves a newly opened session for cleanup", async () => {
    const test = await fixture();
    try {
      await test.control.service.start(test.context);
      let checks = 0;
      const revoked = () => { if (++checks > 2) throw new NativeControlError("forbidden"); };
      await expect(test.control.execute(join, revoked)).rejects.toThrow("forbidden");
      expect(test.media.status().session).not.toBeNull();
      await test.control.service.stop!(test.context);
      expect(test.media.status().session).toBeNull();
    } finally { await test.cleanup(); }
  });

  it("honors caller cancellation and rejects closed managed admission without leaking details", async () => {
    const test = await fixture();
    try {
      await test.control.service.start(test.context);
      const controller = new AbortController(); controller.abort(new Error("private cancelled request"));
      await expect(test.control.execute(join, authorized, controller.signal)).rejects.toThrow("control-failed");
      expect(test.transport.connect).not.toHaveBeenCalled();
      test.background.mockImplementationOnce(() => { throw new Error("private disposed lifecycle"); });
      expect(await test.command("status")).toEqual({ text: "Matrix Call control unavailable: control-failed" });
    } finally { await test.cleanup(); }
  });

  it("rechecks authority after completed leave and retains its ID until exact cleanup", async () => {
    const test = await fixture();
    let permitted = true;
    const assertAuthorized = () => { if (!permitted) throw new NativeControlError("forbidden"); };
    try {
      await test.control.service.start(test.context);
      const session = await test.control.execute(join, authorized) as { sessionId: string };
      test.transport.disconnect.mockImplementationOnce(async () => { permitted = false; });
      await expect(test.control.execute({ operation: "leave", sessionId: session.sessionId }, assertAuthorized)).rejects.toThrow("forbidden");
      expect(test.media.status().session).toBeNull();
      await test.control.service.stop!(test.context);
      expect(test.transport.disconnect).toHaveBeenCalledTimes(1);
    } finally { await test.cleanup(); }
  });

  it("serializes reload and stop, cleaning only owned sessions and adopting the new policy", async () => {
    const test = await fixture();
    try {
      await test.control.service.start(test.context);
      await test.control.execute(join, authorized);
      test.context.config = { channels: { "matrix-call": { enabled: true, policy: { ...policy, owners: ["@new:example.org"] }, workerControl: test.settings } } };
      await Promise.all([test.control.service.start(test.context), test.control.service.stop!(test.context)]);
      expect(test.media.status().session).toBeNull();
      await test.control.service.start(test.context);
      expect((await test.command()).text).toContain("forbidden");
      expect((await test.command("status", { senderId: "@new:example.org" })).text).toContain('"available":true');
    } finally { await test.cleanup(); }
  });

  it.each([{ maxPending: 0 }, { maxPending: 257 }, { maxPending: 1.5 }, { maxOwned: 0 }, { maxOwned: 65537 }, { maxOwned: 1.5 }])("rejects invalid admission bounds %#", (limits) => {
    expect(() => createNativeWorkerControl({ lifecycle: { registerRuntimeLifecycle: vi.fn() } }, limits)).toThrow("invalid-request");
  });
});
