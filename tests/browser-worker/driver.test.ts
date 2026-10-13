import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import { BrowserDriver } from "../../packages/browser-worker/src/driver.js";
import { parseBrowserConfig } from "../../packages/browser-worker/src/config.js";
import { configuration, credentials } from "../fixtures/browser.js";

const { launch, assetFactory, profileFactory } = vi.hoisted(() => ({ launch: vi.fn(), assetFactory: vi.fn(), profileFactory: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { launchPersistentContext: launch } }));
vi.mock("../../packages/browser-worker/src/assets.js", () => ({ startAssetServer: assetFactory }));
vi.mock("../../packages/browser-worker/src/profile.js", () => ({ openDeviceProfile: profileFactory }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const config = parseBrowserConfig(configuration, credentials);
  const keys = { ed25519: "A".repeat(43), curve25519: "B".repeat(43) };
  const runtime = { initialize: vi.fn(async () => keys), prepare: vi.fn(async () => {}), connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), publish: vi.fn(async () => {}), verify: vi.fn(async (reference: object) => ({ ...reference, userId: "@owner:example.org", deviceId: "OWNER", expiresAtMs: Date.now() + 10_000, deviceVerified: true, mediaEncrypted: true })), status: vi.fn(() => ({ connected: true })) };
  vi.stubGlobal("window", { createMatrixCall: vi.fn(() => runtime) });
  const page = { goto: vi.fn(async () => {}), waitForFunction: vi.fn(async (fn: () => boolean) => { expect(fn()).toBe(true); }), evaluate: vi.fn(async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)), close: vi.fn(async () => {}) };
  const spare = { close: vi.fn(async () => {}) };
  const context = Object.assign(new EventEmitter(), { newPage: vi.fn(async () => page as unknown as Page), pages: () => [spare, page], close: vi.fn(async () => { context.emit("close"); }) });
  const assets = { origin: "http://127.0.0.1:19791", close: vi.fn(async () => {}) };
  const profile = { expectedKeys: undefined, persist: vi.fn(async () => {}) };
  assetFactory.mockResolvedValue(assets); profileFactory.mockResolvedValue(profile); launch.mockResolvedValue(context);
  return { config, keys, runtime, page, spare, context, assets, profile, log };
}
const signal = () => new AbortController().signal;
const pcm = { samples: new Int16Array([-1, 0, 1]), sampleRate: 16_000, channels: 1 as const };
const reference = { roomId: "!room", rtcSessionId: "m.call#ROOM", participantId: "remote" };

describe("persistent production browser driver", () => {
  it.each([new Error("Matrix call ended: missing-key"), credentials.accessToken])("logs only a bounded failure code for failed connections", async (error) => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config);
    f.runtime.connect.mockRejectedValueOnce(error);
    await expect(driver.connect("!room", signal())).rejects.toBe(error);
    expect(JSON.parse(f.log.mock.calls[0]![0] as string)).toEqual({ event: "browser-call-failed", reason: error instanceof Error ? "missing-key" : "connection" });
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(credentials.accessToken);
    await driver.close();
  });
  it("launches sandboxed Chromium and binds private keys before device enrollment", async () => {
    const f = fixture();
    const driver = await BrowserDriver.start(f.config);
    expect(launch).toHaveBeenCalledWith(f.config.profileDir, expect.objectContaining({ chromiumSandbox: true, headless: true, channel: "chromium", acceptDownloads: false, serviceWorkers: "block", handleSIGTERM: false }));
    expect(f.spare.close).toHaveBeenCalledOnce();
    expect(f.page.goto).toHaveBeenCalledWith(f.assets.origin);
    expect(f.profile.persist).toHaveBeenCalledWith(f.keys);
    expect(f.profile.persist.mock.invocationCallOrder[0]).toBeLessThan(f.runtime.prepare.mock.invocationCallOrder[0]!);
    expect(driver.deviceKeys).toEqual(f.keys); expect(driver.available).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    const closed = driver.close(); expect(driver.close()).toBe(closed); await closed;
    expect(driver.available).toBe(false); expect(f.assets.close).toHaveBeenCalledOnce();
  });

  it.each(["profile", "launch", "navigation", "initialization", "enrollment"])("cleans resources and redacts startup failures: %s", async (stage) => {
    const f = fixture();
    const error = new Error(credentials.accessToken);
    if (stage === "profile") profileFactory.mockRejectedValue(error);
    if (stage === "launch") launch.mockRejectedValue(error);
    if (stage === "navigation") f.page.goto.mockRejectedValue(error);
    if (stage === "initialization") f.runtime.initialize.mockRejectedValue(error);
    if (stage === "enrollment") f.runtime.prepare.mockRejectedValue(error);
    await expect(BrowserDriver.start(f.config)).rejects.toThrow(/^Browser driver could not start: (profile|browser|bootstrap|device|enrollment)$/);
    expect(f.assets.close).toHaveBeenCalledOnce();
    expect(f.context.close.mock.calls.length).toBe(stage === "profile" || stage === "launch" ? 0 : 1);
  });

  it("transfers bounded PCM and current participant references without credentials", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config);
    await expect(driver.publish(pcm, signal())).rejects.toThrow("unavailable");
    await expect(driver.verify(reference, signal())).rejects.toThrow("unavailable");
    await driver.connect("!room", signal());
    await driver.publish(pcm, signal());
    expect(f.runtime.publish).toHaveBeenCalledWith(pcm, expect.any(AbortSignal));
    expect(await driver.verify(reference, signal())).toMatchObject(reference);
    await expect(driver.connect("!room", signal())).rejects.toThrow("busy");
    await driver.disconnect(); await driver.close();
    await expect(driver.connect("!room", signal())).rejects.toThrow("unavailable");
    await driver.disconnect();
  });

  it("checks cancellation before and after browser results", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config);
    const cancelled = AbortSignal.abort(new Error("cancelled"));
    await expect(driver.connect("!room", cancelled)).rejects.toThrow("cancelled");
    await expect(driver.publish(pcm, cancelled)).rejects.toThrow("cancelled");
    await expect(driver.verify(reference, cancelled)).rejects.toThrow("cancelled");
    await driver.connect("!room", signal());
    const controller = new AbortController();
    f.runtime.verify.mockImplementation(async () => { controller.abort(new Error("late cancellation")); return {} as never; });
    await expect(driver.verify(reference, controller.signal)).rejects.toThrow("late cancellation");
    await driver.close();
  });

  it("terminates the browser on opening cancellation and notifies the controller", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config);
    const ended = vi.fn(async () => {}); driver.onEnded(ended);
    const controller = new AbortController();
    f.runtime.connect.mockImplementation(async () => { controller.abort(new Error("cancelled")); });
    await expect(driver.connect("!room", controller.signal)).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.available).toBe(false); expect(ended).toHaveBeenCalledOnce();
    await driver.close();
  });

  it("fences close and disconnect races during connection setup", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config);
    f.runtime.connect.mockImplementationOnce(async () => { await driver.disconnect(); });
    await expect(driver.connect("!room", signal())).rejects.toThrow("connection changed");
    f.runtime.connect.mockImplementationOnce(async () => { await driver.close(); });
    await expect(driver.connect("!room", signal())).rejects.toThrow("connection changed");
  });

  it("reserves opening capacity and fences completed PCM and proof results", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config);
    let finish!: () => void;
    f.runtime.connect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const opening = driver.connect("!room", signal());
    await expect(driver.connect("!room", signal())).rejects.toThrow("busy");
    finish(); await opening;
    f.runtime.publish.mockImplementationOnce(async () => { await driver.disconnect(); });
    await expect(driver.publish(pcm, signal())).rejects.toThrow("call changed");
    await driver.connect("!room", signal());
    f.runtime.publish.mockImplementationOnce(async () => { await driver.disconnect(); await driver.connect("!room", signal()); });
    await expect(driver.publish(pcm, signal())).rejects.toThrow("call changed");
    f.runtime.verify.mockImplementationOnce(async () => { await driver.disconnect(); return {} as never; });
    await expect(driver.verify(reference, signal())).rejects.toThrow("call changed");
    await driver.connect("!room", signal());
    f.runtime.verify.mockImplementationOnce(async () => { await driver.disconnect(); await driver.connect("!room", signal()); return {} as never; });
    await expect(driver.verify(reference, signal())).rejects.toThrow("call changed");
    await driver.close();
  });

  it("aborts PCM output by ending the current call", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config);
    const ended = vi.fn(async () => {}); driver.onEnded(ended);
    await driver.connect("!room", signal());
    const controller = new AbortController();
    f.runtime.publish.mockImplementation(async () => { controller.abort(new Error("cancelled")); });
    await expect(driver.publish(pcm, controller.signal)).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.disconnect).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledOnce();
    await driver.close();
  });

  it("discards late status responses and avoids overlapping polls", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config); await driver.connect("!room", signal());
    let complete!: (status: object) => void;
    f.runtime.status.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }) as never);
    const ended = vi.fn(async () => {}); driver.onEnded(ended);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.runtime.status).toHaveBeenCalledOnce();
    await driver.disconnect(); await driver.connect("!room", signal());
    complete({ connected: false }); await vi.advanceTimersByTimeAsync(0);
    expect(ended).not.toHaveBeenCalled();
    f.runtime.status.mockReturnValue({ connected: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ended).toHaveBeenCalledOnce();
    await driver.close();
  });

  it("reports call termination through a default no-op observer", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config); await driver.connect("!room", signal());
    f.runtime.status.mockReturnValue({ connected: false }); await vi.advanceTimersByTimeAsync(1000);
    expect(driver.available).toBe(true);
    await driver.close();
  });

  it("closes a failed driver or observer and still attempts notifications", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config); await driver.connect("!room", signal());
    const ended = vi.fn(async () => { throw new Error("controller failed"); }); driver.onEnded(ended);
    f.runtime.status.mockImplementation(() => { throw new Error("page failed"); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(driver.available).toBe(false); expect(ended).toHaveBeenCalledOnce();
    await driver.close();
    const g = fixture(); const second = await BrowserDriver.start(g.config); await second.connect("!room", signal());
    second.onEnded(async () => { throw new Error("failed"); });
    g.context.close.mockRejectedValue(new Error("browser failed to close"));
    g.runtime.status.mockImplementation(() => { throw new Error("page failed"); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(g.assets.close).toHaveBeenCalledOnce();
    await expect(second.close()).rejects.toThrow("browser failed to close");
  });

  it("notifies on unexpected browser exit and suppresses observer cleanup failures", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config);
    const ended = vi.fn(async () => {}); driver.onEnded(ended);
    f.context.emit("close"); await vi.advanceTimersByTimeAsync(0);
    expect(ended).toHaveBeenCalledOnce(); await driver.close();
    const g = fixture(); const second = await BrowserDriver.start(g.config);
    g.context.close.mockRejectedValue(new Error("failed"));
    g.context.emit("close"); await vi.advanceTimersByTimeAsync(0);
    await expect(second.close()).rejects.toThrow("failed");
  });

  it("coalesces cleanup, fences reconnects, and permanently closes failed cleanup", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config); await driver.connect("!room", signal());
    let complete!: () => void;
    f.runtime.disconnect.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const one = driver.disconnect(); const two = driver.disconnect();
    await expect(driver.connect("!room", signal())).rejects.toThrow("busy");
    complete(); await Promise.all([one, two]);
    expect(f.runtime.disconnect).toHaveBeenCalledOnce();
    f.runtime.disconnect.mockRejectedValue(new Error("private failure"));
    await expect(driver.disconnect()).rejects.toThrow(/^Browser driver cleanup failed$/);
    expect(driver.available).toBe(false); await driver.close();
  });

  it("handles browser-close failures during connect and playback cancellation", async () => {
    const f = fixture(); const driver = await BrowserDriver.start(f.config);
    const controller = new AbortController();
    f.context.close.mockRejectedValue(new Error("close failed"));
    f.runtime.connect.mockImplementation(async () => { controller.abort(); });
    await expect(driver.connect("!room", controller.signal)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    await expect(driver.close()).rejects.toThrow("close failed");
    const g = fixture(); const second = await BrowserDriver.start(g.config); await second.connect("!room", signal());
    const cancel = new AbortController();
    g.runtime.disconnect.mockRejectedValue(new Error("disconnect failed"));
    g.runtime.publish.mockImplementation(async () => { cancel.abort(); });
    await expect(second.publish(pcm, cancel.signal)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0); await second.close();
  });
});
