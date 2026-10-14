import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function installMatrixMessaging(root, directory, env) {
  const target = path.join(directory, "matrix-messaging");
  await cp(path.join(root, "node_modules/@openclaw/matrix"), target, { recursive: true, dereference: true, force: false, errorOnExist: true });
  assert.equal((await stat(path.join(target, "dist/index.js"))).nlink, 1);
  assert.equal(JSON.parse(await readFile(path.join(target, "package.json"), "utf8")).version, "2026.10.2");
  await exec(path.join(root, "node_modules/.bin/openclaw"), ["plugins", "install", "--link", target, "--force", "--accept-capabilities"],
    { cwd: directory, env, timeout: 60_000 });
}
