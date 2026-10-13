import { validatePcm, type PcmAudio } from "@matrix-call/core";

export function encodeWav(audio: PcmAudio): Buffer {
  validatePcm(audio);
  const wav = Buffer.alloc(44 + audio.samples.byteLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(audio.sampleRate, 24);
  wav.writeUInt32LE(audio.sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(audio.samples.byteLength, 40);
  for (let i = 0; i < audio.samples.length; i++) wav.writeInt16LE(audio.samples[i]!, 44 + i * 2);
  return wav;
}

export function decodeWav(wav: Buffer, espeakStream = false): PcmAudio {
  if (wav.length < 46 || wav.length > 960_044 || wav.length % 2 !== 0 ||
      wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 16) !== "WAVEfmt " ||
      wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 ||
      wav.readUInt32LE(28) !== wav.readUInt32LE(24) * 2 || wav.readUInt16LE(32) !== 2 ||
      wav.readUInt16LE(34) !== 16 || wav.toString("ascii", 36, 40) !== "data") {
    throw new Error("Invalid engine WAV output");
  }
  const streaming = espeakStream && wav.readUInt32LE(4) === 0x7ffff024 && wav.readUInt32LE(40) === 0x7ffff000;
  if (!streaming && (wav.readUInt32LE(4) !== wav.length - 8 || wav.readUInt32LE(40) !== wav.length - 44)) {
    throw new Error("Invalid engine WAV output");
  }
  const samples = new Int16Array((wav.length - 44) / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(44 + i * 2);
  const audio: PcmAudio = Object.freeze({ samples, sampleRate: wav.readUInt32LE(24), channels: 1 });
  validatePcm(audio);
  return audio;
}

export function recognitionPcm(audio: PcmAudio): PcmAudio {
  validatePcm(audio);
  if (audio.sampleRate === 16_000) return Object.freeze({ ...audio, samples: audio.samples.slice() });
  const samples = new Int16Array(Math.max(1, Math.round(audio.samples.length * 16_000 / audio.sampleRate)));
  const ratio = audio.sampleRate / 16_000;
  const cutoff = Math.min(1, 1 / ratio);
  const radius = 16 / cutoff;
  for (let i = 0; i < samples.length; i++) {
    const center = (i + 0.5) * ratio - 0.5;
    let sum = 0;
    let weight = 0;
    for (let j = Math.max(0, Math.ceil(center - radius)); j <= Math.min(audio.samples.length - 1, Math.floor(center + radius)); j++) {
      const distance = (j - center) * cutoff;
      const sinc = distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);
      const tap = sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / 16));
      sum += audio.samples[j]! * tap;
      weight += tap;
    }
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(sum / weight)));
  }
  return Object.freeze({ samples, sampleRate: 16_000, channels: 1 });
}
