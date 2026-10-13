import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = [
  { name: "core", entry: "packages/core/src/index.ts", output: "dist/core/index.js", external: [] },
  { name: "agent-http", entry: "packages/agent-http/src/index.ts", output: "dist/agent-http/index.js", external: [] },
  { name: "openclaw-plugin", entry: "packages/openclaw-plugin/src/index.ts", output: "packages/openclaw-plugin/dist/index.js", external: ["openclaw/*"] },
];

await mkdir(path.join(root, "dist/build-metadata"), { recursive: true });
for (const target of targets) {
  const outfile = path.join(root, target.output);
  await rm(path.dirname(outfile), { recursive: true, force: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: [target.entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: target.external,
    sourcemap: true,
    metafile: true,
    legalComments: "none",
    logLevel: "warning",
  });
  await writeFile(path.join(root, `dist/build-metadata/${target.name}.json`), JSON.stringify(result.metafile));
}
