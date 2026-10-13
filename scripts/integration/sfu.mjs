import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const image = "livekit/livekit-server:v1.13.9@sha256:d0c04791bf63ca8dcea123571827d56ba9504bd57c8d5de60ee03b5408cc3154";

async function freePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

export async function startTestSfu(directory, { autoCreate = true } = {}) {
  const container = `matrix-call-sfu-${randomUUID()}`;
  const apiKey = randomBytes(12).toString("hex");
  const apiSecret = randomBytes(32).toString("hex");
  const roomName = randomUUID();
  const ports = [await freePort(), await freePort(), await freePort()];
  if (new Set(ports).size !== 3) throw new Error("Test ports collided");
  const configFile = path.join(directory, "livekit.yaml");
  await writeFile(configFile, `port: ${ports[0]}\nbind_addresses: [127.0.0.1]\nrtc:\n  node_ip: 127.0.0.1\n  tcp_port: ${ports[1]}\n  udp_port: ${ports[2]}\n  use_external_ip: false\n  enable_loopback_candidate: true\n  interfaces:\n    includes: [lo]\nkeys:\n  ${apiKey}: ${apiSecret}\nroom:\n  auto_create: ${autoCreate}\nlogging:\n  level: error\n`, { mode: 0o644 });
  execFileSync("docker", ["run", "--detach", "--rm", "--name", container, "--network", "host", "--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--pids-limit", "128", "--mount", `type=bind,source=${configFile},target=/test/livekit.yaml,readonly`, image, "--config", "/test/livekit.yaml"], { stdio: "pipe" });
  const close = () => execFileSync("docker", ["rm", "--force", container], { stdio: "pipe" });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${ports[0]}/`, { signal: AbortSignal.timeout(500) })).ok) {
          return {
            url: `ws://127.0.0.1:${ports[0]}`,
            authorizationCredentials: { key: apiKey, secret: apiSecret },
            token(identity) {
              const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
              const timestamp = Math.floor(Date.now() / 1000);
              const message = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: apiKey, sub: identity, nbf: timestamp - 5, exp: timestamp + 300, video: { room: roomName, roomJoin: true, canPublish: true, canSubscribe: true } })}`;
              return `${message}.${createHmac("sha256", apiSecret).update(message).digest("base64url")}`;
            },
            close,
          };
        }
      } catch {}
      await delay(100);
    }
    throw new Error("Timed out: isolated SFU startup");
  } catch (error) {
    close();
    throw error;
  }
}
