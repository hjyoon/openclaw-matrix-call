import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

export async function loadTestControl(root, directory) {
  const outdir = path.join(directory, "control");
  await build({ absWorkingDir: root, entryPoints: { worker: "packages/worker/src/index.ts", core: "packages/core/src/index.ts" },
    outdir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "none", logLevel: "silent" });
  const { createWorkerServer, WorkerMediaController } = await import(pathToFileURL(path.join(outdir, "worker.mjs")));
  const { RequestAuthenticator } = await import(pathToFileURL(path.join(outdir, "core.mjs")));
  return async ({ page, roomId, focusUrl, sfuUrl }) => {
    const secret = randomBytes(32).toString("hex");
    const media = new WorkerMediaController({ rooms: [roomId], transport: {
      async connect(id, signal) {
        assert.equal(id, roomId);
        signal.throwIfAborted();
        const abort = () => { void page.close(); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          await page.evaluate(({ focus, sfu }) => window.matrixTest.connectAuthorized(focus, sfu), { focus: focusUrl, sfu: sfuUrl });
          signal.throwIfAborted();
        } finally { signal.removeEventListener("abort", abort); }
      },
      async disconnect() {
        if (!page.isClosed()) {
          await page.evaluate(async () => { await window.matrixTest.leave(); await window.mediaTest.close(); });
        }
      },
    } });
    const { server, audience } = createWorkerServer(secret, media);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    const auth = new RequestAuthenticator({ secret, audience });
    return {
      async request(pathname, value) {
        const body = JSON.stringify(value);
        const response = await fetch(`${url}${pathname}`, { method: "POST", body,
          headers: auth.sign({ method: "POST", path: pathname, body }), signal: AbortSignal.timeout(35_000) });
        const text = await response.text();
        auth.verify({ method: `RESPONSE_${response.status}`, path: pathname, body: text }, Object.fromEntries(response.headers));
        return { status: response.status, value: JSON.parse(text) };
      },
      async shutdown() {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await media.shutdown();
      },
    };
  };
}
