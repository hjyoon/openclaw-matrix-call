import { Room, RoomEvent, Track, setLogLevel } from "livekit-client";
import type { PcmAudio } from "@matrix-call/core";
import { MatrixMediaKeyProvider } from "../../matrixrtc/src/key-provider.js";
import { validatePcm } from "./audio.js";

export type BrowserMedia = Readonly<{
  room: Room;
  connect(url: string, jwt: string, identity: string): Promise<void>;
  suspend(): void;
  resume(): void;
  publish(audio: PcmAudio, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}>;

export function createBrowserMedia(provider: MatrixMediaKeyProvider): BrowserMedia {
  setLogLevel("silent");
  const worker = new Worker("/e2ee-worker.js", { type: "module" });
  const room = new Room({ encryption: { keyProvider: provider, worker }, adaptiveStream: false, dynacast: false });
  const context = new AudioContext({ sampleRate: 48_000 });
  const destination = context.createMediaStreamDestination();
  const track = destination.stream.getAudioTracks()[0]!;
  const elements = new Set<HTMLMediaElement>();
  track.enabled = false;
  let source: AudioBufferSourceNode | undefined;
  let closed = false;

  room.on(RoomEvent.TrackSubscribed, (remote) => {
    if (remote.kind !== Track.Kind.Audio) return;
    const element = remote.attach();
    element.muted = true;
    document.body.append(element);
    elements.add(element);
    void element.play().catch(() => { track.enabled = false; });
  });
  room.on(RoomEvent.TrackUnsubscribed, (remote) => {
    for (const element of remote.detach()) { element.remove(); elements.delete(element); }
  });

  const suspend = (): void => {
    track.enabled = false;
    source?.stop();
  };

  return Object.freeze({
    room,
    async connect(url: string, jwt: string, identity: string) {
      provider.bindLocalIdentity(identity);
      await context.resume();
      await room.setE2EEEnabled(true);
      await room.connect(url, jwt);
      await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, dtx: false, red: false });
    },
    suspend,
    resume() { if (!closed) track.enabled = true; },
    async publish(audio: PcmAudio, signal: AbortSignal) {
      signal.throwIfAborted();
      if (closed || !track.enabled || source) throw new Error("Browser audio is unavailable");
      validatePcm(audio);
      const buffer = context.createBuffer(1, audio.samples.length, audio.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < audio.samples.length; i++) samples[i] = audio.samples[i]! / 32_768;
      const current = context.createBufferSource();
      source = current;
      current.buffer = buffer;
      current.connect(destination);
      const abort = (): void => { current.stop(); };
      try {
        await new Promise<void>((resolve) => {
          current.onended = () => resolve();
          signal.addEventListener("abort", abort, { once: true });
          current.start();
        });
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", abort);
        current.disconnect();
        source = undefined;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      suspend();
      track.stop();
      try { await room.disconnect(); }
      finally {
        for (const element of elements) element.remove();
        elements.clear();
        worker.terminate(); await context.close();
      }
    },
  });
}
