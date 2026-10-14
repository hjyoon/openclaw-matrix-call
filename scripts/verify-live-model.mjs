import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readLiveModel } from "./integration/live-model.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-model-settings-"));
const file = path.join(directory, "model.json");
const fake = { schemaVersion: 1, model: "openai/test-model", settings: { agentRuntime: { id: "openclaw" } }, thinking: "high",
  credential: { type: "oauth", provider: "openai", access: "fake-access-for-redaction-test", refresh: "", expires: Date.now() + 3_600_000 } };
const invalid = () => assert.throws(() => readLiveModel(file), { message: "Private live-model configuration is invalid or expired" });
try {
  await writeFile(file, JSON.stringify(fake), { mode: 0o600 });
  assert.equal(readLiveModel(file).credential.refresh, "");
  assert.equal(readLiveModel(file).profileId, "openai:matrix-call-test");
  for (const value of [
    { ...fake, credential: { ...fake.credential, refresh: "fake-refresh-must-not-copy" } },
    { ...fake, credential: { ...fake.credential, expires: Date.now() + 60_000 } },
    { ...fake, credential: { ...fake.credential, provider: "another" } },
    { ...fake, credential: { ...fake.credential, setup: { private: true } } },
    { ...fake, extra: fake.credential.access },
  ]) { await writeFile(file, JSON.stringify(value)); invalid(); }
  await writeFile(file, "invalid-json-" + fake.credential.access); invalid();
  await writeFile(file, " ".repeat(65_537)); invalid();
  await writeFile(file, JSON.stringify(fake));
  await chmod(file, 0o640); invalid(); await chmod(file, 0o600);
  await chmod(directory, 0o750); invalid(); await chmod(directory, 0o700);
  const linked = path.join(directory, "linked.json");
  await link(file, linked); invalid(); await rm(linked);
  await rm(file); await writeFile(linked, JSON.stringify(fake), { mode: 0o600 }); await symlink(linked, file); invalid();
  await rm(file); await writeFile(file, JSON.stringify(fake), { mode: 0o600 });
  const env = Object.fromEntries(["PATH", "USER", "SHELL", "TERM"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  Object.assign(env, { HOME: path.join(directory, "home"), OPENCLAW_HOME: path.join(directory, "home"),
    OPENCLAW_STATE_DIR: path.join(directory, "state"), OPENCLAW_CONFIG_PATH: path.join(directory, "config.json") });
  await mkdir(env.OPENCLAW_STATE_DIR, { mode: 0o700 });
  const config = { agents: { entries: { main: {} } } };
  await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
  const prepare = () => exec(process.execPath, [path.join(root, "scripts/integration/prepare-live-model.mjs"), file], { cwd: root, env, timeout: 30_000 });
  const prepared = await prepare();
  assert(!prepared.stdout.includes(fake.credential.access) && !prepared.stderr.includes(fake.credential.access));
  const metadata = prepared.stdout.split("\n").filter((line) => line.startsWith("{"));
  assert.equal(metadata.length, 1);
  assert.deepEqual(JSON.parse(metadata[0]), { model: fake.model, authType: "oauth-access-snapshot", refreshOwner: false });
  const inspect = `import assert from "node:assert/strict"; import fs from "node:fs";
    import { loadAuthProfileStoreWithoutExternalProfiles, resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
    const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
    const store = loadAuthProfileStoreWithoutExternalProfiles(resolveAgentDir(config, "main"));
    assert.equal(Object.keys(store.profiles).length, 1);
    const credential = store.profiles["openai:matrix-call-test"];
    assert.equal(credential.access, "fake-access-for-redaction-test"); assert.equal(credential.refresh ?? "", "");
    assert.equal(credential.copyToAgents, false);`;
  await exec(process.execPath, ["--input-type=module", "-e", inspect], { cwd: root, env, timeout: 30_000 });
  const unchanged = await readFile(env.OPENCLAW_CONFIG_PATH, "utf8");
  config.agents.entries.main.agentDir = path.join(directory, "outside-state");
  await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  await assert.rejects(prepare(), (error) => error.code === 1 && error.stdout === ""
    && error.stderr.trim() === "Private live-model credentials could not be prepared");
  await writeFile(env.OPENCLAW_CONFIG_PATH, unchanged);
  await writeFile(file, JSON.stringify({ ...fake, credential: { ...fake.credential, refresh: "fake-refresh-must-not-copy" } }));
  await assert.rejects(prepare(), (error) => error.code === 1 && error.stdout === ""
    && error.stderr.trim() === "Private live-model credentials could not be prepared");
  console.log("Private access-only model settings, isolated storage and redacted failures verified");
} finally { await rm(directory, { recursive: true, force: true }); }
