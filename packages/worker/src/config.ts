import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { CallError } from "@matrix-call/core";

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.MATRIX_CALL_HOST ?? "127.0.0.1";
  const portText = env.MATRIX_CALL_PORT ?? "19790";
  const secretFile = env.MATRIX_CALL_SECRET_FILE;
  if (!isIP(host) || !/^(0|[1-9][0-9]{0,4})$/.test(portText) || Number(portText) > 65_535 ||
    !secretFile || !isAbsolute(secretFile)) {
    throw new CallError("invalid-input");
  }
  return Object.freeze({ host, port: Number(portText), secretFile });
}
