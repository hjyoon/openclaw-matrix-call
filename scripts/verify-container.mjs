import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

const exec = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-container-check-"));
const secretFile = path.join(directory, "secret");
await writeFile(secretFile, randomBytes(32).toString("hex"), { mode: 0o444 });
let container;
try {
  const result = await exec("docker", [
    "run", "--detach", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--pids-limit=64", "--memory=256m", "--cpus=0.5",
    "--mount", `type=bind,src=${secretFile},dst=/run/secrets/matrix_call_secret,readonly`,
    "--env", "MATRIX_CALL_HOST=0.0.0.0", "--env", "MATRIX_CALL_SECRET_FILE=/run/secrets/matrix_call_secret",
    "--publish", "127.0.0.1::19790", "matrix-call-worker:0.1.0-alpha.4",
  ]);
  container = result.stdout.trim();
  const { stdout } = await exec("docker", ["port", container, "19790/tcp"]);
  const endpoint = `http://${stdout.trim()}`;
  let response;
  const deadline = Date.now() + 10_000;
  while (!response) {
    try { response = await fetch(`${endpoint}/healthz`, { signal: AbortSignal.timeout(1_000) }); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await setTimeout(100);
    }
  }
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ready, undefined);
  assert.deepEqual(health.transports, []);
  assert.equal((await fetch(`${endpoint}/readyz`)).status, 503);
  const uid = await exec("docker", ["exec", container, "id", "-u"]);
  assert.notEqual(uid.stdout.trim(), "0");
  await exec("docker", ["exec", container, "node", "-e", "try { require.resolve('openclaw'); process.exit(1); } catch { process.exit(0); }"]);
  await exec("docker", ["stop", "--time", "5", container]);
  const state = await exec("docker", ["inspect", "--format", "{{json .State}}", container]);
  const stopped = JSON.parse(state.stdout);
  assert.equal(stopped.ExitCode, 0);
  assert.equal(stopped.OOMKilled, false);
  console.log("Non-root container, health, SDK independence, and graceful shutdown verified.");
} finally {
  if (container) await exec("docker", ["rm", "--force", container]);
  await rm(directory, { recursive: true, force: true });
}
