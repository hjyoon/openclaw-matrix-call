import { chromium, type BrowserContext, type BrowserType, type Page } from "playwright-core";
import type { ParticipantReference, ParticipantVerifier, PcmAudio, RtcTransportPort } from "@matrix-call/core";
import { startAssetServer } from "./assets.js";
import { openDeviceProfile } from "./profile.js";
import { validatePcm } from "./audio.js";
import type { parseBrowserConfig } from "./config.js";
import type { DeviceKeys } from "./types.js";

export class BrowserDriver implements RtcTransportPort, ParticipantVerifier {
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #assets: Awaited<ReturnType<typeof startAssetServer>>;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly deviceKeys: DeviceKeys;
  #connected = false;
  #closed = false;
  #checking = false;
  #opening = false;
  #generation = 0;
  #closing: Promise<void> | undefined;
  #disconnecting: Promise<void> | undefined;
  #onEnded: () => Promise<void> = async () => {};

  private constructor(context: BrowserContext, page: Page, assets: Awaited<ReturnType<typeof startAssetServer>>, keys: DeviceKeys) {
    this.#context = context; this.#page = page; this.#assets = assets; this.deviceKeys = Object.freeze(keys);
    this.#timer = setInterval(() => { void this.#check(); }, 1000);
    context.on("close", () => {
      if (!this.#closed) void this.close().then(() => this.#notify()).catch(() => {});
    });
  }

  static async start(config: ReturnType<typeof parseBrowserConfig>, launcher: Pick<BrowserType, "launchPersistentContext"> = chromium) {
    const assets = await startAssetServer(config.assetDir, config.assetPort, config.credentials.baseUrl, config.policy);
    let context: BrowserContext | undefined;
    let stage = "profile";
    try {
      const profile = await openDeviceProfile(config.profileDir, config.credentials, assets.origin);
      stage = "browser";
      context = await launcher.launchPersistentContext(config.profileDir, { headless: true, channel: "chromium", chromiumSandbox: true,
        args: ["--autoplay-policy=no-user-gesture-required"], acceptDownloads: false, serviceWorkers: "block",
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      const page = await context.newPage();
      for (const other of context.pages()) if (other !== page) await other.close();
      stage = "bootstrap";
      await page.goto(assets.origin);
      await page.waitForFunction(() => typeof window.createMatrixCall === "function");
      stage = "device";
      const keys = await page.evaluate(async (setup) => {
        window.matrixCall = window.createMatrixCall(setup);
        return window.matrixCall.initialize();
      }, { credentials: config.credentials, policy: config.policy, expectedKeys: profile.expectedKeys });
      await profile.persist(keys);
      stage = "enrollment";
      await page.evaluate(() => window.matrixCall.prepare());
      return new BrowserDriver(context, page, assets, keys);
    } catch {
      try { await context?.close(); }
      finally { await assets.close(); }
      throw new Error(`Browser driver could not start: ${stage}`);
    }
  }

  get available(): boolean { return !this.#closed; }

  onEnded(listener: () => Promise<void>): void { this.#onEnded = listener; }

  async #notify(): Promise<void> {
    try { await this.#onEnded(); }
    catch { await this.close().catch(() => {}); }
  }

  async #check(): Promise<void> {
    if (!this.#connected || this.#checking) return;
    this.#checking = true;
    const generation = this.#generation;
    try {
      const status = await this.#page.evaluate(() => window.matrixCall.status());
      if (generation === this.#generation && !status.connected) { this.#connected = false; await this.#notify(); }
    } catch { await this.close().catch(() => {}); await this.#notify(); }
    finally { this.#checking = false; }
  }

  async connect(roomId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#closed || this.#connected || this.#opening || this.#disconnecting) throw new Error("Browser driver is unavailable or busy");
    this.#opening = true;
    const generation = ++this.#generation;
    const abort = (): void => { void this.close().then(() => this.#notify()).catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.#page.evaluate((roomId) => window.matrixCall.connect(roomId), roomId);
      signal.throwIfAborted();
      if (this.#closed || generation !== this.#generation) throw new Error("Browser driver connection changed");
      this.#connected = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const reason = ["state", "media", "keys", "listeners", "missing-key", "invalid-key", "encryption"].find((code) => message.includes(`Matrix call ended: ${code}`)) ??
        ["invalid-config", "unsupported-call", "untrusted-focus", "membership-changed", "invalid-response", "untrusted-sfu", "identity-mismatch", "response-too-large", "http-error"].find((code) => message.includes(`FocusAuthorizationError: ${code}`)) ?? "connection";
      console.info(JSON.stringify({ event: "browser-call-failed", reason }));
      throw error;
    } finally { this.#opening = false; signal.removeEventListener("abort", abort); }
  }

  async publish(audio: PcmAudio, signal: AbortSignal): Promise<void> {
    validatePcm(audio); signal.throwIfAborted();
    if (!this.#connected) throw new Error("Browser driver is unavailable");
    const generation = this.#generation;
    const abort = (): void => { void this.disconnect().then(() => this.#notify()).catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.#page.evaluate((audio) => window.matrixCall.publish({ ...audio, samples: new Int16Array(audio.samples) }, new AbortController().signal), { samples: Array.from(audio.samples), sampleRate: audio.sampleRate, channels: audio.channels });
      signal.throwIfAborted();
      if (!this.#connected || generation !== this.#generation) throw new Error("Browser driver call changed");
    } finally { signal.removeEventListener("abort", abort); }
  }

  async verify(reference: ParticipantReference, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.#connected) throw new Error("Browser driver is unavailable");
    const generation = this.#generation;
    const proof = await this.#page.evaluate((reference) => window.matrixCall.verify(reference, new AbortController().signal), reference);
    signal.throwIfAborted();
    if (!this.#connected || generation !== this.#generation) throw new Error("Browser driver call changed");
    return proof;
  }

  async disconnect(): Promise<void> {
    if (this.#closed) return;
    if (this.#disconnecting) return this.#disconnecting;
    this.#connected = false; ++this.#generation;
    this.#disconnecting = this.#page.evaluate(() => window.matrixCall.disconnect()).catch(async () => {
      await this.close(); throw new Error("Browser driver cleanup failed");
    }).finally(() => { this.#disconnecting = undefined; });
    return this.#disconnecting;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#connected = false; ++this.#generation; clearInterval(this.#timer);
    this.#closing = this.#context.close().finally(() => this.#assets.close());
    return this.#closing;
  }
}
