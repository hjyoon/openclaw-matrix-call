import {
  authorizeParticipant, CallCoordinator, CallError, copyPcm, parsePolicy, participantReferenceSchema,
  type AgentPort, type CallPolicy, type ConversationStore, type ParticipantReference, type ParticipantVerifier,
  type PcmAudio, type RtcTransportPort, type SpeechRecognitionPort, type SpeechSynthesisPort, type VerifiedParticipant,
} from "@matrix-call/core";

export type VoiceOptions = Readonly<{
  policy: CallPolicy;
  agentId: string;
  agent: AgentPort;
  store: ConversationStore;
  verifier: ParticipantVerifier;
  recognition: SpeechRecognitionPort;
  synthesis: SpeechSynthesisPort;
  transport: Pick<RtcTransportPort, "publish">;
  timeoutMs?: number;
  now?: () => number;
}>;

type Session = { key: string; controller: AbortController; recordId: string | undefined };
export type VoiceResult = "replied" | "silence" | "busy";

export async function cancelable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); signal.throwIfAborted(); }
  let abort!: () => void;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

export class VoiceAssistant {
  readonly #options: VoiceOptions;
  readonly #policy: CallPolicy;
  readonly #calls: CallCoordinator;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #session: Session | undefined;
  #speaker: VerifiedParticipant | undefined;
  #busy = false;
  #closing: Promise<void> | undefined;

  constructor(options: VoiceOptions) {
    this.#policy = parsePolicy(options.policy);
    this.#timeoutMs = options.timeoutMs ?? 90_000;
    if (!this.#policy.agents.includes(options.agentId) || !Number.isInteger(this.#timeoutMs) ||
        this.#timeoutMs < 1 || this.#timeoutMs > 300_000) throw new CallError("invalid-input");
    this.#options = Object.freeze({ ...options }); this.#now = options.now ?? Date.now;
    this.#calls = new CallCoordinator({ policy: this.#policy, agent: options.agent, store: options.store, maxCalls: 1,
      verifier: { verify: (reference, signal) => this.#verify(reference, signal) }, now: this.#now });
  }

  get busy(): boolean { return this.#busy || Boolean(this.#closing); }

  async receive(reference: ParticipantReference, input: PcmAudio): Promise<VoiceResult> {
    if (this.busy) return "busy";
    const parsed = participantReferenceSchema.safeParse(reference);
    if (!parsed.success) throw new CallError("invalid-input");
    const ref = parsed.data;
    if (!this.#policy.rooms.includes(ref.roomId)) throw new CallError("forbidden");
    const key = JSON.stringify([ref.roomId, ref.rtcSessionId]);
    if (this.#session && this.#session.key !== key) throw new CallError("call-busy");
    const audio = copyPcm(input);
    const session = this.#session ?? { key, controller: new AbortController(), recordId: undefined };
    this.#session = session; this.#busy = true;
    const signal = AbortSignal.any([session.controller.signal, AbortSignal.timeout(this.#timeoutMs)]);
    try {
      this.#speaker = await this.#verify(ref, signal);
      const text = (await cancelable(this.#options.recognition.transcribe(audio, signal), signal)).trim();
      signal.throwIfAborted();
      if (!text) return "silence";
      if (text.length > 16_000) throw new CallError("invalid-input");
      if (!session.recordId) {
        const opening = this.#calls.open({ reference: ref, agentId: this.#options.agentId }, signal).then(async (record) => {
          if (signal.aborted) { await this.#calls.close(record.id); signal.throwIfAborted(); }
          session.recordId = record.id;
        });
        await cancelable(opening, signal);
      }
      const reply = await cancelable(this.#calls.turn(session.recordId!, ref.participantId, text), signal);
      const output = copyPcm(await cancelable(this.#options.synthesis.synthesize(reply.text, signal), signal));
      try {
        await this.#verify(ref, signal);
        signal.throwIfAborted();
        await cancelable(this.#options.transport.publish(output, signal), signal);
        signal.throwIfAborted();
      } finally { output.samples.fill(0); }
      return "replied";
    } catch (error) { await this.endSession(); throw error; }
    finally { audio.samples.fill(0); this.#speaker = undefined; this.#busy = false; }
  }

  async #verify(reference: ParticipantReference, signal: AbortSignal): Promise<VerifiedParticipant> {
    signal.throwIfAborted();
    const proof = await cancelable(this.#options.verifier.verify(reference, signal), signal);
    signal.throwIfAborted();
    const caller = authorizeParticipant(this.#policy, reference, proof, this.#now());
    if (this.#speaker && (caller.userId !== this.#speaker.userId || caller.deviceId !== this.#speaker.deviceId)) {
      throw new CallError("identity-mismatch");
    }
    return caller;
  }

  endSession(): Promise<void> {
    if (this.#closing) return this.#closing;
    const session = this.#session;
    if (!session) return Promise.resolve();
    session.controller.abort(new CallError("call-closed")); this.#session = undefined;
    this.#closing = (session.recordId ? this.#calls.close(session.recordId) : Promise.resolve())
      .finally(() => { this.#closing = undefined; });
    return this.#closing;
  }
}
