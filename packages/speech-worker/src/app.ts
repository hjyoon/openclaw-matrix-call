import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { once } from "node:events";
import { readSpeechConfig, verifySpeechModel } from "./config.js";
import { WhisperRecognition, EspeakSynthesis } from "./engines.js";
import { createSpeechServer } from "./server.js";

export async function startSpeechWorker(env: NodeJS.ProcessEnv = process.env) {
  const config = await readSpeechConfig(env);
  await verifySpeechModel(config.whisper.model);
  try {
    for (const binary of [config.whisper.binary, config.espeak.binary]) {
      await access(binary, constants.X_OK);
      if (!(await stat(binary)).isFile()) throw new Error("Not an executable file");
    }
  } catch { throw new Error("Speech engines unavailable"); }
  const secret = (await readFile(config.secretFile, "utf8")).trim();
  const worker = createSpeechServer({
    secret, timeoutMs: config.timeoutMs,
    recognition: new WhisperRecognition({ ...config.whisper, model: config.whisper.model.file, temporaryDir: config.temporaryDir }),
    synthesis: new EspeakSynthesis(config.espeak),
  });
  const listening = once(worker.server, "listening");
  worker.server.listen(config.port, config.host);
  await listening;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    closing = worker.close();
    return closing;
  };
  const onSignal = (): void => { void close(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return Object.freeze({ server: worker.server, audience: worker.audience, close });
}
