import { fileURLToPath } from "node:url";
import { prepareSpeechModel } from "./integration/speech-model.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length > 3) throw new Error("Use: pnpm speech:model [base|small]");
const model = await prepareSpeechModel(root, process.argv[2] ?? "small");
console.log(JSON.stringify(model));
