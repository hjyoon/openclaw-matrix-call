import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { buildBrowserAssets, copyBrowserLicenses } from "./build-browser-assets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = [
  { name: "core", entry: "packages/core/src/index.ts", output: "dist/core/index.js", external: [] },
  { name: "agent-http", entry: "packages/agent-http/src/index.ts", output: "dist/agent-http/index.js", external: [] },
  { name: "speech-http", entry: "packages/speech-http/src/index.ts", output: "dist/speech-http/index.js", external: [] },
  { name: "voice", entry: "packages/voice/src/index.ts", output: "dist/voice/index.js", external: [] },
  { name: "openclaw-plugin", entry: "packages/openclaw-plugin/src/index.ts", output: "packages/openclaw-plugin/dist/index.js", external: ["openclaw/*"] },
  { name: "worker", entry: "packages/worker/src/main.ts", output: "dist/worker/worker.mjs", external: [] },
  { name: "worker-api", entry: "packages/worker/src/index.ts", output: "dist/worker/index.js", external: [] },
  { name: "matrixrtc", entry: "packages/matrixrtc/src/index.ts", output: "dist/matrixrtc/index.js", external: [], platform: "browser" },
  { name: "browser-worker", entry: "packages/browser-worker/src/main.ts", output: "dist/browser-worker/worker.mjs", external: ["playwright-core"] },
  { name: "browser-worker-api", entry: "packages/browser-worker/src/index.ts", output: "dist/browser-worker/index.js", external: ["playwright-core"] },
];

await mkdir(path.join(root, "dist/build-metadata"), { recursive: true });
for (const directory of new Set(targets.map((target) => path.dirname(path.join(root, target.output))))) {
  await rm(directory, { recursive: true, force: true });
}
const browser = await buildBrowserAssets(root, path.join(root, "dist/browser-worker/assets"));
await writeFile(path.join(root, "dist/build-metadata/browser-assets.json"), JSON.stringify(browser));
await copyBrowserLicenses(root, path.join(root, "dist/browser-worker/licenses"), browser);
for (const target of targets) {
  const outfile = path.join(root, target.output);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [target.entry],
    outfile,
    bundle: true,
    platform: target.platform ?? "node",
    format: "esm",
    target: target.platform === "browser" ? "es2023" : "node24",
    external: target.external,
    sourcemap: true,
    metafile: true,
    legalComments: "none",
    logLevel: "warning",
  });
  await writeFile(path.join(root, `dist/build-metadata/${target.name}.json`), JSON.stringify(result.metafile));
}
