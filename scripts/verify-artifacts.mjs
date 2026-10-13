import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const name of ["core", "agent-http", "openclaw-plugin"]) {
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
console.log("Standalone bundles, public SDK imports, and plugin metadata verified.");
