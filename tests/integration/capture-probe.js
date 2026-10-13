export function installCaptureProbe() {
  const NativeNode = window.AudioWorkletNode;
  window.matrixCaptureProbe = [];
  window.AudioWorkletNode = class extends NativeNode {
    constructor(...args) {
      super(...args);
      if (args[1] !== "matrix-call-pcm") return;
      const state = { chunks: 0, voiced: 0, resets: 0, acknowledgements: 0, closed: false, peakRms: 0 };
      window.matrixCaptureProbe.push(state);
      this.port.addEventListener("message", ({ data }) => {
        if (!data.samples) return;
        const rms = Math.sqrt(data.samples.reduce((sum, value) => sum + value * value, 0) / data.samples.length);
        state.chunks++; if (rms >= 0.012) state.voiced++; state.peakRms = Math.max(state.peakRms, rms);
      });
      const post = this.port.postMessage.bind(this.port);
      this.port.postMessage = (value, ...args) => {
        if (value.type === "reset") state.resets++;
        if (value.type === "ack") state.acknowledgements++;
        if (value.type === "close") state.closed = true;
        return post(value, ...args);
      };
    }
  };
}
