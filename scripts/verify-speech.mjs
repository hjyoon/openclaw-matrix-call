import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { prepareSpeechModel } from "./integration/speech-model.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const modelName = process.env.MATRIX_CALL_SPEECH_TEST_MODEL ?? "base";
const model = await prepareSpeechModel(root, modelName);
const directory = await mkdtemp(path.join(tmpdir(), "matrix-call-speech-check-"));
const secretFile = path.join(directory, "secret");
const configFile = path.join(directory, "speech.json");
const secret = randomBytes(32).toString("hex");
const image = "matrix-call-speech-worker:0.1.0-alpha.1";
let container;
try {
  await writeFile(secretFile, secret, { mode: 0o444 });
  const config = JSON.parse(await readFile(path.join(root, "deployment/speech-config.example.json"), "utf8"));
  config.whisper.model = { ...model, file: "/models/model.bin" };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o444 });
  const mount = (source, target) => ["--mount", `type=bind,src=${source},dst=${target},readonly`];
  const result = await exec("docker", ["run", "--detach", "--init", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--pids-limit=128", "--memory=1536m", "--memory-swap=1536m", "--cpus=2", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
    ...mount(secretFile, "/run/secrets/voice_speech_secret"), ...mount(configFile, "/run/config/speech.json"), ...mount(model.file, "/models/model.bin"),
    ...mount(path.join(root, "dist"), "/run/test/dist"), ...mount(path.join(root, "tests/fixtures/speech"), "/run/test/fixtures"),
    ...mount(path.join(root, "scripts/integration/speech-client.mjs"), "/run/test/speech-client.mjs"),
    ...mount(path.join(root, "scripts/integration/voice-services.mjs"), "/run/test/voice-services.mjs"), image]);
  container = result.stdout.trim();
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await exec("docker", ["exec", container, "node", "-e", "fetch('http://127.0.0.1:19792/healthz').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"]);
      break;
    } catch {
      const { stdout } = await exec("docker", ["inspect", "--format", "{{json .State}}", container]);
      assert(JSON.parse(stdout).Running, "Speech worker exited during startup");
      assert(Date.now() < deadline, "Speech worker startup deadline exceeded");
      await setTimeout(100);
    }
  }
  assert.notEqual((await exec("docker", ["exec", container, "id", "-u"])).stdout.trim(), "0");
  await exec("docker", ["run", "--rm", "--network", `container:${container}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--pids-limit=32", "--memory=128m", "--entrypoint", "node", image, "-e",
    "const assert=require('node:assert/strict');const fs=require('node:fs');assert(!fs.existsSync('/models/model.bin'));assert(!fs.existsSync('/run/secrets/voice_speech_secret'));(async()=>{assert.equal((await fetch('http://127.0.0.1:19792/healthz')).status,200);assert.equal((await fetch('http://127.0.0.1:19792/syntheses',{method:'POST',body:'{}'})).status,401)})().catch(()=>process.exit(1));"]);
  await exec("docker", ["exec", container, "node", "-e", "const fs=require('node:fs');for(const p of ['/app/licenses/whisper.txt','/app/licenses/espeak.txt','/app/sources/whisper.tar.gz','/app/sources/espeak.tar.gz','/app/sources/Dockerfile'])fs.accessSync(p);for(const m of ['openclaw','playwright-core','matrix-js-sdk']){try{require.resolve(m);process.exit(1)}catch{}}"]);
  const { stdout } = await exec("docker", ["exec", container, "node", "/run/test/speech-client.mjs"], { timeout: 180_000, maxBuffer: 1_000_000 });
  const evidence = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(evidence.event, "speech-integration-passed");
  await exec("docker", ["stop", "--time", "5", container]);
  const state = JSON.parse((await exec("docker", ["inspect", "--format", "{{json .State}}", container])).stdout);
  assert.equal(state.ExitCode, 0);
  assert.equal(state.OOMKilled, false);
  const imageId = (await exec("docker", ["image", "inspect", "--format", "{{.Id}}", image])).stdout.trim();
  const report = { ...evidence, model: modelName, modelSha256: model.sha256, imageId, constraints: { memoryMiB: 1536, cpus: 2, pids: 128 }, nonRoot: true, readOnly: true, sharedLoopback: true, separateCredentials: true, gracefulShutdown: true };
  await mkdir(path.join(root, ".cache/speech"), { recursive: true });
  await writeFile(path.join(root, `.cache/speech/integration-result-${modelName}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (container) {
    const { stdout, stderr } = await exec("docker", ["logs", container]);
    assert(!stdout.includes(secret) && !stderr.includes(secret), "Speech worker leaked its secret");
    process.stderr.write(stdout + stderr);
  }
  throw error;
} finally {
  if (container) await exec("docker", ["rm", "--force", container]);
  await rm(directory, { recursive: true, force: true });
}
