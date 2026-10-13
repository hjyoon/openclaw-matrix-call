import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RoomEvent, Track } from "livekit-client";
import { MatrixMediaKeyProvider } from "../../packages/matrixrtc/src/key-provider.js";
import { createBrowserMedia } from "../../packages/browser-worker/src/media.js";
import type { PcmAudio } from "../../packages/core/src/contracts.js";

const { roomFactory, logLevel } = vi.hoisted(() => ({ roomFactory: vi.fn(), logLevel: vi.fn() }));
vi.mock("livekit-client", async (original) => ({ ...await original<object>(), Room: class { constructor(options: unknown) { return roomFactory(options); } }, setLogLevel: logLevel }));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const track = { enabled: true, stop: vi.fn() };
  const destination = { stream: { getAudioTracks: () => [track] } };
  const samples = new Float32Array(3);
  let endOnStart = true;
  const source = { buffer: undefined, onended: undefined as (() => void) | undefined, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(() => { if (endOnStart) queueMicrotask(() => source.onended?.()); }), stop: vi.fn(() => { source.onended?.(); }) };
  const audio = { createMediaStreamDestination: () => destination, resume: vi.fn(async () => {}), close: vi.fn(async () => {}), createBuffer: vi.fn(() => ({ getChannelData: () => samples })), createBufferSource: () => source };
  const worker = { terminate: vi.fn() };
  const room = Object.assign(new EventEmitter(), { setE2EEEnabled: vi.fn(async () => {}), connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), localParticipant: { publishTrack: vi.fn(async () => {}) } });
  const appended = vi.fn();
  vi.stubGlobal("document", { body: { append: appended } });
  vi.stubGlobal("Worker", class { constructor() { return worker; } });
  vi.stubGlobal("AudioContext", class { constructor() { return audio; } });
  roomFactory.mockReturnValue(room);
  const provider = new MatrixMediaKeyProvider();
  const media = createBrowserMedia(provider);
  return { media, provider, room, track, source, samples, audio, worker, appended, holdAudio: () => { endOnStart = false; } };
}
const pcm: PcmAudio = { samples: new Int16Array([-32_768, 0, 16_384]), sampleRate: 16_000, channels: 1 };

describe("browser PCM media", () => {
  it("enables encrypted media and publishes an initially suspended audio track", async () => {
    const f = fixture();
    expect(f.track.enabled).toBe(false);
    expect(logLevel).toHaveBeenCalledWith("silent");
    expect(roomFactory).toHaveBeenCalledWith(expect.objectContaining({ encryption: { keyProvider: f.provider, worker: f.worker } }));
    await f.media.connect("wss://sfu.example.org", "jwt", "local");
    expect(f.provider.getLatestManuallySetKeyIndex()).toBe(0);
    expect(f.room.setE2EEEnabled).toHaveBeenCalledWith(true);
    expect(f.room.connect).toHaveBeenCalledWith("wss://sfu.example.org", "jwt", { autoSubscribe: false });
    expect(f.room.localParticipant.publishTrack).toHaveBeenCalledWith(f.track, { source: Track.Source.Microphone, dtx: false, red: false });
    await f.media.close();
  });

  it("converts bounded signed PCM and releases sources after playback", async () => {
    const f = fixture();
    f.media.resume();
    await f.media.publish(pcm, new AbortController().signal);
    expect([...f.samples]).toEqual([-1, 0, 0.5]);
    expect(f.audio.createBuffer).toHaveBeenCalledWith(1, 3, 16_000);
    expect(f.source.disconnect).toHaveBeenCalledOnce();
    await f.media.publish(pcm, new AbortController().signal);
    expect(f.source.start).toHaveBeenCalledTimes(2);
    f.media.suspend();
    await expect(f.media.publish(pcm, new AbortController().signal)).rejects.toThrow("unavailable");
    await f.media.close();
  });

  it.each([
    { ...pcm, channels: 2 }, { ...pcm, sampleRate: 16_000.5 }, { ...pcm, sampleRate: 7999 }, { ...pcm, sampleRate: 48_001 },
    { ...pcm, samples: [1] }, { ...pcm, samples: new Int16Array() }, { ...pcm, samples: new Int16Array(160_001) },
  ])("rejects invalid or oversized PCM before playback", async (audio) => {
    const f = fixture();
    f.media.resume();
    await expect(f.media.publish(audio as PcmAudio, new AbortController().signal)).rejects.toThrow("Invalid PCM audio");
    expect(f.source.start).not.toHaveBeenCalled();
    await f.media.close();
  });

  it("serializes playback and cancels active output immediately", async () => {
    const f = fixture();
    f.media.resume(); f.holdAudio();
    const controller = new AbortController();
    const pending = f.media.publish(pcm, controller.signal);
    await expect(f.media.publish(pcm, new AbortController().signal)).rejects.toThrow("unavailable");
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(f.source.stop).toHaveBeenCalledOnce();
    await expect(f.media.publish(pcm, controller.signal)).rejects.toThrow("cancelled");
    await f.media.close();
  });

  it("stops pending audio on suspension or shutdown", async () => {
    const f = fixture();
    f.media.resume(); f.holdAudio();
    const pending = f.media.publish(pcm, new AbortController().signal);
    f.media.suspend();
    await pending;
    f.media.resume();
    const next = f.media.publish(pcm, new AbortController().signal);
    await f.media.close(); await next;
    f.media.resume();
    expect(f.track.enabled).toBe(false);
    await expect(f.media.publish(pcm, new AbortController().signal)).rejects.toThrow("unavailable");
  });

  it("attaches incoming audio without audible host playback and releases elements", async () => {
    const f = fixture();
    const element = { muted: false, play: vi.fn(async () => {}), remove: vi.fn() };
    const remote = { kind: Track.Kind.Audio, attach: () => element, detach: () => [element] };
    f.room.emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Video });
    f.room.emit(RoomEvent.TrackSubscribed, remote);
    expect(element.muted).toBe(true);
    expect(f.appended).toHaveBeenCalledWith(element);
    f.room.emit(RoomEvent.TrackUnsubscribed, remote);
    expect(element.remove).toHaveBeenCalledOnce();
    f.room.emit(RoomEvent.TrackSubscribed, remote);
    await f.media.close();
    expect(element.remove).toHaveBeenCalledTimes(2);
  });

  it("suspends sending if incoming audio cannot start", async () => {
    const f = fixture();
    f.media.resume();
    f.room.emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Audio, attach: () => ({ play: async () => { throw new Error("failed"); }, remove: () => {} }) });
    await Promise.resolve();
    expect(f.track.enabled).toBe(false);
    await f.media.close();
  });

  it("releases the worker and audio context even when disconnect fails", async () => {
    const f = fixture();
    f.room.disconnect.mockRejectedValue(new Error("disconnect failed"));
    await expect(f.media.close()).rejects.toThrow("disconnect failed");
    await f.media.close();
    expect(f.worker.terminate).toHaveBeenCalledOnce();
    expect(f.audio.close).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalledOnce();
  });
});
