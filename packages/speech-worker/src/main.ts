import type { AddressInfo } from "node:net";
import { startSpeechWorker } from "./app.js";

export const worker = await startSpeechWorker();
console.info(JSON.stringify({
  event: "speech-worker-started", ready: false, recognition: true, synthesis: true,
  port: (worker.server.address() as AddressInfo).port,
}));
