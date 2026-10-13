import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { readWorkerConfig } from "./config.js";
import { createWorkerServer } from "./server.js";
import type { WorkerMediaController } from "./media.js";

export async function startWorker(env: NodeJS.ProcessEnv = process.env, media?: WorkerMediaController) {
  const config = readWorkerConfig(env);
  const secret = (await readFile(config.secretFile, "utf8")).trim();
  const { server, audience } = createWorkerServer(secret, media);
  const listening = once(server, "listening");
  server.listen(config.port, config.host);
  await listening;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    server.closeAllConnections();
    closing = new Promise<void>((resolve) => { server.close(() => resolve()); }).then(() => media?.shutdown());
    return closing;
  };
  const onSignal = (): void => { void close(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return Object.freeze({ server, audience, close });
}
