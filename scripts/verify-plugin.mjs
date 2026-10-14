import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyInstalledAgent } from "./integration/openclaw-agent.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-plugin-check-"));
const env = Object.fromEntries(["PATH", "HOME", "USER", "SHELL", "TERM"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
Object.assign(env, {
  OPENCLAW_STATE_DIR: path.join(directory, "state"),
  OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
  OPENCLAW_HOME: path.join(directory, "home"),
  CI: "true",
});
try {
  await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ plugins: { allow: ["matrix-call"] } }));
  await exec("pnpm", ["--dir", path.join(root, "packages/openclaw-plugin"), "pack", "--pack-destination", directory], { cwd: directory, env });
  const archive = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
  assert(archive);
  const cli = path.join(root, "node_modules/.bin/openclaw");
  const installed = await exec(cli, ["plugins", "install", path.join(directory, archive), "--force", "--no-enable", "--accept-capabilities"], { cwd: directory, env, timeout: 60_000 });
  assert(!installed.stderr.includes("without channelConfigs"));
  await exec(cli, ["plugins", "enable", "matrix-call"], { cwd: directory, env, timeout: 60_000 });
  const { stdout } = await exec(cli, ["plugins", "list", "--json"], { cwd: directory, env, timeout: 60_000 });
  const result = JSON.parse(stdout).plugins.filter((plugin) => plugin.id === "matrix-call");
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "loaded");
  assert.equal(result[0].enabled, true);
  console.log("Packed plugin installed and loaded in an isolated OpenClaw profile.");
  await verifyInstalledAgent({ cli, directory, env });
} finally {
  await rm(directory, { recursive: true, force: true });
}
