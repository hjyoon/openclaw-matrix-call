import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { startTestSfu } from "./integration/sfu.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, ".cache/browsers");
const { chromium } = await import("playwright-core");
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-media-"));
let browser;
let server;
let sfu;

async function waitFor(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function expectTone(page, identity, frequency) {
  let measurement;
  try {
    await waitFor(async () => {
      measurement = await page.evaluate((id) => window.mediaTest.measure(id), identity);
      return measurement.encrypted && measurement.rms > 0.03 && Math.abs(measurement.frequency - frequency) < 35;
    }, `encrypted ${frequency} Hz audio`);
  } catch {
    const diagnostics = await page.evaluate(() => window.mediaTest.diagnostics());
    throw new Error(`Encrypted tone unavailable: ${JSON.stringify({ measurement, diagnostics })}`);
  }
}

try {
  sfu = await startTestSfu(directory);
  const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/integration/livekit-browser.js"], bundle: true, platform: "browser", format: "esm", target: "es2023", write: false, legalComments: "none", logLevel: "silent" });
  const worker = await readFile(fileURLToPath(import.meta.resolve("livekit-client/e2ee-worker")));
  server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); }
    else if (request.url === "/e2ee-worker.js") { response.setHeader("Content-Type", "text/javascript"); response.end(worker); }
    else { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><script type="module" src="/fixture.js"></script>'); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const alice = await browser.newPage();
  const bob = await browser.newPage();
  for (const page of [alice, bob]) {
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.mediaTest));
  }
  const aliceKey = [...randomBytes(16)];
  const bobKey = [...randomBytes(16)];
  const sfuUrl = sfu.url;
  for (const page of [alice, bob]) {
    await page.evaluate(async ({ aliceKey, bobKey }) => {
      await window.mediaTest.key("alice", aliceKey, 0);
      await window.mediaTest.key("bob", bobKey, 0);
    }, { aliceKey, bobKey });
  }
  await alice.evaluate(({ url, token }) => window.mediaTest.connect(url, token, "alice"), { url: sfuUrl, token: sfu.token("alice") });
  await bob.evaluate(({ url, token }) => window.mediaTest.connect(url, token, "bob"), { url: sfuUrl, token: sfu.token("bob") });
  await alice.evaluate(() => window.mediaTest.publish(440));
  await bob.evaluate(() => window.mediaTest.publish(660));
  await expectTone(bob, "alice", 440);
  await expectTone(alice, "bob", 660);
  const packetsBefore = await bob.evaluate(() => window.mediaTest.inboundPackets("alice"));
  await bob.evaluate((key) => window.mediaTest.key("alice", key, 0), [...randomBytes(16)]);
  await delay(1500);
  const wrongKey = await bob.evaluate(() => window.mediaTest.measure("alice"));
  assert(wrongKey.rms < 0.001, "Wrong-key audio must remain undecodable");
  assert(await bob.evaluate(() => window.mediaTest.inboundPackets("alice")) > packetsBefore, "Wrong-key test must still receive RTP packets");
  await bob.evaluate((key) => window.mediaTest.key("alice", key, 0), aliceKey);
  await expectTone(bob, "alice", 440);
  const rotated = [...randomBytes(16)];
  await bob.evaluate((key) => window.mediaTest.key("alice", key, 1), rotated);
  await alice.evaluate((key) => window.mediaTest.key("alice", key, 1), rotated);
  await expectTone(bob, "alice", 440);
  await expectTone(alice, "bob", 660);
  const result = { browser: browser.version(), livekit: "1.13.9", sdk: "2.22.4", bidirectionalAudio: true, wrongKeyRejected: true, keyRotation: true, matrixSignaling: false };
  await alice.evaluate(() => window.mediaTest.close());
  await bob.evaluate(() => window.mediaTest.close());
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
  sfu?.close();
  await rm(directory, { recursive: true, force: true });
}
