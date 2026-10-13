import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestAuthenticator } from "../../packages/core/src/index.js";
import { decodePcm, encodePcm, HttpSpeechAdapter, SpeechHttpError } from "../../packages/speech-http/src/index.js";

const secret = "ab".repeat(32);
const audience = "03ade3af-6c83-4b45-b401-acab7432111a";
const baseUrl = "https://speech.example.org/v1/speech";
const audio = { samples: new Int16Array([-32768, 1, 32767]), sampleRate: 16_000, channels: 1 as const };
const capabilities = { protocolVersion: 1, audience, recognition: true, synthesis: true, encoding: "pcm-s16le" };
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const auth = new RequestAuthenticator({ secret, audience });
  const signed = (body: string, path: string) => new Response(body, { headers: auth.sign({ method: "RESPONSE_200", path, body }) });
  const fetcher = vi.fn<typeof globalThis.fetch>(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (options!.method !== "POST") return signed(JSON.stringify(capabilities), path);
    auth.verify({ method: "POST", path, body: options!.body as string }, options!.headers as Record<string, string>);
    const request = JSON.parse(options!.body as string);
    return signed(JSON.stringify({ protocolVersion: 1, requestId: request.requestId,
      ...(path.endsWith("transcriptions") ? { text: " Hello " } : { audio: encodePcm(audio) }) }), path);
  });
  const connect = (options = {}) => HttpSpeechAdapter.connect({ baseUrl, secret, fetch: fetcher, ...options });
  return { auth, signed, fetcher, connect };
}

describe("authenticated portable HTTP speech", () => {
  it("signs bounded PCM requests, trims transcripts and decodes independent synthesis samples", async () => {
    const f = fixture(); const adapter = await f.connect();
    expect(await adapter.transcribe(audio, signal())).toBe("Hello");
    expect(await adapter.synthesize("Reply", signal())).toEqual(audio);
    const [url, options] = f.fetcher.mock.calls[1]!;
    expect(String(url)).toBe(`${baseUrl}/transcriptions`);
    expect(options!.redirect).toBe("error");
    expect(decodePcm(JSON.parse(options!.body as string).audio)).toEqual(audio);
    expect(JSON.stringify(f.fetcher.mock.calls)).not.toContain(secret);
  });

  it.each([
    "invalid", "ftp://localhost", "http://speech.example.org", "http://127.0.0.1", "https://u:p@example.org",
    "https://example.org#fragment", "https://example.org?token=secret",
  ])("rejects unsafe or implicit plaintext endpoint %s", async (url) => {
    const f = fixture();
    await expect(f.connect({ baseUrl: url })).rejects.toThrow(new SpeechHttpError("invalid-config"));
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([0, 300_001, 1.5, NaN])("rejects invalid timeout %s", async (timeoutMs) => {
    const f = fixture(); await expect(f.connect({ timeoutMs })).rejects.toThrow("invalid-config");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["http://localhost/v1/speech/", "http://127.0.0.1/v1/speech/", "http://[::1]/v1/speech/"])
    ("accepts explicitly selected loopback HTTP %s", async (url) => {
      const f = fixture(); await f.connect({ baseUrl: url, allowInsecureLoopback: true });
      expect(String(f.fetcher.mock.calls[0]![0])).toBe(`${url}capabilities`);
    });

  it("does not broaden the loopback exception or contact a service with an invalid secret", async () => {
    const f = fixture();
    await expect(f.connect({ baseUrl: "http://private.example.org", allowInsecureLoopback: true })).rejects.toThrow("invalid-config");
    await expect(f.connect({ secret: "bad" })).rejects.toThrow("invalid-auth");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["{", JSON.stringify({ ...capabilities, protocolVersion: 2 })])("rejects invalid capabilities %#", async (body) => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(f.signed(body, "/v1/speech/capabilities"));
    await expect(f.connect()).rejects.toThrow("invalid-response");
  });

  it.each([new Response(null), new Response("private error", { status: 503 }), new Response(JSON.stringify(capabilities))])
    ("requires available authenticated capabilities %#", async (response) => {
      const f = fixture(); f.fetcher.mockResolvedValueOnce(response);
      await expect(f.connect()).rejects.toThrow();
    });

  it("rejects malformed UTF-8 and consumes a bounded streaming capability response", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response(new Uint8Array([0xff])));
    await expect(f.connect()).rejects.toThrow("invalid-response");
    const cancel = vi.fn();
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(4000)); controller.enqueue(new Uint8Array(97));
    }, cancel })));
    await expect(f.connect()).rejects.toThrow("response-too-large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["transcribe", "synthesize"] as const)("does not dispatch canceled %s operations", async (method) => {
    const f = fixture(); const adapter = await f.connect(); const aborted = AbortSignal.abort(new Error("closed"));
    await expect(method === "transcribe" ? adapter.transcribe(audio, aborted) : adapter.synthesize("Hello", aborted)).rejects.toThrow("closed");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid input before contacting a provider", async () => {
    const f = fixture(); const adapter = await f.connect();
    await expect(adapter.transcribe({ ...audio, channels: 2 } as unknown as typeof audio, signal())).rejects.toThrow("Invalid PCM");
    await expect(adapter.synthesize(" ", signal())).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["transcriptions", "syntheses"])("rejects malformed or misrouted %s results", async (path) => {
    const f = fixture(); const adapter = await f.connect();
    for (const reply of [{ protocolVersion: 2 }, { protocolVersion: 1, requestId: audience, text: "Hello", audio: encodePcm(audio) },
      { protocolVersion: 1, requestId: audience, ...(path === "transcriptions" ? { text: "Hello" } : { audio: encodePcm(audio) }) }]) {
      f.fetcher.mockResolvedValueOnce(f.signed(JSON.stringify(reply), `/v1/speech/${path}`));
      await expect(path === "transcriptions" ? adapter.transcribe(audio, signal()) : adapter.synthesize("Hello", signal())).rejects.toThrow("invalid-response");
    }
  });

  it("rejects remote failures, body tampering and oversized synthesis responses", async () => {
    const f = fixture(); const adapter = await f.connect();
    f.fetcher.mockResolvedValueOnce(new Response("private provider error", { status: 500 }));
    await expect(adapter.transcribe(audio, signal())).rejects.toThrow("http-error");
    f.fetcher.mockResolvedValueOnce(new Response("tampered", { headers: f.signed("original", "/v1/speech/syntheses").headers }));
    await expect(adapter.synthesize("Hello", signal())).rejects.toThrow("invalid-auth");
    f.fetcher.mockResolvedValueOnce(new Response("a".repeat(1_300_001)));
    await expect(adapter.synthesize("Hello", signal())).rejects.toThrow("response-too-large");
  });

  it("discards late HTTP results and cancels a stalled response body", async () => {
    const f = fixture(); const adapter = await f.connect(); const controller = new AbortController();
    f.fetcher.mockImplementationOnce(async () => { controller.abort(new Error("closed")); return new Response("{}"); });
    await expect(adapter.transcribe(audio, controller.signal)).rejects.toThrow("closed");
    const next = new AbortController(); const cancel = vi.fn();
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = adapter.synthesize("Hello", next.signal); const assertion = expect(pending).rejects.toThrow("closed");
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3));
    next.abort(new Error("closed")); await assertion; expect(cancel).toHaveBeenCalledOnce();
  });

  it("handles cancellation even if stream cancellation fails", async () => {
    const f = fixture(); const adapter = await f.connect(); const controller = new AbortController();
    const cancel = vi.fn(async () => { throw new Error("cancel failed"); });
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = adapter.transcribe(audio, controller.signal); const assertion = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2)); controller.abort();
    await assertion; expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses the default fetch against a real local signed speech service", async () => {
    const f = fixture(); const received: unknown[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8"); const path = req.url!;
      let body = JSON.stringify(capabilities);
      if (req.method === "POST") {
        f.auth.verify({ method: "POST", path, body: raw }, req.headers);
        const input = JSON.parse(raw); received.push(input);
        body = JSON.stringify({ protocolVersion: 1, requestId: input.requestId,
          ...(path.endsWith("transcriptions") ? { text: "Local recognition" } : { audio: encodePcm(audio) }) });
      }
      res.writeHead(200, { ...f.auth.sign({ method: "RESPONSE_200", path, body }), "content-type": "application/json" }).end(body);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const adapter = await HttpSpeechAdapter.connect({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/speech/`, secret, allowInsecureLoopback: true });
      expect(await adapter.transcribe(audio, signal())).toBe("Local recognition");
      expect(await adapter.synthesize("Local synthesis", signal())).toEqual(audio);
      expect(received).toHaveLength(2);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
