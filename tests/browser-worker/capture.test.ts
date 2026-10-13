import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomEvent, Track, type Room } from "livekit-client";
import { RemoteAudioCapture } from "../../packages/browser-worker/src/capture.js";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const nodes: { port: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => void) | null }; onprocessorerror: (() => void) | null; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const sources: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const addModule = vi.fn(async () => {});
  const createSource = vi.fn(() => { const source = { connect: vi.fn(), disconnect: vi.fn() }; sources.push(source); return source; });
  const context = { audioWorklet: { addModule }, createMediaStreamSource: createSource, sampleRate: 8000, destination: {} };
  const worklet = vi.fn(() => {
    const node = { port: { postMessage: vi.fn(), close: vi.fn(), onmessage: null }, onprocessorerror: null, connect: vi.fn(), disconnect: vi.fn() };
    nodes.push(node); return node;
  });
  const stream = vi.fn();
  vi.stubGlobal("MediaStream", class { constructor(tracks: unknown[]) { stream(tracks); } });
  vi.stubGlobal("AudioWorkletNode", class { constructor() { return worklet(); } });
  const room = new EventEmitter(); const received = vi.fn(); const permitted = vi.fn(() => true); const failure = vi.fn();
  const capture = new RemoteAudioCapture(room as unknown as Room, context as unknown as AudioContext, received, permitted, failure);
  const track = { kind: Track.Kind.Audio, mediaStreamTrack: {} };
  const publication = { source: Track.Source.Microphone, isEncrypted: true };
  const participant = { identity: "speaker" };
  const subscribe = (id = "speaker", remote = track, pub = publication) => room.emit(RoomEvent.TrackSubscribed, remote, pub, { identity: id });
  const send = (value: number, count: number, node = nodes.at(-1)!, epoch = 0) => {
    for (let i = 0; i < count; i++) node.port.onmessage!({ data: { epoch, samples: new Float32Array(160).fill(value) } });
  };
  return { capture, room, context, addModule, createSource, sources, nodes, received, permitted, failure, worklet, stream, track, publication, participant, subscribe, send };
}

describe("decrypted remote microphone capture", () => {
  it("loads only the local worklet, captures actual SDK track audio and outputs mono PCM", async () => {
    const f = fixture(); await f.capture.start();
    expect(f.addModule).toHaveBeenCalledWith("/capture-worklet.js");
    f.subscribe(); expect(f.stream).toHaveBeenCalledWith([f.track.mediaStreamTrack]);
    expect(f.nodes[0]!.connect).toHaveBeenCalledWith(f.context.destination);
    f.send(0.5, 10); f.send(0, 30);
    expect(f.received).toHaveBeenCalledOnce();
    expect(f.received.mock.calls[0]![0]).toBe("speaker");
    expect(f.received.mock.calls[0]![1]).toMatchObject({ sampleRate: 8000, channels: 1 });
    expect(f.received.mock.calls[0]![1].samples[0]).toBe(16384);
    expect(f.nodes[0]!.port.postMessage).toHaveBeenLastCalledWith({ type: "ack", epoch: 0 });
    f.capture.close(); f.capture.close();
    expect(f.nodes[0]!.port.close).toHaveBeenCalledOnce(); expect(f.sources[0]!.disconnect).toHaveBeenCalledOnce();
    expect(f.room.listenerCount(RoomEvent.TrackSubscribed)).toBe(0);
  });

  it("does not collect video, screen share audio or unencrypted publications", async () => {
    const f = fixture(); await f.capture.start();
    f.subscribe("video", { ...f.track, kind: Track.Kind.Video });
    f.subscribe("screen", f.track, { ...f.publication, source: Track.Source.ScreenShareAudio });
    f.subscribe("plain", f.track, { ...f.publication, isEncrypted: false });
    expect(f.worklet).not.toHaveBeenCalled(); f.capture.close();
  });

  it("discards revoked input and old epochs after reset without joining previous speech", async () => {
    const f = fixture(); await f.capture.start(); f.subscribe();
    f.send(0.5, 9); f.permitted.mockReturnValue(false); f.send(0.5, 10);
    f.permitted.mockReturnValue(true); f.send(0, 30); expect(f.received).not.toHaveBeenCalled();
    f.send(0.5, 9); f.capture.reset(); f.send(0.5, 10); f.send(0, 30);
    expect(f.received).not.toHaveBeenCalled();
    f.send(0.5, 10, f.nodes[0], 1); f.send(0, 30, f.nodes[0], 1);
    expect(f.received).toHaveBeenCalledOnce();
    expect(f.received.mock.calls[0]![1].samples).toHaveLength(6400);
    f.capture.close();
  });

  it("replaces duplicate microphone tracks without allowing a stale unsubscribe to remove the new track", async () => {
    const f = fixture(); await f.capture.start(); f.subscribe();
    const stale = f.nodes[0]!.port.onmessage!; const staleError = f.nodes[0]!.onprocessorerror!;
    const next = { ...f.track, mediaStreamTrack: {} }; f.subscribe("speaker", next);
    stale({ data: { epoch: 0, samples: new Float32Array(160).fill(0.5) } }); staleError();
    f.room.emit(RoomEvent.TrackUnsubscribed, f.track, f.publication, f.participant);
    f.room.emit(RoomEvent.TrackUnsubscribed, f.track, f.publication, { identity: "absent" });
    expect(f.nodes[1]!.disconnect).not.toHaveBeenCalled();
    f.room.emit(RoomEvent.TrackUnsubscribed, next, f.publication, f.participant);
    expect(f.nodes[1]!.disconnect).toHaveBeenCalledOnce(); expect(f.failure).not.toHaveBeenCalled();
    f.capture.close();
  });

  it("signals processor, invalid chunk and consumer failures without retaining a queue", async () => {
    const f = fixture(); await f.capture.start(); f.subscribe();
    f.nodes[0]!.onprocessorerror!();
    f.nodes[0]!.port.onmessage!({ data: { epoch: 0, samples: new Float32Array([NaN]) } });
    f.received.mockImplementationOnce(() => { throw new Error("consumer failed"); });
    f.send(0.5, 10); f.send(0, 30); expect(f.failure).toHaveBeenCalledTimes(3);
    f.capture.close();
  });

  it("cleans partially constructed audio graphs and reports SDK or graph failures", async () => {
    const f = fixture(); await f.capture.start();
    f.createSource.mockImplementationOnce(() => { throw new Error("source failed"); }); f.subscribe();
    f.worklet.mockImplementationOnce(() => { throw new Error("node failed"); }); f.subscribe();
    expect(f.sources[0]!.disconnect).toHaveBeenCalledOnce(); expect(f.failure).toHaveBeenCalledTimes(2);
    f.capture.close();
  });

  it("limits independent capture graphs and ignores subscription callbacks after closing", async () => {
    const f = fixture(); await f.capture.start();
    const subscribed = f.room.listeners(RoomEvent.TrackSubscribed)[0]!;
    for (let i = 0; i < 17; i++) f.subscribe(`speaker-${i}`);
    expect(f.worklet).toHaveBeenCalledTimes(16); expect(f.failure).toHaveBeenCalledOnce();
    f.capture.close(); subscribed(f.track, f.publication, f.participant);
    expect(f.worklet).toHaveBeenCalledTimes(16);
  });

  it("does not register listeners after closing during module load and never restarts", async () => {
    const f = fixture(); let finish!: () => void;
    f.addModule.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const starting = f.capture.start(); f.capture.close(); finish();
    await expect(starting).rejects.toThrow("unavailable");
    await expect(f.capture.start()).rejects.toThrow("unavailable");
    expect(f.room.listenerCount(RoomEvent.TrackSubscribed)).toBe(0);
    const g = fixture(); await g.capture.start(); await expect(g.capture.start()).rejects.toThrow("unavailable"); g.capture.close();
    const h = fixture(); h.capture.close(); await expect(h.capture.start()).rejects.toThrow("unavailable");
  });
});
