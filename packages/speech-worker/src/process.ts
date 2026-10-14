import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

export class SpeechEngineError extends Error {
  constructor(readonly code: "invalid-engine-request" | "engine-failed" | "engine-output-limit" | "engine-diagnostic-limit") {
    super(code);
    this.name = "SpeechEngineError";
  }
}

export type EngineRequest = Readonly<{ file: string; args: string[]; input: Buffer; maxOutputBytes: number }>;
export type EngineSpawner = (file: string, args: string[], options: {
  shell: false; stdio: "pipe"; env: NodeJS.ProcessEnv;
}) => ChildProcessWithoutNullStreams;

export async function runEngine(request: EngineRequest, signal: AbortSignal, spawnProcess: EngineSpawner = spawn): Promise<Buffer> {
  signal.throwIfAborted();
  if (!isAbsolute(request.file) || request.file.includes("\0") || request.file.length > 4096 ||
      request.args.length > 32 || request.args.some((arg) => arg.includes("\0") || arg.length > 4096) ||
      request.input.length > 320_044 || !Number.isInteger(request.maxOutputBytes) ||
      request.maxOutputBytes < 1 || request.maxOutputBytes > 960_044) {
    throw new SpeechEngineError("invalid-engine-request");
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(request.file, request.args, { shell: false, stdio: "pipe", env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
  } catch {
    throw new SpeechEngineError("engine-failed");
  }
  const input = Buffer.from(request.input);
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failed = false;
    let failure: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: unknown): void => {
      if (failed) return;
      failed = true;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 500);
    };
    const onAbort = () => { fail(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => { fail(new SpeechEngineError("engine-failed")); });
    child.stdin.on("error", () => { fail(new SpeechEngineError("engine-failed")); });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.maxOutputBytes) fail(new SpeechEngineError("engine-output-limit"));
      if (!failed) chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65_536) fail(new SpeechEngineError("engine-diagnostic-limit"));
    });
    child.once("close", (code, termination) => {
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      input.fill(0);
      if (failed) reject(failure);
      else if (code !== 0 || termination !== null) reject(new SpeechEngineError("engine-failed"));
      else resolve(Buffer.concat(chunks));
      for (const chunk of chunks) chunk.fill(0);
    });
    if (signal.aborted) onAbort();
    child.stdin.end(input);
  });
}
