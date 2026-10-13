import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { get } from "node:http";
import { describe, expect, it } from "vitest";
import { startAssetServer } from "../../packages/browser-worker/src/assets.js";
import { parseBrowserConfig } from "../../packages/browser-worker/src/config.js";
import { credentials, configuration } from "../fixtures/browser.js";

describe("private browser asset server", () => {
  it("serves an exact asset allowlist with isolation headers and no secret responses", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "matrix-call-assets-"));
    for (const file of ["browser.js", "e2ee-worker.js", "matrix_sdk_crypto_wasm_bg.wasm"]) await writeFile(path.join(dir, file), file);
    const policy = parseBrowserConfig(configuration, credentials).policy;
    const assets = await startAssetServer(dir, 0, credentials.baseUrl, policy);
    try {
      for (const file of ["/", "/browser.js", "/e2ee-worker.js", "/pkg/matrix_sdk_crypto_wasm_bg.wasm"]) {
        const response = await fetch(`${assets.origin}${file}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("content-security-policy")).toContain("wasm-unsafe-eval");
        expect(response.headers.get("content-security-policy")).toContain("https://sfu.example.org");
        expect(await response.text()).not.toContain(credentials.accessToken);
      }
      expect(await (await fetch(`${assets.origin}/browser.js`, { method: "HEAD" })).text()).toBe("");
      for (const [pathname, method, headers] of [["/unknown", "GET", {}], ["/browser.js?secret=token", "GET", {}], ["/browser.js", "POST", {}]] as const) {
        expect((await fetch(`${assets.origin}${pathname}`, { method, headers })).status).toBe(404);
      }
      expect(await new Promise((resolve, reject) => {
        get(`${assets.origin}/browser.js`, { headers: { Host: "rebound.example.org" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
      })).toBe(404);
      await expect(startAssetServer(dir, Number(new URL(assets.origin).port), credentials.baseUrl, policy)).rejects.toThrow("EADDRINUSE");
    } finally {
      const closing = assets.close(); expect(assets.close()).toBe(closing); await closing;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
