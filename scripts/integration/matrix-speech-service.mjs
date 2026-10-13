import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { prepareSpeechModel } from "./speech-model.mjs";

const exec = promisify(execFile);

export async function startMatrixSpeechService(root, directory, image) {
  assert(process.getuid() !== 0, "Speech integration requires a non-root user");
  const model = await prepareSpeechModel(root, "base");
  const data = path.join(directory, "matrix-speech");
  await mkdir(data, { mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  let container;
  try {
    const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = JSON.parse(await readFile(path.join(root, "deployment/speech-config.example.json"), "utf8"));
    config.port = port;
    config.whisper.model = { ...model, file: "/models/model.bin" };
    const secretFile = path.join(data, "secret"); const configFile = path.join(data, "speech.json");
    await writeFile(secretFile, secret, { mode: 0o600 });
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    const mount = (source, target) => ["--mount", `type=bind,src=${source},dst=${target},readonly`];
    const result = await exec("docker", ["run", "--detach", "--init", "--user", `${process.getuid()}:${process.getgid()}`, "--network", "host",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=128", "--memory=1536m", "--memory-swap=1536m", "--cpus=2",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777", ...mount(secretFile, "/run/secrets/voice_speech_secret"),
      ...mount(configFile, "/run/config/speech.json"), ...mount(model.file, "/models/model.bin"), image]);
    container = result.stdout.trim();
    const deadline = Date.now() + 15_000;
    for (;;) {
      try { if ((await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) })).ok) break; }
      catch {}
      const state = JSON.parse((await exec("docker", ["inspect", "--format", "{{json .State}}", container])).stdout);
      assert(state.Running, "Matrix speech service exited during startup");
      assert(Date.now() < deadline, "Matrix speech service startup deadline exceeded");
      await delay(100);
    }
    const health = await (await fetch(`${baseUrl}/healthz`)).json();
    assert.equal(health.ready, false);
    assert.equal((await fetch(`${baseUrl}/syntheses`, { method: "POST", body: "{}" })).status, 401);
    assert.notEqual((await exec("docker", ["exec", container, "id", "-u"])).stdout.trim(), "0");
    const imageId = (await exec("docker", ["image", "inspect", "--format", "{{.Id}}", image])).stdout.trim();
    return {
      baseUrl, secret, model: "base", modelSha256: model.sha256, imageId,
      async engineCount() {
        const source = "const fs=require('node:fs');console.log(fs.readdirSync('/proc').filter(p=>{if(!/^\\d+$/.test(p))return false;try{return fs.readFileSync('/proc/'+p+'/comm','utf8').trim()==='whisper-cli'}catch{return false}}).length)";
        return Number((await exec("docker", ["exec", container, "node", "-e", source])).stdout.trim());
      },
      async inputRemoved() {
        const source = "const fs=require('node:fs');console.log(!fs.readdirSync('/tmp').some(p=>p.startsWith('matrix-call-speech-')))";
        return (await exec("docker", ["exec", container, "node", "-e", source])).stdout.trim() === "true";
      },
      async close() {
        try {
          await exec("docker", ["stop", "--time", "5", container]);
          const state = JSON.parse((await exec("docker", ["inspect", "--format", "{{json .State}}", container])).stdout);
          assert.equal(state.ExitCode, 0); assert.equal(state.OOMKilled, false);
          const logs = await exec("docker", ["logs", container]);
          assert(!logs.stdout.includes(secret) && !logs.stderr.includes(secret), "Speech service leaked its secret");
        } finally {
          await exec("docker", ["rm", "--force", container]);
          await rm(data, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (container) await exec("docker", ["rm", "--force", container]);
    await rm(data, { recursive: true, force: true });
    throw error;
  }
}
