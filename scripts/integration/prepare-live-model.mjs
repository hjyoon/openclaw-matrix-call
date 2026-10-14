import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir, saveAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { readLiveModel } from "./live-model.mjs";

try {
  const settings = readLiveModel(process.argv[2]);
  const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  const state = path.resolve(process.env.OPENCLAW_STATE_DIR);
  const agent = resolveAgentDir(config, "main");
  assert(path.resolve(agent).startsWith(state + path.sep));
  await mkdir(agent, { recursive: true, mode: 0o700 });
  saveAuthProfileStore({ version: 1, profiles: { [settings.profileId]: { ...settings.credential, copyToAgents: false } } }, agent);
  console.log(JSON.stringify({ model: settings.model, authType: "oauth-access-snapshot", refreshOwner: false }));
} catch { console.error("Private live-model credentials could not be prepared"); process.exitCode = 1; }
