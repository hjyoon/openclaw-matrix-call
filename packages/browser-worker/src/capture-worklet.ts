declare const sampleRate: number;
declare const AudioWorkletProcessor: { new(): { readonly port: MessagePort } };
declare function registerProcessor(name: string, processor: typeof MatrixPcmCapture): void;

export class MatrixPcmCapture extends AudioWorkletProcessor {
  #samples = new Float32Array(Math.round(sampleRate / 50));
  #offset = 0;
  #pending = false;
  #closed = false;
  #epoch = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === "reset") {
        this.#epoch = data.epoch; this.#samples.fill(0); this.#offset = 0; this.#pending = false;
      } else if (data.type === "ack" && data.epoch === this.#epoch) this.#pending = false;
      else if (data.type === "close") this.#closed = true;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.#closed) return false;
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (let i = 0; i < samples.length; i++) {
      this.#samples[this.#offset++] = samples[i]!;
      if (this.#offset === this.#samples.length) {
        if (!this.#pending) {
          const chunk = this.#samples;
          this.#samples = new Float32Array(chunk.length);
          this.#pending = true;
          this.port.postMessage({ epoch: this.#epoch, samples: chunk }, [chunk.buffer]);
        }
        this.#offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("matrix-call-pcm", MatrixPcmCapture);
