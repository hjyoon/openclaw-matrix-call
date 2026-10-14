import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const env = { ...process.env };
for (const key of ["BROWSER_CONFIG", "SECRET_FILE", "MATRIX_CREDENTIALS", "VOICE_CONFIG", "VOICE_AGENT_SECRET", "VOICE_SPEECH_SECRET", "SPEECH_CONFIG", "SPEECH_MODEL"]) {
  env[`MATRIX_CALL_${key}`] = `/not-provisioned/${key.toLowerCase()}`;
}
env.MATRIX_CALL_CONTROL_PORT = "19790";
const { stdout } = await exec("docker", ["compose", "-f", path.join(root, "deployment/browser-compose.yml"),
  "-f", path.join(root, "deployment/browser-voice.compose.yml"), "-f", path.join(root, "deployment/browser-local-speech.compose.yml"), "config", "--format", "json"], { env });
const { services } = JSON.parse(stdout);
const browser = services["browser-worker"];
const speech = services["speech-worker"];
assert.equal(browser.network_mode, "service:speech-worker");
assert.equal((browser.ports ?? []).length, 0);
assert.equal(browser.depends_on["speech-worker"].condition, "service_healthy");
assert.equal(browser.depends_on["speech-worker"].restart, true);
assert.equal(speech.ports.length, 1);
assert.equal(speech.ports[0].host_ip, "127.0.0.1");
assert.equal(speech.ports[0].target, 19790);
assert.equal(speech.ports[0].published, "19790");
assert(!speech.network_mode);
for (const service of [browser, speech]) {
  assert.equal(service.read_only, true);
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert(service.security_opt.includes("no-new-privileges:true"));
  assert(!service.pid && !service.ipc && !service.privileged);
}
assert.equal(speech.cpus, 2);
assert.equal(speech.pids_limit, 128);
assert.equal(Number(speech.mem_limit), 1536 * 1024 * 1024);
assert.equal(Number(speech.memswap_limit), Number(speech.mem_limit));
assert(speech.tmpfs[0].includes("noexec,nosuid,nodev,size=16m"));
assert.deepEqual(speech.secrets.map((secret) => secret.source), ["voice_speech_secret"]);
assert.equal(speech.volumes.length, 1);
assert.equal(speech.volumes[0].target, "/models/model.bin");
assert.equal(speech.volumes[0].read_only, true);
assert.equal(speech.volumes[0].bind?.create_host_path ?? false, false);
console.log("Local speech Compose namespace, credential separation and resource limits verified.");

const local = JSON.parse((await exec("docker", ["compose", "-f", path.join(root, "deployment/browser-compose.yml"),
  "-f", path.join(root, "deployment/browser-voice.compose.yml"), "-f", path.join(root, "deployment/browser-local-speech.compose.yml"),
  "-f", path.join(root, "deployment/browser-local-gateway.compose.yml"), "config", "--format", "json"],
{ env: { ...env, MATRIX_CALL_CONTROL_PORT: "29890", MATRIX_CALL_SPEECH_PORT: "29892" } })).stdout).services;
for (const service of Object.values(local)) {
  assert.equal(service.network_mode, "host"); assert.equal((service.ports ?? []).length, 0);
  assert.equal(service.read_only, true); assert.deepEqual(service.cap_drop, ["ALL"]);
  assert(!service.pid && !service.ipc && !service.privileged);
}
assert.equal(local["browser-worker"].environment.MATRIX_CALL_HOST, "127.0.0.1");
assert.equal(local["browser-worker"].environment.MATRIX_CALL_PORT, "29890");
assert.equal(local["speech-worker"].environment.MATRIX_CALL_SPEECH_PORT, "29892");
assert.equal(local["browser-worker"].depends_on["speech-worker"].condition, "service_healthy");
assert.deepEqual(local["speech-worker"].secrets, speech.secrets);
assert.deepEqual(local["speech-worker"].volumes, speech.volumes);
assert.equal(local["browser-worker"].mem_limit, browser.mem_limit);
assert.equal(local["speech-worker"].mem_limit, speech.mem_limit);
console.log("Local Gateway Compose loopback listeners, separate mounts and unchanged resource limits verified.");
