import { afterEach, expect, it, vi } from "vitest";
import { configuration, credentials } from "../fixtures/browser.js";
import { parseBrowserConfig } from "../../packages/browser-worker/src/config.js";
import type { BrowserSetup } from "../../packages/browser-worker/src/types.js";

const { factory } = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("../../packages/browser-worker/src/runtime.js", () => ({ BrowserMatrixRuntime: class { constructor(setup: BrowserSetup) { return factory(setup); } } }));
afterEach(() => vi.unstubAllGlobals());

it("installs only a local runtime factory until the host supplies configuration", async () => {
  vi.stubGlobal("window", {});
  await import("../../packages/browser-worker/src/browser.js");
  expect(factory).not.toHaveBeenCalled();
  const config = parseBrowserConfig(configuration, credentials);
  const setup: BrowserSetup = { credentials: config.credentials, policy: config.policy, expectedKeys: undefined };
  const runtime = {};
  factory.mockReturnValue(runtime);
  expect(window.createMatrixCall(setup)).toBe(runtime);
  expect(factory).toHaveBeenCalledWith(setup);
});
