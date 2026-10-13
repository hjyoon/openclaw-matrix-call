import { RoomEvent, Track, type Room, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from "livekit-client";
import type { PcmAudio } from "@matrix-call/core";
import { PcmSegmenter } from "../../voice/src/segmenter.js";

type Capture = {
  track: RemoteTrack;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  segmenter: PcmSegmenter;
  epoch: number;
  active: boolean;
};

export class RemoteAudioCapture {
  readonly #entries = new Map<string, Capture>();
  #started = false;
  #closed = false;
  #epoch = 0;

  constructor(readonly room: Room, readonly context: AudioContext,
    readonly onAudio: (identity: string, audio: PcmAudio) => void,
    readonly permitted: (identity: string) => boolean, readonly onFailure: () => void) {}

  async start(): Promise<void> {
    if (this.#started || this.#closed) throw new Error("Audio capture is unavailable");
    this.#started = true;
    await this.context.audioWorklet.addModule("/capture-worklet.js");
    if (this.#closed) throw new Error("Audio capture is unavailable");
    this.room.on(RoomEvent.TrackSubscribed, this.#subscribed);
    this.room.on(RoomEvent.TrackUnsubscribed, this.#unsubscribed);
  }

  readonly #subscribed = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant): void => {
    if (this.#closed || track.kind !== Track.Kind.Audio || publication.source !== Track.Source.Microphone || !publication.isEncrypted) return;
    const identity = participant.identity;
    const previous = this.#entries.get(identity);
    if (previous) this.#remove(identity, previous);
    if (this.#entries.size >= 16) { this.onFailure(); return; }
    let source: MediaStreamAudioSourceNode | undefined;
    try {
      source = this.context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      const node = new AudioWorkletNode(this.context, "matrix-call-pcm", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
      });
      const entry: Capture = { track, source, node, epoch: this.#epoch, active: true, segmenter: new PcmSegmenter(this.context.sampleRate) };
      this.#entries.set(identity, entry);
      node.port.postMessage({ type: "reset", epoch: entry.epoch });
      node.port.onmessage = ({ data }) => {
        try {
          if (!entry.active || data.epoch !== entry.epoch) return;
          if (!publication.isEncrypted || !participant.isEncrypted || track.mediaStreamTrack.readyState !== "live" ||
              !this.permitted(identity)) { entry.segmenter.reset(); return; }
          const audio = entry.segmenter.push(data.samples);
          if (audio) this.onAudio(identity, audio);
        } catch { this.onFailure(); }
        finally { node.port.postMessage({ type: "ack", epoch: data.epoch }); }
      };
      node.onprocessorerror = () => { if (entry.active) this.onFailure(); };
      source.connect(node); node.connect(this.context.destination);
    } catch { source?.disconnect(); this.onFailure(); }
  };

  readonly #unsubscribed = (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant): void => {
    const entry = this.#entries.get(participant.identity);
    if (entry?.track === track) this.#remove(participant.identity, entry);
  };

  #remove(identity: string, entry: Capture): void {
    entry.active = false; entry.segmenter.reset();
    entry.node.port.onmessage = null; entry.node.onprocessorerror = null;
    entry.node.port.postMessage({ type: "close" }); entry.node.port.close();
    entry.source.disconnect(); entry.node.disconnect(); this.#entries.delete(identity);
  }

  reset(): void {
    ++this.#epoch;
    for (const entry of this.#entries.values()) {
      entry.epoch = this.#epoch; entry.segmenter.reset();
      entry.node.port.postMessage({ type: "reset", epoch: entry.epoch });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.room.off(RoomEvent.TrackSubscribed, this.#subscribed);
    this.room.off(RoomEvent.TrackUnsubscribed, this.#unsubscribed);
    for (const [identity, entry] of this.#entries) this.#remove(identity, entry);
  }
}
