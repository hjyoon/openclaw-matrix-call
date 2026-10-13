import type { AddressInfo } from "node:net";
import { startBrowserWorker } from "./app.js";

export const worker = await startBrowserWorker();
console.info(JSON.stringify({ event: "browser-worker-started", ready: false, port: (worker.server.address() as AddressInfo).port }));
