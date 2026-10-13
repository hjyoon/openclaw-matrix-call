import { describe, expect, it, vi } from "vitest";

describe("backpressured audio worklet", () => {
  it("handles variable quanta, bounds pending messages and fences reset epochs", async () => {
    const postMessage = vi.fn(); const port = { postMessage, onmessage: undefined as ((event: { data: unknown }) => void) | undefined };
    const register = vi.fn();
    vi.stubGlobal("sampleRate", 8000);
    vi.stubGlobal("AudioWorkletProcessor", class { port = port; });
    vi.stubGlobal("registerProcessor", register);
    try {
      const { MatrixPcmCapture } = await import("../../packages/browser-worker/src/capture-worklet.js");
      expect(register).toHaveBeenCalledWith("matrix-call-pcm", MatrixPcmCapture);
      const capture = new MatrixPcmCapture();
      expect(capture.process([])).toBe(true); expect(capture.process([[]])).toBe(true);
      capture.process([[new Float32Array(100).fill(0.2)]]);
      expect(postMessage).not.toHaveBeenCalled();
      capture.process([[new Float32Array(220).fill(0.5)]]);
      expect(postMessage).toHaveBeenCalledOnce();
      const first = postMessage.mock.calls[0]![0];
      expect(first.epoch).toBe(0); expect(first.samples).toHaveLength(160);
      expect(first.samples[0]).toBeCloseTo(0.2); expect(first.samples[159]).toBeCloseTo(0.5);
      expect(postMessage.mock.calls[0]![1]).toEqual([first.samples.buffer]);
      port.onmessage!({ data: { type: "unknown" } });
      port.onmessage!({ data: { type: "ack", epoch: 1 } });
      capture.process([[new Float32Array(160)]]); expect(postMessage).toHaveBeenCalledOnce();
      port.onmessage!({ data: { type: "ack", epoch: 0 } });
      capture.process([[new Float32Array(160)]]); expect(postMessage).toHaveBeenCalledTimes(2);
      capture.process([[new Float32Array(159).fill(1)]]);
      port.onmessage!({ data: { type: "reset", epoch: 2 } });
      capture.process([[new Float32Array(160).fill(-0.5)]]);
      expect(postMessage).toHaveBeenCalledTimes(3);
      expect(postMessage.mock.calls[2]![0]).toEqual({ epoch: 2, samples: new Float32Array(160).fill(-0.5) });
      port.onmessage!({ data: { type: "close" } });
      expect(capture.process([[new Float32Array(160)]])).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});
