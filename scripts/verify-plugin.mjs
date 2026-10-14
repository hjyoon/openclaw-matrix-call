import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyInstalledAgent } from "./integration/openclaw-agent.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const registry = process.env.MATRIX_CALL_REGISTRY_INSTALL === "1";
const metadata = JSON.parse(await readFile(path.join(root, "packages/openclaw-plugin/package.json"), "utf8"));
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-plugin-check-"));
const env = Object.fromEntries(["PATH", "HOME", "USER", "SHELL", "TERM"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
Object.assign(env, {
  OPENCLAW_STATE_DIR: path.join(directory, "state"),
  OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
  OPENCLAW_HOME: path.join(directory, "home"),
  CI: "true",
});
if (registry) env.HOME = env.OPENCLAW_HOME;
try {
  await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ plugins: { allow: ["matrix-call"] } }));
  let source = `clawhub:${metadata.name}@${metadata.version}`;
  if (!registry) {
    await exec("pnpm", ["--dir", path.join(root, "packages/openclaw-plugin"), "pack", "--pack-destination", directory], { cwd: directory, env });
    const archive = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
    assert(archive); source = path.join(directory, archive);
  }
  const cli = path.join(root, "node_modules/.bin/openclaw");
  const installed = await exec(cli, ["plugins", "install", source, ...(registry ? [] : ["--force"]), "--no-enable", "--accept-capabilities"], { cwd: directory, env, timeout: 60_000 });
  assert(!installed.stderr.includes("without channelConfigs"));
  await exec(cli, ["plugins", "enable", "matrix-call"], { cwd: directory, env, timeout: 60_000 });
  const { stdout } = await exec(cli, ["plugins", "list", "--json"], { cwd: directory, env, timeout: 60_000 });
  const result = JSON.parse(stdout).plugins.filter((plugin) => plugin.id === "matrix-call");
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "loaded");
  assert.equal(result[0].enabled, true);
  const installedMetadata = JSON.parse(await readFile(path.join(env.OPENCLAW_STATE_DIR, "extensions/matrix-call/package.json"), "utf8"));
  assert.equal(installedMetadata.name, metadata.name); assert.equal(installedMetadata.version, metadata.version);
  if (registry) {
    const config = JSON.parse(await readFile(env.OPENCLAW_CONFIG_PATH, "utf8"));
    assert.equal(config.plugins.installs["matrix-call"].source, "clawhub");
    assert.equal(config.plugins.installs["matrix-call"].version, metadata.version);
  }
  console.log(`${registry ? "Public registry" : "Packed"} plugin installed and loaded in an isolated OpenClaw profile.`);
  await verifyInstalledAgent({ cli, directory, env });
} finally {
  await rm(directory, { recursive: true, force: true });
}
