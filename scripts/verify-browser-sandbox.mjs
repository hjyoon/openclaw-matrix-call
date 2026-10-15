import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const image = process.env.MATRIX_CALL_BROWSER_IMAGE ?? "matrix-call-browser-worker:0.1.0-alpha.2";
const probe = `
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
assert.notEqual(process.getuid(), 0);
const context = await chromium.launchPersistentContext("/data/probe", { headless: true, channel: "chromium", chromiumSandbox: true });
try {
  const page = await context.newPage();
  await page.goto("chrome://sandbox");
  const status = await page.locator("body").innerText();
  assert.match(status, /Layer 1 Sandbox\\s+Namespace/);
  assert.match(status, /PID namespaces\\s+Yes/);
  assert.match(status, /Network namespaces\\s+Yes/);
  assert.match(status, /Seccomp-BPF sandbox\\s+Yes/);
  console.log(JSON.stringify({ browser: context.browser().version(), namespaces: true, seccomp: true, nonRoot: true }));
} finally { await context.close(); }
`;
const result = execFileSync("docker", ["run", "--rm", "--init", "--user", `${process.getuid()}:${process.getgid()}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${path.join(root, "deployment/browser-seccomp.json")}`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--tmpfs", `/data:rw,nosuid,nodev,size=256m,uid=${process.getuid()},gid=${process.getgid()},mode=0700`, "--memory", "768m", "--pids-limit", "256", image, "node", "--input-type=module", "-e", probe], { encoding: "utf8", timeout: 30_000 });
const evidence = JSON.parse(result);
assert(evidence.nonRoot && evidence.namespaces && evidence.seccomp);
console.log(JSON.stringify(evidence));
