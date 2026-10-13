import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { RequestAuthenticator } from "@matrix-call/core";
import { startWorker, readWorkerConfig, WorkerMediaController } from "../../worker/src/index.js";
import { readBrowserConfig } from "./config.js";
import { BrowserDriver } from "./driver.js";

export async function startBrowserWorker(env: NodeJS.ProcessEnv = process.env) {
  const workerConfig = readWorkerConfig(env);
  new RequestAuthenticator({ secret: (await readFile(workerConfig.secretFile, "utf8")).trim(), audience: randomUUID() });
  const config = await readBrowserConfig(env.MATRIX_CALL_BROWSER_CONFIG ?? "");
  const driver = await BrowserDriver.start(config);
  const media = new WorkerMediaController({ rooms: config.policy.rooms, transport: driver });
  try {
    const worker = await startWorker(env, media, () => driver.close());
    driver.onEnded(() => driver.available ? media.endSession() : media.shutdown());
    return Object.freeze({ ...worker, driver, media });
  } catch (error) { await driver.close(); throw error; }
}
