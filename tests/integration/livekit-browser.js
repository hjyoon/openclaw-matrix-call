import { Room, RoomEvent, Track, setLogLevel } from "livekit-client";
import { MatrixMediaKeyProvider } from "../../packages/matrixrtc/src/key-provider.ts";

setLogLevel("silent");
const provider = new MatrixMediaKeyProvider();
const worker = new Worker("/e2ee-worker.js", { type: "module" });
const room = new Room({ encryption: { keyProvider: provider, worker }, adaptiveStream: false, dynacast: false });
const audio = new AudioContext({ sampleRate: 48_000 });
const analyzers = new Map();
let oscillator;
let volume;
const encryptionErrors = [];
room.on(RoomEvent.EncryptionError, (error) => encryptionErrors.push(error.name));

room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
  if (track.kind !== Track.Kind.Audio) return;
  const element = track.attach();
  element.muted = true;
  document.body.append(element);
  void element.play();
  const source = audio.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
  const analyzer = audio.createAnalyser();
  analyzer.fftSize = 2048;
  const mute = audio.createGain();
  mute.gain.value = 0;
  source.connect(analyzer).connect(mute).connect(audio.destination);
  analyzers.set(participant.identity, { analyzer, publication });
});
room.on(RoomEvent.ParticipantDisconnected, (participant) => analyzers.delete(participant.identity));

window.mediaTest = {
  async key(identity, bytes, index) {
    return provider.install(identity, new Uint8Array(bytes), index, () => true);
  },
  async connect(url, token, identity) {
    provider.bindLocalIdentity(identity);
    await audio.resume();
    await room.setE2EEEnabled(true);
    await room.connect(url, token, { rtcConfig: { iceServers: [] } });
  },
  async publish(frequency) {
    const destination = audio.createMediaStreamDestination();
    const gain = audio.createGain();
    volume = gain;
    gain.gain.value = 0.25;
    oscillator = audio.createOscillator();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await room.localParticipant.publishTrack(destination.stream.getAudioTracks()[0], { source: Track.Source.Microphone, dtx: false, red: false });
  },
  sound(frequency) { oscillator.frequency.value = frequency; volume.gain.value = 0.25; },
  silence() { volume.gain.value = 0; },
  measure(identity) {
    const entry = analyzers.get(identity);
    if (!entry) return { rms: 0, frequency: 0, encrypted: false };
    const samples = new Float32Array(entry.analyzer.fftSize);
    entry.analyzer.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    const spectrum = new Float32Array(entry.analyzer.frequencyBinCount);
    entry.analyzer.getFloatFrequencyData(spectrum);
    let maximum = -Infinity;
    let bin = 0;
    for (let i = 1; i < spectrum.length; i++) {
      if (spectrum[i] > maximum) { maximum = spectrum[i]; bin = i; }
    }
    const frequency = bin * audio.sampleRate / entry.analyzer.fftSize;
    return { rms, frequency, encrypted: entry.publication.isEncrypted && room.isE2EEEnabled };
  },
  async diagnostics() {
    const inbound = [];
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        const report = await publication.track?.getRTCStatsReport();
        for (const value of report?.values() ?? []) {
          if (value.type === "inbound-rtp") inbound.push({ packets: value.packetsReceived, samples: value.totalSamplesReceived, energy: value.totalAudioEnergy, bytes: value.bytesReceived });
        }
      }
    }
    return { state: room.state, e2ee: room.isE2EEEnabled, analyzers: analyzers.size, audioState: audio.state, errors: encryptionErrors, localEncrypted: [...room.localParticipant.trackPublications.values()].map((publication) => publication.isEncrypted), inbound };
  },
  async inboundPackets(identity) {
    const participant = room.remoteParticipants.get(identity);
    let packets = 0;
    for (const publication of participant.trackPublications.values()) {
      const stats = await publication.track.getRTCStatsReport();
      for (const value of stats.values()) {
        if (value.type === "inbound-rtp") packets += value.packetsReceived;
      }
    }
    return packets;
  },
  async close() {
    oscillator?.stop();
    await room.disconnect();
    worker.terminate();
    await audio.close();
  },
};

export { provider, room };
