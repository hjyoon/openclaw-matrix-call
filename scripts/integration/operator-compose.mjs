import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}

export async function createOperatorComposition({ root, directory, model, secret, speechPort }) {
  await mkdir(directory, { mode: 0o700 });
  const controlPort = await freePort(); const project = `matrix-call-operator-${randomUUID().slice(0, 8)}`;
  for (const name of ["browser.json", "voice.json", "matrix.json"]) await writeFile(path.join(directory, name), "{}", { mode: 0o600 });
  for (const name of ["agent.secret", "control.secret"]) await writeFile(path.join(directory, name), randomBytes(32).toString("hex"), { mode: 0o600 });
  await writeFile(path.join(directory, "speech.secret"), secret, { mode: 0o600 });
  const config = JSON.parse(await readFile(path.join(root, "deployment/speech-config.example.json"), "utf8"));
  config.port = speechPort; config.whisper.model = { ...model, file: "/models/model.bin" };
  await writeFile(path.join(directory, "speech.json"), JSON.stringify(config), { mode: 0o600 });
  const override = path.join(directory, "operator-test.compose.json");
  await writeFile(override, JSON.stringify({ services: {
    "browser-worker": { user: `${process.getuid()}:${process.getgid()}`, volumes: [`${directory}:/data`],
      command: ["node", "--import", "/data/probe.mjs", "/app/worker.mjs"] },
    "speech-worker": { user: `${process.getuid()}:${process.getgid()}` },
  } }), { mode: 0o600 });
  const args = ["compose", "--project-name", project, ...["browser-compose.yml", "browser-voice.compose.yml", "browser-local-speech.compose.yml", "browser-local-gateway.compose.yml"]
    .flatMap((name) => ["-f", path.join(root, "deployment", name)]), "-f", override];
  const env = { ...process.env, MATRIX_CALL_CONTROL_PORT: String(controlPort), MATRIX_CALL_SPEECH_PORT: String(speechPort),
    MATRIX_CALL_BROWSER_CONFIG: path.join(directory, "browser.json"), MATRIX_CALL_MATRIX_CREDENTIALS: path.join(directory, "matrix.json"),
    MATRIX_CALL_SECRET_FILE: path.join(directory, "control.secret"), MATRIX_CALL_VOICE_CONFIG: path.join(directory, "voice.json"),
    MATRIX_CALL_VOICE_AGENT_SECRET: path.join(directory, "agent.secret"), MATRIX_CALL_VOICE_SPEECH_SECRET: path.join(directory, "speech.secret"),
    MATRIX_CALL_SPEECH_CONFIG: path.join(directory, "speech.json"), MATRIX_CALL_SPEECH_MODEL: model.file };
  const run = (command) => exec("docker", [...args, ...command], { cwd: root, env, timeout: 120000, maxBuffer: 2_000_000 });
  const rendered = JSON.parse((await run(["config", "--format", "json"])).stdout).services;
  for (const service of Object.values(rendered)) {
    assert.equal(service.network_mode, "host"); assert.equal(service.read_only, true); assert.deepEqual(service.cap_drop, ["ALL"]);
    assert(!service.privileged && !service.pid && !service.ipc);
    assert.equal((service.ports ?? []).length, 0);
    assert.equal(service.user, `${process.getuid()}:${process.getgid()}`);
    assert(!service.volumes.some((volume) => volume.target.includes("docker.sock")));
  }
  assert.equal(rendered["browser-worker"].environment.MATRIX_CALL_HOST, "127.0.0.1");
  assert.equal(rendered["browser-worker"].volumes.length, 1);
  assert.equal(rendered["browser-worker"].volumes[0].source, directory);
  assert.equal(rendered["speech-worker"].volumes.length, 1);
  assert.equal(rendered["speech-worker"].volumes[0].read_only, true);
  assert.deepEqual(rendered["speech-worker"].secrets.map((value) => value.source), ["voice_speech_secret"]);
  const id = async (service) => (await run(["ps", "--all", "--quiet", service])).stdout.trim();
  const stop = async (service) => {
    const container = await id(service); assert(container);
    await run(["stop", "--timeout", "15", service]);
    const state = JSON.parse((await exec("docker", ["inspect", "--format", "{{json .State}}", container])).stdout);
    assert.equal(state.ExitCode, 0); assert.equal(state.OOMKilled, false);
  };
  return {
    directory, controlPort, secretFile: env.MATRIX_CALL_VOICE_SPEECH_SECRET, speechConfig: env.MATRIX_CALL_SPEECH_CONFIG,
    startSpeech: async () => { await run(["up", "--detach", "--no-build", "--wait", "--wait-timeout", "30", "speech-worker"]); return id("speech-worker"); },
    startBrowser: async () => { await run(["up", "--detach", "--no-build", "--wait", "--wait-timeout", "60", "browser-worker"]); return id("browser-worker"); },
    stopBrowser: async () => { await stop("browser-worker"); await run(["rm", "--force", "browser-worker"]); },
    restartSpeech: async () => { await stop("speech-worker"); await run(["rm", "--force", "speech-worker"]); await run(["up", "--detach", "--no-build", "--wait", "--wait-timeout", "30", "speech-worker"]); return id("speech-worker"); },
    close: async () => { try { await stop("speech-worker"); } finally { await run(["down", "--volumes", "--remove-orphans", "--timeout", "15"]); } },
  };
}
