import type { AddressInfo } from "node:net";
import { startBrowserWorker } from "./app.js";

export const worker = await startBrowserWorker();
console.info(JSON.stringify({ event: "browser-worker-started", ready: false, voiceEnabled: Boolean(worker.voice), port: (worker.server.address() as AddressInfo).port }));
