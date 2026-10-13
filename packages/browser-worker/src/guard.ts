import { publishMatrixRtcKey, type OutboundKeySource } from "../../matrixrtc/src/outbound-key.js";

export class MatrixPublicationChangedError extends Error {
  constructor() { super("Matrix listener membership changed during key rotation"); this.name = "MatrixPublicationChangedError"; }
}

export class MatrixPublicationGuard {
  readonly #source: OutboundKeySource;
  readonly #media: Readonly<{ suspend(): void; resume(): void }>;
  readonly #publish: typeof publishMatrixRtcKey;
  readonly #controller = new AbortController();
  #pending = Promise.resolve();
  #revision = 0;
  #index = 0;
  #allowed = false;

  constructor(source: OutboundKeySource, media: Readonly<{ suspend(): void; resume(): void }>, publish = publishMatrixRtcKey) {
    this.#source = source;
    this.#media = media;
    this.#publish = publish;
  }

  get revision(): number { return this.#revision; }

  permits(revision: number): boolean {
    return !this.#controller.signal.aborted && this.#allowed && revision === this.#revision;
  }

  refresh(): Promise<void> {
    if (this.#controller.signal.aborted) return Promise.reject(new Error("Matrix publication guard is closed"));
    this.#allowed = false;
    this.#media.suspend();
    const revision = ++this.#revision;
    const task = this.#pending.then(async () => {
      if (this.#controller.signal.aborted || revision !== this.#revision) return;
      if (this.#index > 255) throw new Error("Matrix media key rotation limit reached");
      const installed = await this.#publish(this.#source, this.#index++, this.#controller.signal);
      if (!installed) throw new MatrixPublicationChangedError();
      if (this.#controller.signal.aborted || revision !== this.#revision) return;
      this.#allowed = true;
      this.#media.resume();
    });
    this.#pending = task.catch((error) => { if (!(error instanceof MatrixPublicationChangedError)) this.close(); });
    return task;
  }

  close(): void {
    this.#controller.abort();
    this.#allowed = false;
    this.#media.suspend();
  }
}
