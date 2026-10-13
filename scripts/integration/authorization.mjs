import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const image = "ghcr.io/element-hq/lk-jwt-service:0.8.0@sha256:fe787619877b9c12d4370ed39dc8edecf99b1a71fa8958c0fdcb687c1d31c775";

export async function startTestAuthorization(directory, sfu, serverName) {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const container = `matrix-call-auth-${randomUUID()}`;
  const configFile = path.join(directory, "authorization.env");
  await writeFile(configFile, `LIVEKIT_URL=${sfu.url}\nLIVEKIT_KEY=${sfu.authorizationCredentials.key}\nLIVEKIT_SECRET=${sfu.authorizationCredentials.secret}\nLIVEKIT_FULL_ACCESS_HOMESERVERS=${serverName}\nLIVEKIT_JWT_BIND=127.0.0.1:${port}\nLIVEKIT_LOG_LEVEL=error\nLIVEKIT_INSECURE_SKIP_VERIFY_TLS=YES_I_KNOW_WHAT_I_AM_DOING\n`, { mode: 0o600 });
  execFileSync("docker", ["run", "--detach", "--rm", "--name", container, "--network", "host", "--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", "--pids-limit", "128", "--env-file", configFile, image], { stdio: "pipe" });
  const close = () => execFileSync("docker", ["rm", "--force", container], { stdio: "pipe" });
  const url = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) })).ok) return { url, close }; }
      catch {}
      await delay(100);
    }
    throw new Error("Timed out: authorization service startup");
  } catch (error) { close(); throw error; }
}
