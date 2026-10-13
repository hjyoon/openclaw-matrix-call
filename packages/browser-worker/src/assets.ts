import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { BrowserPolicy } from "./types.js";

export async function startAssetServer(directory: string, port: number, matrixUrl: string, policy: BrowserPolicy) {
  const assets = new Map([
    ["/", { type: "text/html", body: Buffer.from('<!doctype html><meta charset="utf-8"><script type="module" src="/browser.js"></script>') }],
    ["/browser.js", { type: "text/javascript", body: await readFile(path.join(directory, "browser.js")) }],
    ["/e2ee-worker.js", { type: "text/javascript", body: await readFile(path.join(directory, "e2ee-worker.js")) }],
    ["/capture-worklet.js", { type: "text/javascript", body: await readFile(path.join(directory, "capture-worklet.js")) }],
    ["/pkg/matrix_sdk_crypto_wasm_bg.wasm", { type: "application/wasm", body: await readFile(path.join(directory, "matrix_sdk_crypto_wasm_bg.wasm")) }],
  ]);
  const endpoints = ["'self'", ...[matrixUrl, ...policy.focusUrls, ...policy.sfuUrls, ...policy.sfuUrls.map((url) => url.replace(/^ws/, "http"))].map((url) => new URL(url).origin)];
  let origin: string;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5_000 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; media-src blob:; connect-src ${endpoints.join(" ")}; frame-ancestors 'none'; base-uri 'none'`);
    const asset = assets.get(request.url!);
    if (request.headers.host !== new URL(origin).host || !["GET", "HEAD"].includes(request.method!) || !asset) {
      response.writeHead(404); response.end(); return;
    }
    response.setHeader("Content-Type", asset.type);
    response.setHeader("Content-Length", asset.body.byteLength);
    response.end(request.method === "HEAD" ? undefined : asset.body);
  });
  const listening = once(server, "listening");
  server.listen(port, "127.0.0.1");
  await listening;
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closing: Promise<void> | undefined;
  return Object.freeze({ origin, server,
    close(): Promise<void> {
      if (!closing) { server.closeAllConnections(); closing = new Promise((resolve) => server.close(() => resolve())); }
      return closing;
    },
  });
}
