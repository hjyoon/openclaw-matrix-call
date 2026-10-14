import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const image = "ghcr.io/element-hq/synapse:v1.162.0@sha256:6b84a7bbac36f080b2d2e51e0289cf1b08b349598ea44a558df38d558f2c2311";

export async function poll(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}

export async function startTestHomeserver(directory) {
  assert(process.getuid() !== 0, "Matrix integration requires a non-root user");
  await mkdir(directory, { mode: 0o700 });
  const serverName = "matrix-call.test";
  const name = `matrix-call-chat-${randomUUID()}`;
  const uid = `${process.getuid()}:${process.getgid()}`;
  const secret = randomBytes(32).toString("hex");
  let running = false;
  const close = async () => { if (running) { await exec("docker", ["rm", "--force", name]); running = false; } };
  try {
    await exec("docker", ["run", "--rm", "--user", uid, "--env", `SYNAPSE_SERVER_NAME=${serverName}`, "--env", "SYNAPSE_REPORT_STATS=no",
      "--mount", `type=bind,source=${directory},target=/data`, image, "generate"]);
    await writeFile(path.join(directory, "homeserver.yaml"), `server_name: ${serverName}
pid_file: /data/homeserver.pid
report_stats: false
listeners:
  - port: 8008
    type: http
    tls: false
    bind_addresses: [0.0.0.0]
    resources:
      - names: [client]
        compress: false
database:
  name: sqlite3
  args:
    database: /data/homeserver.db
log_config: /data/${serverName}.log.config
signing_key_path: /data/${serverName}.signing.key
media_store_path: /data/media_store
registration_shared_secret: ${secret}
enable_registration: false
trusted_key_servers: []
suppress_key_server_warning: true
rc_message:
  per_second: 100
  burst_count: 1000
`, { mode: 0o600 });
    await exec("docker", ["run", "--detach", "--rm", "--name", name, "--user", uid, "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--memory=768m", "--pids-limit=128", "--publish", "127.0.0.1::8008", "--mount", `type=bind,source=${directory},target=/data`, image]);
    running = true;
    const ports = JSON.parse((await exec("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", name])).stdout);
    const url = `http://127.0.0.1:${ports["8008/tcp"][0].HostPort}`;
    const api = async (route, method = "GET", body, token) => {
      const response = await fetch(url + route, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
      assert(response.ok, `Test Matrix API returned HTTP ${response.status}`);
      return response.json();
    };
    await poll(async () => {
      try { return (await fetch(url + "/_matrix/client/versions", { signal: AbortSignal.timeout(500) })).ok; }
      catch { return false; }
    }, "isolated chat homeserver startup");
    const register = async (username) => {
      const endpoint = "/_synapse/admin/v1/register";
      const { nonce } = await api(endpoint);
      const password = randomBytes(32).toString("hex");
      const mac = createHmac("sha1", secret).update([nonce, username, password, "notadmin"].join("\0")).digest("hex");
      const account = await api(endpoint, "POST", { nonce, username, password, admin: false, mac });
      const identity = await api("/_matrix/client/v3/account/whoami", "GET", undefined, account.access_token);
      assert.equal(identity.user_id, account.user_id); assert.equal(identity.device_id, account.device_id);
      return account;
    };
    return { url, api, register, close };
  } catch (error) { await close(); throw error; }
}
