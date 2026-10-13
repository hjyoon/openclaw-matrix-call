import { startWorker } from "./app.js";
import type { AddressInfo } from "node:net";

export const worker = await startWorker();
console.info(JSON.stringify({
  event: "worker-started", ready: false, port: (worker.server.address() as AddressInfo).port,
}));
