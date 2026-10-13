import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const workspace = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const workerBuild = JSON.parse(await readFile(path.join(root, "deployment/worker-build/package.json"), "utf8"));
const corePackage = JSON.parse(await readFile(path.join(root, "packages/core/package.json"), "utf8"));
assert.equal(workerBuild.dependencies.esbuild, workspace.devDependencies.esbuild);
assert.equal(workerBuild.dependencies.zod, corePackage.dependencies.zod);
const notices = await readFile(path.join(root, "packages/openclaw-plugin/THIRD_PARTY_NOTICES.md"), "utf8");
assert(notices.includes("Copyright (c) 2025 Colin McDonnell"));
const matrixrtcPackage = JSON.parse(await readFile(path.join(root, "packages/matrixrtc/package.json"), "utf8"));
for (const name of ["livekit-client", "matrix-js-sdk"]) {
  assert.equal(matrixrtcPackage.dependencies[name], workspace.devDependencies[name]);
}
const browserMetadata = JSON.parse(await readFile(path.join(root, "dist/build-metadata/matrixrtc.json"), "utf8"));
assert(Object.values(browserMetadata.outputs).every((output) => output.imports.length === 0));
assert(!Object.keys(browserMetadata.inputs).some((entry) => /(?:openclaw|packages\/core\/src)/.test(entry)));
for (const name of ["core", "agent-http", "openclaw-plugin", "worker", "worker-api"]) {
  const metadata = JSON.parse(await readFile(path.join(root, `dist/build-metadata/${name}.json`), "utf8"));
  const imports = Object.values(metadata.outputs).flatMap((output) => output.imports);
  if (name === "openclaw-plugin") {
    assert(imports.some((entry) => entry.path === "openclaw/plugin-sdk/channel-core"));
    assert(imports.every((entry) => entry.path.startsWith("node:") || entry.path.startsWith("openclaw/plugin-sdk/")));
  } else {
    assert(imports.every((entry) => entry.path.startsWith("node:")));
    assert(!Object.keys(metadata.inputs).some((entry) => /node_modules\/.*openclaw/.test(entry)));
  }
}

const core = await import(pathToFileURL(path.join(root, "dist/core/index.js")));
assert.equal(core.parsePolicy({ owners: ["@owner:example.org"], rooms: ["!room:example.org"], agents: ["assistant"] }).agents[0], "assistant");
const agent = await import(pathToFileURL(path.join(root, "dist/agent-http/index.js")));
assert.equal(typeof agent.HttpAgentAdapter.connect, "function");
const plugin = await import(pathToFileURL(path.join(root, "packages/openclaw-plugin/dist/index.js")));
assert.equal(plugin.default.id, "matrix-call");
assert.equal(typeof plugin.default.register, "function");
const manifest = JSON.parse(await readFile(path.join(root, "packages/openclaw-plugin/openclaw.plugin.json"), "utf8"));
assert.equal(manifest.id, plugin.default.id);
assert.equal(manifest.version, "0.1.0-alpha.1");
assert.deepEqual(manifest.channelConfigs["matrix-call"].schema, plugin.matrixCallChannel.configSchema.schema);
console.log("Standalone bundles, public SDK imports, and plugin metadata verified.");
