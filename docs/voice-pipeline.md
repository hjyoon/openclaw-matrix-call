# Portable voice pipeline

`VoiceAssistant` accepts a participant reference and a bounded mono PCM utterance from a trusted transport. It is independent of OpenClaw, Matrix SDKs and speech providers. Its injected verifier supplies current identity and encryption proofs; no text or HTTP request establishes caller permissions.

Each nonempty turn runs these steps:

1. Copy the PCM input and authorize the current participant against the owner and room policy.
2. Transcribe through the recognition port. Silence does not create an agent conversation.
3. Open a new neutral conversation UUID if necessary. Reverify the same user and device before agent dispatch.
4. Send the transcript and current call history to the configured logical agent.
5. Split the full reply into bounded text pieces. Reverify the speaker before each synthesis and encrypted RTC publication.
6. Clear owned input and output sample arrays after completion.

Only one turn can run at a time. Additional utterances return `busy` and are dropped. The total deadline defaults to 90 seconds and can be configured between 1 and 300,000 milliseconds. Providers receive the combined call cancellation and deadline signal. The coordinator returns on cancellation even if a provider is slow to honor that signal, and ignores late results. A transport must stop playback when its signal is aborted.

`endSession()` cancels current work and persists a closed conversation. Call-opening cancellation cannot restore a late verification result or leave a persisted active record. A failure closes the current conversation. The next accepted utterance starts a new UUID. History belongs to the call, not an individual user; all configured owners in that call can contribute turns. No caller authority is inherited from the previous speaker.

The browser application uses a one-record volatile store. The general `MemoryConversationStore` defaults to at most 1,024 records, evicting the oldest insertion when a new record exceeds its configured capacity. An injected durable store can export the neutral conversation schema independently of agent runtime. Importing history does not reopen a call.

Each synthesis and publication remains limited to ten seconds. The coordinator splits text into at most 64 graphemes per piece, preferring word/punctuation boundaries and preserving Unicode graphemes. Only an explicit portable `synthesis-too-long` error causes further subdivision; a one-grapheme limit is terminal. HTTP limits require a strict signed response bound to the same request ID. Generic errors never trigger model or speech retries.

One reply may use at most 64 synthesis attempts and sixty seconds of generated audio, inside the existing total deadline. Generation and publication are sequential, with fresh same-user/device verification before both. Revocation or cancellation prevents later pieces. Transferred provider samples, playback copies and late canceled synthesis results are wiped. Excessive replies fail without silent text truncation; playback may already have delivered earlier pieces before a later failure or budget limit.

One complete agent text reply remains in history even when speech is segmented or later fails. History does not claim audio delivery. Unbroken tokens may need hard splits, and synthesis providers determine pronunciation and pauses. Transcript retention depends on the selected conversation store and provider.

See [speech protocol](speech-protocol.md), [ADR 0009](adr/0009-bounded-portable-voice-turns.md) and [ADR 0016](adr/0016-bounded-segmented-speech.md).

An optional [local speech worker](speech-worker.md) supplies these ports using pinned CPU engines through the same signed protocol. Separate [speech checks](speech-integration.md) use public clips and fixture identity/transport. The [native Matrix check](native-matrix-integration.md) and optional [live-model check](live-model-integration.md) additionally cover real Matrix identity, engines and encrypted output. Evidence for newly segmented long replies must be recorded separately; earlier short-reply results do not establish it.

## Audio collection

The browser worklet emits 20ms mono floating point chunks at the audio context rate. It reads the actual quantum length rather than assuming 128 samples, using the [Web Audio processing interface](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process). At most one message can be pending until the main thread acknowledges it. A reset changes the capture epoch, discards partial input and rejects acknowledgments from an older epoch.

The portable segmenter clips and converts finite samples to signed PCM. It keeps up to 200ms of pre-roll, requires at least 200ms of sound above RMS 0.012, and ends an utterance after 600ms of silence or ten seconds of accumulated audio. Short noises are discarded. This is an energy detector, not a speech classifier; recognition remains responsible for deciding whether the input contains words. A maximum-length utterance drops at most the remainder of its final capture chunk. Resetting capture clears the segmenter's buffers.

Capture graphs use the SDK's actual remote microphone track. Each chunk requires that publication to remain encrypted, the participant's publications to remain encrypted, a live source track, and permission from the runtime. Revocation clears partial speech. Each backend participant has at most one capture graph, with a maximum of 16 graphs per worker. Replacing or unsubscribing a track releases its source, node and message port. Worklet processing and graph failures end the call. The graph emits silence to the host audio output; it does not play participants through server speakers.

The private browser inbox verifies each completed utterance against current SDK membership, key admission, encrypted live audio and device trust. Verification has a three-second deadline. It retains at most one verified utterance, expiring it after three seconds or at proof expiry, whichever comes first. Taking an utterance pauses capture for the entire voice turn; resuming changes its epoch and discards buffered audio. Membership revocation, replacement, expiry, shortened lifetime, an added or removed participant and call shutdown clear the inbox. Routine renewal preserves bounded capture only when all prior and current participation bindings remain unchanged and active; it never extends a stored proof. Each chunk and completed utterance still require current authority. Outbound media reauthorizes on every membership notification. See [ADR 0020](adr/0020-capture-continuity-on-membership-renewal.md). No public HTTP audio injection endpoint exists.

The Node driver polls this inbox through its private Playwright pipe every 100ms when connected and a voice listener is configured. Delivery is serialized. The driver checks its call generation before dispatch and before resuming capture, converts the private serialized samples back to PCM, and clears its owned samples afterward. A failure from a current voice turn ends that call and emits only a fixed public code. A late failure from an older call cannot terminate a newer call.
