import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEngine, type EngineRequest, type EngineSpawner } from "../../packages/speech-worker/src/index.js";

const request: EngineRequest = { file: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], input: Buffer.from("hello 한국어 $() `literal`"), maxOutputBytes: 1024 };

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  const spawn: EngineSpawner = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  return { child, spawn };
}

afterEach(() => { vi.useRealTimers(); });

describe("bounded speech engine processes", () => {
  it("executes without a shell, preserves literal stdin and returns owned output", async () => {
    const output = await runEngine(request, new AbortController().signal);
    expect(output).toEqual(request.input);
    expect(request.input.toString()).toContain("한국어");
  });

  it("does not pass inherited credentials or loader options to the engine", async () => {
    const { child, spawn } = processFixture();
    const result = runEngine(request, new AbortController().signal, spawn);
    expect(spawn).toHaveBeenCalledWith(request.file, request.args, { shell: false, stdio: "pipe", env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    const chunk = Buffer.from("result");
    child.stdout.emit("data", chunk);
    child.emit("close", 0, null);
    expect(await result).toEqual(Buffer.from("result"));
    expect(chunk.toString()).toBe("result");
  });

  it.each([
    { file: "relative" }, { file: "/tmp/\0engine" }, { file: "/" + "a".repeat(4096) },
    { args: Array.from({ length: 33 }, () => "x") }, { args: ["\0"] }, { args: ["x".repeat(4097)] },
    { input: Buffer.alloc(320_045) }, { maxOutputBytes: 0 }, { maxOutputBytes: 960_045 }, { maxOutputBytes: 1.5 },
  ])("rejects unsafe or unbounded process settings %j", async (override) => {
    const { spawn } = processFixture();
    await expect(runEngine({ ...request, ...override }, new AbortController().signal, spawn)).rejects.toThrow("invalid-engine-request");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn for an already cancelled request", async () => {
    const { spawn } = processFixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(runEngine(request, controller.signal, spawn)).rejects.toThrow("cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("redacts synchronous spawn errors and missing executables", async () => {
    const spawn: EngineSpawner = () => { throw new Error("credential detail"); };
    await expect(runEngine(request, new AbortController().signal, spawn)).rejects.toThrow("engine-failed");
    await expect(runEngine({ ...request, file: "/does-not-exist/matrix-call-engine" }, new AbortController().signal)).rejects.toThrow("engine-failed");
  });

  it.each([[1, null], [null, "SIGKILL"]] as const)("rejects non-successful termination (%s, %s)", async (code, termination) => {
    const { child, spawn } = processFixture();
    const result = runEngine(request, new AbortController().signal, spawn);
    child.stdout.emit("data", Buffer.from("sensitive output"));
    child.emit("close", code, termination);
    await expect(result).rejects.toThrow("engine-failed");
  });

  it.each(["error", "stdin"])("terminates after an engine or input stream error (%s)", async (source) => {
    const { child, spawn } = processFixture();
    const result = runEngine(request, new AbortController().signal, spawn);
    const target = source === "stdin" ? child.stdin : child;
    target.emit("error", new Error("private detail"));
    target.emit("error", new Error("second detail"));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.emit("close", 1, null);
    await expect(result).rejects.toThrow("engine-failed");
  });

  it.each(["stdout", "stderr"] as const)("bounds %s and waits for actual process termination", async (stream) => {
    vi.useFakeTimers();
    const { child, spawn } = processFixture();
    const controller = new AbortController();
    const result = runEngine(request, controller.signal, spawn);
    const rejected = expect(result).rejects.toThrow("engine-output-limit");
    child.stdout.emit("data", Buffer.from("partial"));
    child.stderr.emit("data", Buffer.from("diagnostic"));
    child[stream].emit("data", Buffer.alloc(stream === "stdout" ? 1025 : 65_537));
    child.stdout.emit("data", Buffer.from("late output"));
    controller.abort();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(500);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    child.emit("close", null, "SIGKILL");
    await rejected;
  });

  it("handles cancellation during spawn and clears escalation after close", async () => {
    vi.useFakeTimers();
    const { child, spawn } = processFixture();
    const controller = new AbortController();
    const spawning: EngineSpawner = (...args) => { controller.abort(new Error("cancelled")); return spawn(...args); };
    const result = runEngine(request, controller.signal, spawning);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(result).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("kills a running child on cancellation and releases its abort listener", async () => {
    const { child, spawn } = processFixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = runEngine(request, controller.signal, spawn);
    controller.abort(new Error("cancelled"));
    child.emit("close", null, "SIGTERM");
    await expect(result).rejects.toThrow("cancelled");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
