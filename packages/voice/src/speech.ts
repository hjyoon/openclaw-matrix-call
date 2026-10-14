import { CallError, copyPcm, isSynthesisLimit, type PcmAudio, type RtcTransportPort, type SpeechSynthesisPort } from "@matrix-call/core";
import { cancelable } from "./cancellation.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (part) => part.segment);

export function splitSpeechText(text: string, maximum = 64): readonly string[] {
  if (typeof text !== "string" || !text.trim() || text.length > 16_000 || text.includes("\0") ||
      !Number.isInteger(maximum) || maximum < 1 || maximum > 64) throw new CallError("invalid-agent-reply");
  const units = graphemes(text.trim()); const parts: string[] = [];
  for (let offset = 0; offset < units.length;) {
    const window = units.slice(offset, offset + maximum);
    const boundary = window.findLastIndex((unit) => /[\s.!?。！？,，;；:：]/u.test(unit)) + 1;
    const count = boundary >= Math.ceil(maximum / 2) ? boundary : window.length;
    const part = window.slice(0, count).join("").trim();
    if (part) parts.push(part);
    offset += count;
  }
  return Object.freeze(parts);
}

async function generate(synthesis: SpeechSynthesisPort, text: string, signal: AbortSignal): Promise<PcmAudio> {
  signal.throwIfAborted();
  let copied: PcmAudio | undefined;
  try {
    const audio = await cancelable(synthesis.synthesize(text, signal).then((raw) => {
      try { signal.throwIfAborted(); copied = copyPcm(raw); return copied; }
      finally { if (raw?.samples instanceof Int16Array) raw.samples.fill(0); }
    }), signal);
    signal.throwIfAborted();
    return audio;
  } catch (error) { copied?.samples.fill(0); throw error; }
}

export async function speakReply(text: string, options: {
  synthesis: SpeechSynthesisPort; transport: Pick<RtcTransportPort, "publish">; verify: () => Promise<unknown>;
}, signal: AbortSignal): Promise<void> {
  const pending = [...splitSpeechText(text)];
  let attempts = 0; let seconds = 0;
  while (pending.length) {
    signal.throwIfAborted();
    if (pending.length > 64 - attempts) throw new CallError("capacity-exceeded");
    await options.verify(); signal.throwIfAborted();
    const part = pending.shift()!;
    attempts++;
    let audio: PcmAudio;
    try { audio = await generate(options.synthesis, part, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (!isSynthesisLimit(error)) throw error;
      const length = graphemes(part).length;
      if (length < 2) throw error;
      pending.unshift(...splitSpeechText(part, Math.floor(length / 2)));
      continue;
    }
    try {
      seconds += audio.samples.length / audio.sampleRate;
      if (seconds > 60) throw new CallError("capacity-exceeded");
      await options.verify(); signal.throwIfAborted();
      await cancelable(options.transport.publish(audio, signal), signal);
      signal.throwIfAborted();
    } finally { audio.samples.fill(0); }
  }
}
