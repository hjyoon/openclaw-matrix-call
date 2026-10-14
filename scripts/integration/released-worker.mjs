import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { startBrowserWorker } from "../../dist/browser-worker/index.js";
import { installRuntimeProbe } from "./browser-diagnostics.mjs";

const exec = promisify(execFile);

export async function startReleasedWorker({ root, data, configFile, controlSecretFile, port, waitFor, composition }) {
  const image = process.env.MATRIX_CALL_RELEASED_BROWSER_IMAGE;
  if (!image) {
    const worker = await startBrowserWorker({ MATRIX_CALL_SECRET_FILE: controlSecretFile, MATRIX_CALL_PORT: String(port), MATRIX_CALL_BROWSER_CONFIG: configFile });
    return { ...worker, evidence: { mode: "native" }, waitForPlayback: () => waitFor(() => !worker.voice.busy, "released-client playback completion"),
      diagnostics: async () => ({ driverAvailable: worker.driver.available, voiceBusy: worker.voice.busy }), verifySandbox: async () => {} };
  }
  const directory = composition?.directory ?? path.join(data, "worker-container"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const config = JSON.parse(await readFile(configFile, "utf8")); const voice = JSON.parse(await readFile(config.voiceFile, "utf8"));
  for (const [source, name] of [[config.credentialsFile, "matrix.json"], [controlSecretFile, "control.secret"], [voice.agent.secretFile, "agent.secret"], [voice.speech.secretFile, "speech.secret"]]) {
    await copyFile(source, path.join(directory, name));
  }
  await writeFile(path.join(directory, "voice.json"), JSON.stringify({ ...voice,
    agent: { ...voice.agent, secretFile: composition ? "/run/secrets/voice_agent_secret" : "/data/agent.secret" },
    speech: { ...voice.speech, secretFile: composition ? "/run/secrets/voice_speech_secret" : "/data/speech.secret" } }), { mode: 0o600 });
  await writeFile(path.join(directory, "browser.json"), JSON.stringify({ ...config, credentialsFile: composition ? "/run/secrets/matrix.json" : "/data/matrix.json", profileDir: "/data/profile",
    assetDir: "/app/assets", voiceFile: composition ? "/run/config/voice.json" : "/data/voice.json" }), { mode: 0o600 });
  const preload = `import { chromium } from "/app/node_modules/playwright-core/index.mjs";
import { readFile, writeFile, rename } from "node:fs/promises";
const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (...args) => {
  const context = await launch(...args);
  await context.addInitScript(${installRuntimeProbe.toString()});
  context.on("page", (page) => {
    let pending = false; let nonce;
    const timer = setInterval(async () => {
      if (pending) return; pending = true;
      try {
        const state = await page.evaluate(() => window.matrixRuntimeProbe ?? null);
        await writeFile("/data/state.json.tmp", JSON.stringify(state), { mode: 0o600 });
        await rename("/data/state.json.tmp", "/data/state.json");
        const request = JSON.parse(await readFile("/data/verify.json", "utf8"));
        if (request.nonce === nonce) return;
        nonce = request.nonce;
        const result = await page.evaluate(async (reference) => {
          try { return { proof: await window.matrixCall.verify(reference, AbortSignal.timeout(3000)) }; }
          catch { return { error: "unavailable" }; }
        }, request.reference);
        await writeFile("/data/proof.json.tmp", JSON.stringify({ nonce, ...result }), { mode: 0o600 });
        await rename("/data/proof.json.tmp", "/data/proof.json");
      } catch {} finally { pending = false; }
    }, 100);
    timer.unref(); page.on("close", () => clearInterval(timer));
  });
  return context;
};
`;
  await writeFile(path.join(directory, "probe.mjs"), preload, { mode: 0o600 });
  const [metadata] = JSON.parse((await exec("docker", ["image", "inspect", image])).stdout);
  assert.equal(metadata.Config.User, "node"); assert.equal(metadata.Architecture, "amd64");
  assert.equal(metadata.Config.Labels["org.opencontainers.image.source"], "https://github.com/hjyoon/openclaw-matrix-call");
  const report = JSON.parse(await readFile(path.join(root, ".cache/release-images/release-report.json"), "utf8"));
  assert.equal(report.sourceDirty, false); assert.equal(report.preview, false);
  assert.equal(metadata.Id, report.images.find((entry) => entry.role === "browser").imageId);
  assert.equal(metadata.Config.Labels["org.opencontainers.image.revision"], report.sourceCommit);
  assert.equal(metadata.Config.Labels["org.opencontainers.image.version"], report.version);
  let name = `matrix-call-released-${randomUUID()}`;
  const close = async () => {
    if (composition) { await composition.stopBrowser(); return; }
    try {
      await exec("docker", ["stop", "--time", "15", name]);
      const state = JSON.parse((await exec("docker", ["inspect", "--format", "{{json .State}}", name])).stdout);
      assert.equal(state.ExitCode, 0); assert.equal(state.OOMKilled, false);
    } finally { await exec("docker", ["rm", "--force", name]); }
  };
  if (composition) name = await composition.startBrowser();
  else await exec("docker", ["run", "--detach", "--name", name, "--init", "--user", `${process.getuid()}:${process.getgid()}`, "--network", "host",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${path.join(root, "deployment/browser-seccomp.json")}`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--memory", "768m", "--pids-limit", "256", "--mount", `type=bind,source=${directory},target=/data`,
    "--env", "MATRIX_CALL_SECRET_FILE=/data/control.secret", "--env", "MATRIX_CALL_BROWSER_CONFIG=/data/browser.json", "--env", `MATRIX_CALL_PORT=${port}`,
    image, "node", "--import", "/data/probe.mjs", "/app/worker.mjs"]);
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, "released-client browser image startup", 45000);
    const { keys } = JSON.parse(await readFile(path.join(directory, "profile/matrix-call-device.json"), "utf8"));
    const state = async () => JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    return {
      evidence: { mode: composition ? "operator-compose" : "container", imageId: metadata.Id, sourceCommit: metadata.Config.Labels["org.opencontainers.image.revision"] },
      driver: {
        deviceKeys: keys,
        async verify(reference, signal) {
          signal.throwIfAborted(); const nonce = randomUUID();
          await writeFile(path.join(directory, "verify.json.tmp"), JSON.stringify({ nonce, reference }), { mode: 0o600 });
          await rename(path.join(directory, "verify.json.tmp"), path.join(directory, "verify.json"));
          let result;
          await waitFor(async () => {
            signal.throwIfAborted();
            try { result = JSON.parse(await readFile(path.join(directory, "proof.json"), "utf8")); return result.nonce === nonce; }
            catch (error) { if (error.code === "ENOENT") return false; throw error; }
          }, "released-client current image verification", 5000);
          if (!result.proof || !Number.isSafeInteger(result.proof.expiresAtMs) || result.proof.expiresAtMs <= Date.now()) throw new Error("Current image participant is unavailable");
          return result.proof;
        },
      },
      waitForPlayback: (turn) => waitFor(async () => { const value = await state(); return value.resumes >= turn && value.inputs === value.resumes && !value.publishing && !value.failure; }, "released-client image playback completion"),
      async diagnostics() {
        const value = JSON.parse((await exec("docker", ["inspect", "--format", "{{json .State}}", name])).stdout);
        const logs = await exec("docker", ["logs", name]);
        const events = logs.stdout.split("\n").flatMap((line) => {
          try { const entry = JSON.parse(line); return ["browser-voice-failed", "browser-call-failed"].includes(entry.event) ? [{ event: entry.event, reason: entry.reason }] : []; }
          catch { return []; }
        }).slice(-8);
        return { runtime: await state().catch(() => null), running: value.Running, exitCode: value.ExitCode, oomKilled: value.OOMKilled, events };
      },
      async verifySandbox() {
        const probe = await readFile(path.join(root, "scripts/integration/renderer-probe.mjs"), "utf8");
        const value = JSON.parse((await exec("docker", ["exec", name, "node", "--input-type=module", "-e", probe])).stdout);
        assert(value.uid !== 0 && value.renderers.some((renderer) => renderer.namespaces > 1 && renderer.filters >= 2 && renderer.seccomp && renderer.noNewPrivileges));
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
