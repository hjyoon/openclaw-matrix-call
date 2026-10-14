import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-worker-artifact-"));
const secretFile = path.join(directory, "secret");
await writeFile(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const child = spawn(process.execPath, [path.join(root, "dist/worker/worker.mjs")], {
  env: { MATRIX_CALL_HOST: "127.0.0.1", MATRIX_CALL_PORT: "0", MATRIX_CALL_SECRET_FILE: secretFile },
  stdio: ["ignore", "pipe", "pipe"],
});
const lines = createInterface({ input: child.stdout });
try {
  const [line] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
  const event = JSON.parse(line);
  assert.equal(event.event, "worker-started");
  assert.equal(event.ready, undefined);
  const response = await fetch(`http://127.0.0.1:${event.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, undefined);
  assert.equal((await fetch(`http://127.0.0.1:${event.port}/readyz`, { signal: AbortSignal.timeout(5_000) })).status, 503);
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  console.log("Standalone worker startup, health, and graceful shutdown verified.");
} finally {
  lines.close();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}
