import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { RequestAuthenticator, SynthesisLimitError, type PcmAudio } from "../../packages/core/src/index.js";
import { encodePcm, HttpSpeechAdapter } from "../../packages/speech-http/src/index.js";
import { createSpeechServer } from "../../packages/speech-worker/src/index.js";

const secret = "ab".repeat(32);
const pcm = (): PcmAudio => ({ samples: new Int16Array([100, -100, 0]), sampleRate: 16_000, channels: 1 });
const envelope = () => ({ protocolVersion: 1, requestId: randomUUID() });

async function fixture(options: Partial<Parameters<typeof createSpeechServer>[0]> = {}) {
  const worker = createSpeechServer({ secret, recognition: { transcribe: async () => "Hello 한국어" }, synthesis: { synthesize: async () => pcm() }, ...options });
  worker.server.listen(0, "127.0.0.1");
  await once(worker.server, "listening");
  const baseUrl = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  const auth = new RequestAuthenticator({ secret, audience: worker.audience });
  const post = async (path: string, value: unknown) => {
    const body = JSON.stringify(value);
    const response = await fetch(baseUrl + path, { method: "POST", body, headers: auth.sign({ method: "POST", path, body }) });
    const reply = await response.text();
    auth.verify({ method: `RESPONSE_${response.status}`, path, body: reply }, Object.fromEntries(response.headers));
    return { status: response.status, body: JSON.parse(reply) };
  };
  return { ...worker, baseUrl, auth, post };
}

function abortable(signal: AbortSignal, started: () => void): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started();
  });
}

describe("authenticated portable speech service", () => {
  it("returns a signed request-bound limit only for synthesis and permits a smaller subsequent request", async () => {
    const synthesize = vi.fn(async () => pcm()).mockRejectedValueOnce(new SynthesisLimitError());
    const worker = await fixture({ synthesis: { synthesize }, recognition: { transcribe: async () => { throw new SynthesisLimitError(); } } });
    try {
      const request = { ...envelope(), text: "Too long" };
      expect(await worker.post("/syntheses", request)).toEqual({ status: 422, body: { ...envelope(), requestId: request.requestId, error: "synthesis-too-long" } });
      const adapter = await HttpSpeechAdapter.connect({ baseUrl: worker.baseUrl, secret, allowInsecureLoopback: true });
      expect(await adapter.synthesize("Short", new AbortController().signal)).toEqual(pcm());
      expect((await worker.post("/transcriptions", { ...envelope(), audio: encodePcm(pcm()) })).status).toBe(503);
    } finally { await worker.close(); }
  });

  it("keeps a late synthesis limit as a timeout rather than inviting another generation", async () => {
    const worker = await fixture({ timeoutMs: 15, synthesis: { synthesize: async (_text, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new SynthesisLimitError();
    } } });
    try { expect((await worker.post("/syntheses", { ...envelope(), text: "Long" })).status).toBe(504); }
    finally { await worker.close(); }
  });
  it("serves signed capabilities compatible with the existing HTTP speech adapter", async () => {
    const input = pcm();
    const synthesized = pcm();
    let recognized: PcmAudio | undefined;
    const worker = await fixture({ recognition: { transcribe: async (audio) => { recognized = audio; return "  Hello 한국어  "; } }, synthesis: { synthesize: async () => synthesized } });
    try {
      const adapter = await HttpSpeechAdapter.connect({ baseUrl: worker.baseUrl, secret, allowInsecureLoopback: true });
      expect(await adapter.transcribe(input, new AbortController().signal)).toBe("Hello 한국어");
      const output = await adapter.synthesize("Hello", new AbortController().signal);
      expect(output).toEqual(input);
      expect(input.samples[0]).toBe(100);
      expect(recognized!.samples.every((sample) => sample === 0)).toBe(true);
      expect(synthesized.samples.every((sample) => sample === 0)).toBe(true);
      const health = await fetch(worker.baseUrl + "/healthz");
      expect(await health.json()).toEqual({ protocolVersion: 1, audience: worker.audience, ready: false, status: "development" });
      expect(health.headers.get("cache-control")).toBe("no-store");
      expect(worker.server.maxConnections).toBe(16);
    } finally { await worker.close(); }
  });

  it.each([["GET", "/transcriptions"], ["GET", "/unknown"], ["POST", "/unknown"], ["POST", "/capabilities"], ["POST", "/syntheses?other=true"]])("rejects an unsupported route %s %s", async (method, path) => {
    const worker = await fixture();
    try { expect((await fetch(worker.baseUrl + path, { method })).status).toBe(404); }
    finally { await worker.close(); }
  });

  it("rejects unsigned, modified and replayed requests before running any engine", async () => {
    const run = vi.fn(async () => "Hello");
    const worker = await fixture({ recognition: { transcribe: run } });
    try {
      const path = "/transcriptions";
      const body = JSON.stringify({ ...envelope(), audio: encodePcm(pcm()) });
      expect((await fetch(worker.baseUrl + path, { method: "POST", body })).status).toBe(401);
      const headers = worker.auth.sign({ method: "POST", path, body });
      expect((await fetch(worker.baseUrl + path, { method: "POST", body: body + " ", headers })).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
      expect((await fetch(worker.baseUrl + path, { method: "POST", body, headers })).status).toBe(200);
      expect((await fetch(worker.baseUrl + path, { method: "POST", body, headers })).status).toBe(401);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { await worker.close(); }
  });

  it.each([
    ["/transcriptions", {}], ["/syntheses", { ...envelope(), text: " " }],
    ["/transcriptions", { ...envelope(), audio: { ...encodePcm(pcm()), channels: 2 } }],
    ["/syntheses", { ...envelope(), text: "Hello", binary: "/untrusted" }],
  ])("strictly validates authenticated input for %s", async (path, value) => {
    const worker = await fixture();
    try { expect(await worker.post(path as string, value)).toEqual({ status: 400, body: { error: "invalid-request" } }); }
    finally { await worker.close(); }
  });

  it("rejects malformed signed JSON and malformed UTF-8 without exposing input", async () => {
    const worker = await fixture();
    try {
      const path = "/syntheses";
      const body = "{private malformed json";
      const response = await fetch(worker.baseUrl + path, { method: "POST", body, headers: worker.auth.sign({ method: "POST", path, body }) });
      const reply = await response.text();
      expect(response.status).toBe(400);
      worker.auth.verify({ method: "RESPONSE_400", path, body: reply }, Object.fromEntries(response.headers));
      expect(JSON.parse(reply)).toEqual({ error: "invalid-request" });
      const invalid = await fetch(worker.baseUrl + path, { method: "POST", body: Buffer.from([0xff]) });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "invalid-request-body" });
    } finally { await worker.close(); }
  });

  it("bounds raw request bytes before authentication and schema decoding", async () => {
    const worker = await fixture();
    try {
      const response = await fetch(worker.baseUrl + "/transcriptions", { method: "POST", body: "x".repeat(1_300_001) });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "invalid-request-body" });
    } finally { await worker.close(); }
  });

  it.each(["recognition", "synthesis"] as const)("redacts %s failures and releases the operation slot", async (kind) => {
    const worker = await fixture({
      recognition: { transcribe: async () => { throw new Error("private transcript credential"); } },
      synthesis: { synthesize: async () => { throw new Error("private text credential"); } },
    });
    try {
      const value = kind === "recognition" ? { ...envelope(), audio: encodePcm(pcm()) } : { ...envelope(), text: "Hello" };
      const path = kind === "recognition" ? "/transcriptions" : "/syntheses";
      expect(await worker.post(path, value)).toEqual({ status: 503, body: { error: "speech-failed" } });
      expect(await worker.post(path, value)).toEqual({ status: 503, body: { error: "speech-failed" } });
    } finally { await worker.close(); }
  });

  it("rejects invalid engine results and wipes PCM after a format failure", async () => {
    const invalid = { ...pcm(), sampleRate: 0 };
    const worker = await fixture({ recognition: { transcribe: async () => "x".repeat(16001) }, synthesis: { synthesize: async () => invalid } });
    try {
      expect((await worker.post("/transcriptions", { ...envelope(), audio: encodePcm(pcm()) })).status).toBe(503);
      expect((await worker.post("/syntheses", { ...envelope(), text: "Hello" })).status).toBe(503);
      expect(invalid.samples.every((sample) => sample === 0)).toBe(true);
    } finally { await worker.close(); }
  });

  it("rejects concurrent work without queueing another engine operation", async () => {
    let release!: (value: string) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const run = vi.fn(() => new Promise<string>((resolve) => { release = resolve; started(); }));
    const worker = await fixture({ recognition: { transcribe: run } });
    try {
      const pending = worker.post("/transcriptions", { ...envelope(), audio: encodePcm(pcm()) });
      await began;
      expect(await worker.post("/syntheses", { ...envelope(), text: "Hello" })).toEqual({ status: 409, body: { error: "speech-busy" } });
      release("Hello");
      expect((await pending).status).toBe(200);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { await worker.close(); }
  });

  it("cancels on the server deadline and returns a signed timeout response", async () => {
    let observed!: AbortSignal;
    const worker = await fixture({ timeoutMs: 20, recognition: { transcribe: (_audio, signal) => { observed = signal; return abortable(signal, () => {}); } } });
    try {
      expect(await worker.post("/transcriptions", { ...envelope(), audio: encodePcm(pcm()) })).toEqual({ status: 504, body: { error: "speech-timeout" } });
      expect(observed.aborted).toBe(true);
    } finally { await worker.close(); }
  });

  it.each(["recognition", "synthesis"] as const)("discards a late %s result after a deadline", async (kind) => {
    const output = pcm();
    const late = async (signal: AbortSignal) => { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); };
    const worker = await fixture({ timeoutMs: 20,
      recognition: { transcribe: async (_audio, signal) => { await late(signal); return "late"; } },
      synthesis: { synthesize: async (_text, signal) => { await late(signal); return output; } },
    });
    try {
      const value = kind === "recognition" ? { ...envelope(), audio: encodePcm(pcm()) } : { ...envelope(), text: "Hello" };
      expect((await worker.post(kind === "recognition" ? "/transcriptions" : "/syntheses", value)).status).toBe(504);
      if (kind === "synthesis") expect(output.samples.every((sample) => sample === 0)).toBe(true);
    } finally { await worker.close(); }
  });

  it("cancels an engine when the client disconnects", async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    let cancelled!: () => void;
    const ended = new Promise<void>((resolve) => { cancelled = resolve; });
    const worker = await fixture({ recognition: { transcribe: (_audio, signal) => {
      signal.addEventListener("abort", cancelled, { once: true });
      return abortable(signal, started);
    } } });
    try {
      const controller = new AbortController();
      const body = JSON.stringify({ ...envelope(), audio: encodePcm(pcm()) });
      const response = fetch(worker.baseUrl + "/transcriptions", { method: "POST", body, headers: worker.auth.sign({ method: "POST", path: "/transcriptions", body }), signal: controller.signal });
      const rejected = expect(response).rejects.toThrow();
      await began;
      controller.abort();
      await ended;
      await rejected;
    } finally { await worker.close(); }
  });

  it("aborts active work, drains it, and closes idempotently", async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    let observed!: AbortSignal;
    const worker = await fixture({ synthesis: { synthesize: (_text, signal) => { observed = signal; return abortable(signal, started); } } });
    const response = worker.post("/syntheses", { ...envelope(), text: "Hello" });
    const rejected = expect(response).rejects.toThrow();
    await began;
    const first = worker.close();
    expect(worker.close()).toBe(first);
    await first;
    await rejected;
    expect(observed.aborted).toBe(true);
    expect(worker.server.listening).toBe(false);
  });

  it("refuses admission after close even if the server is manually restarted", async () => {
    const worker = await fixture();
    await worker.close();
    worker.server.listen(Number(new URL(worker.baseUrl).port), "127.0.0.1");
    await once(worker.server, "listening");
    try { expect(await worker.post("/syntheses", { ...envelope(), text: "Hello" })).toEqual({ status: 503, body: { error: "speech-closed" } }); }
    finally { await new Promise<void>((resolve) => { worker.server.close(() => resolve()); }); }
  });

  it("handles an interrupted upload without running an engine", async () => {
    const run = vi.fn();
    const worker = await fixture({ recognition: { transcribe: run } });
    try {
      await new Promise<void>((resolve) => {
        const request = httpRequest(worker.baseUrl + "/transcriptions", { method: "POST", headers: { "content-length": "100" } });
        request.on("error", () => resolve());
        request.write("partial");
        request.once("socket", (socket) => socket.once("connect", () => setTimeout(() => request.destroy(), 20)));
      });
      expect(run).not.toHaveBeenCalled();
    } finally { await worker.close(); }
  });

  it.each([0, 60_001, 1.5])("rejects an invalid deadline %s", (timeoutMs) => {
    expect(() => createSpeechServer({ secret, recognition: { transcribe: vi.fn() }, synthesis: { synthesize: vi.fn() }, timeoutMs })).toThrow("Invalid speech timeout");
  });

  it("rejects a malformed dedicated secret before creating a server", () => {
    expect(() => createSpeechServer({ secret: "bad", recognition: { transcribe: vi.fn() }, synthesis: { synthesize: vi.fn() } })).toThrow("invalid-auth");
  });
});
