import { describe, expect, it, vi } from "vitest";
import { SynthesisLimitError, type PcmAudio } from "../../packages/core/src/index.js";
import { speakReply, splitSpeechText } from "../../packages/voice/src/index.js";

const pcm = (seconds = 0.01): PcmAudio => ({ samples: new Int16Array(Math.round(8000 * seconds)).fill(100), sampleRate: 8000, channels: 1 });
const signal = () => new AbortController().signal;
function fixture() {
  const originals: PcmAudio[] = []; const delivered: PcmAudio[] = [];
  const synthesis = { synthesize: vi.fn(async (_text: string, _signal: AbortSignal) => { const audio = pcm(); originals.push(audio); return audio; }) };
  const transport = { publish: vi.fn(async (audio: PcmAudio, _signal: AbortSignal) => { delivered.push(audio); }) };
  const verify = vi.fn(async () => {});
  return { synthesis, transport, verify, originals, delivered };
}

describe("bounded spoken replies", () => {
  it("preserves Korean, emoji and combining graphemes while preferring word boundaries", () => {
    expect(splitSpeechText("  Hello world. Another sentence!  ", 16)).toEqual(["Hello world.", "Another", "sentence!"]);
    const text = "가족👨‍👩‍👧‍👦e\u0301".repeat(20);
    expect(splitSpeechText(text, 7).join("")).toBe(text);
    for (const part of splitSpeechText(text, 7)) expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(part)].length).toBeLessThanOrEqual(7);
    expect(splitSpeechText("a" + " ".repeat(150) + "b")).toEqual(["a", "b"]);
    expect(splitSpeechText("x".repeat(130)).map((part) => part.length)).toEqual([64, 64, 2]);
  });

  it.each(["", " ", "x".repeat(16001), "nul\0text", null])("rejects malformed spoken text %#", (text) => {
    expect(() => splitSpeechText(text as string)).toThrow("invalid-agent-reply");
  });

  it.each([0, 65, 1.5, NaN])("rejects invalid segment limits %s", (limit) => {
    expect(() => splitSpeechText("Hello", limit)).toThrow("invalid-agent-reply");
  });

  it("publishes every part in order, reverifies each stage and wipes original and copied PCM", async () => {
    const f = fixture(); const text = "abcdefgh".repeat(20);
    await speakReply(text, f, signal());
    expect(f.synthesis.synthesize.mock.calls.map(([part]) => part).join("")).toBe(text);
    expect(f.transport.publish).toHaveBeenCalledTimes(3); expect(f.verify).toHaveBeenCalledTimes(6);
    for (const audio of [...f.originals, ...f.delivered]) expect(audio.samples.every((sample) => sample === 0)).toBe(true);
    expect(f.originals[0]!.samples).not.toBe(f.delivered[0]!.samples);
  });

  it("subdivides only explicit length limits and preserves the complete spoken text", async () => {
    const f = fixture(); const spoken: string[] = [];
    f.synthesis.synthesize.mockImplementation(async (text) => {
      if ([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length > 8) throw new SynthesisLimitError();
      spoken.push(text); return pcm();
    });
    const text = "가족👨‍👩‍👧‍👦e\u0301".repeat(4);
    await speakReply(text, f, signal());
    expect(spoken.join("")).toBe(text); expect(spoken.length).toBeGreaterThan(1);
    expect(f.transport.publish).toHaveBeenCalledTimes(spoken.length);
    expect(f.verify).toHaveBeenCalledTimes(f.synthesis.synthesize.mock.calls.length + spoken.length);
  });

  it.each([new Error("private provider failure"), new Error("synthesis-too-long")])("never retries an ordinary provider failure %#", async (error) => {
    const f = fixture(); f.synthesis.synthesize.mockRejectedValueOnce(error);
    await expect(speakReply("Long enough to split", f, signal())).rejects.toBe(error);
    expect(f.synthesis.synthesize).toHaveBeenCalledOnce(); expect(f.transport.publish).not.toHaveBeenCalled();
  });

  it("does not divide a single grapheme or exceed the request budget", async () => {
    const f = fixture(); f.synthesis.synthesize.mockRejectedValue(new SynthesisLimitError());
    await expect(speakReply("👨‍👩‍👧‍👦", f, signal())).rejects.toThrow("synthesis-too-long");
    expect(f.synthesis.synthesize).toHaveBeenCalledOnce();
    const g = fixture();
    await expect(speakReply("x".repeat(64 * 65), g, signal())).rejects.toThrow("capacity-exceeded");
    expect(g.synthesis.synthesize).not.toHaveBeenCalled();
    const h = fixture(); h.synthesis.synthesize.mockRejectedValue(new SynthesisLimitError());
    await expect(speakReply("x".repeat(64 * 64), h, signal())).rejects.toThrow("capacity-exceeded");
    expect(h.synthesis.synthesize).toHaveBeenCalledOnce();
  });

  it("permits exactly sixty seconds and discards the part exceeding the total audio budget", async () => {
    const f = fixture(); const generated: PcmAudio[] = [];
    f.synthesis.synthesize.mockImplementation(async () => { const audio = pcm(10); generated.push(audio); return audio; });
    await speakReply("x".repeat(64 * 6), f, signal());
    expect(f.transport.publish).toHaveBeenCalledTimes(6);
    await expect(speakReply("x".repeat(64 * 7), f, signal())).rejects.toThrow("capacity-exceeded");
    expect(f.transport.publish).toHaveBeenCalledTimes(12);
    expect(generated.every((audio) => audio.samples.every((sample) => sample === 0))).toBe(true);
  });

  it("revokes before generation, after synthesis and between published parts", async () => {
    const f = fixture(); f.verify.mockRejectedValueOnce(new Error("revoked"));
    await expect(speakReply("Text", f, signal())).rejects.toThrow("revoked"); expect(f.synthesis.synthesize).not.toHaveBeenCalled();
    const g = fixture(); g.verify.mockResolvedValueOnce().mockRejectedValueOnce(new Error("revoked"));
    await expect(speakReply("Text", g, signal())).rejects.toThrow("revoked"); expect(g.transport.publish).not.toHaveBeenCalled();
    expect(g.originals[0]!.samples.every((sample) => sample === 0)).toBe(true);
    const h = fixture(); h.verify.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error("revoked"));
    await expect(speakReply("x".repeat(128), h, signal())).rejects.toThrow("revoked"); expect(h.transport.publish).toHaveBeenCalledOnce();
    expect(h.synthesis.synthesize).toHaveBeenCalledOnce();
  });

  it("cancels before starting or after verification without invoking synthesis", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort(new Error("closed"));
    await expect(speakReply("Text", f, controller.signal)).rejects.toThrow("closed"); expect(f.verify).not.toHaveBeenCalled();
    const g = fixture(); const second = new AbortController(); g.verify.mockImplementationOnce(async () => { second.abort(new Error("closed")); });
    await expect(speakReply("Text", g, second.signal)).rejects.toThrow("closed"); expect(g.synthesis.synthesize).not.toHaveBeenCalled();
  });

  it("discards late uncooperative synthesis and wipes its samples", async () => {
    const f = fixture(); const controller = new AbortController(); const audio = pcm();
    let finish!: (audio: PcmAudio) => void;
    f.synthesis.synthesize.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = speakReply("Text", f, controller.signal); const failed = expect(pending).rejects.toThrow("closed");
    await vi.waitFor(() => expect(f.synthesis.synthesize).toHaveBeenCalled());
    controller.abort(new Error("closed")); await failed; finish(audio);
    await vi.waitFor(() => expect(audio.samples.every((sample) => sample === 0)).toBe(true));
    expect(f.transport.publish).not.toHaveBeenCalled();
  });

  it("wipes copied output if synthesis aborts during copying", async () => {
    const f = fixture(); const controller = new AbortController(); const raw = pcm(); const copied = raw.samples.slice();
    vi.spyOn(raw.samples, "slice").mockImplementation(() => { controller.abort(new Error("closed")); return copied; });
    f.synthesis.synthesize.mockResolvedValueOnce(raw);
    await expect(speakReply("Text", f, controller.signal)).rejects.toThrow("closed");
    expect(copied.every((sample) => sample === 0)).toBe(true); expect(raw.samples.every((sample) => sample === 0)).toBe(true);
  });

  it.each([null, { samples: [1] }, { samples: new Int16Array() }])("discards malformed provider PCM %#", async (audio) => {
    const f = fixture(); f.synthesis.synthesize.mockResolvedValueOnce(audio as PcmAudio);
    await expect(speakReply("Text", f, signal())).rejects.toThrow(); expect(f.transport.publish).not.toHaveBeenCalled();
  });

  it("cancels after synthesis verification and after publication without speaking more parts", async () => {
    const f = fixture(); const controller = new AbortController();
    f.verify.mockResolvedValueOnce().mockImplementationOnce(async () => { controller.abort(new Error("closed")); });
    await expect(speakReply("Text", f, controller.signal)).rejects.toThrow("closed"); expect(f.transport.publish).not.toHaveBeenCalled();
    const g = fixture(); const second = new AbortController();
    g.transport.publish.mockImplementationOnce(async () => { second.abort(new Error("closed")); });
    await expect(speakReply("x".repeat(128), g, second.signal)).rejects.toThrow("closed"); expect(g.transport.publish).toHaveBeenCalledOnce();
    expect(g.delivered.every((audio) => audio.samples.every((sample) => sample === 0))).toBe(true);
  });
});
