# Portable voice pipeline

`VoiceAssistant` accepts a participant reference and a bounded mono PCM utterance from a trusted transport. It is independent of OpenClaw, Matrix SDKs and speech providers. Its injected verifier supplies current identity and encryption proofs; no text or HTTP request establishes caller permissions.

Each nonempty turn runs these steps:

1. Copy the PCM input and authorize the current participant against the owner and room policy.
2. Transcribe through the recognition port. Silence does not create an agent conversation.
3. Open a new neutral conversation UUID if necessary. Reverify the same user and device before agent dispatch.
4. Send the transcript and current call history to the configured logical agent.
5. Synthesize the bounded reply. Reverify the speaker before encrypted RTC publishing.
6. Clear owned input and output sample arrays after completion.

Only one turn can run at a time. Additional utterances return `busy` and are dropped. The total deadline defaults to 90 seconds and can be configured between 1 and 300,000 milliseconds. Providers receive the combined call cancellation and deadline signal. The coordinator returns on cancellation even if a provider is slow to honor that signal, and ignores late results. A transport must stop playback when its signal is aborted.

`endSession()` cancels current work and persists a closed conversation. Call-opening cancellation cannot restore a late verification result or leave a persisted active record. A failure closes the current conversation. The next accepted utterance starts a new UUID. History belongs to the call, not an individual user; all configured owners in that call can contribute turns. No caller authority is inherited from the previous speaker.

The browser application uses a one-record volatile store. The general `MemoryConversationStore` defaults to at most 1,024 records, evicting the oldest insertion when a new record exceeds its configured capacity. An injected durable store can export the neutral conversation schema independently of agent runtime. Importing history does not reopen a call.

Synthesis is limited to ten seconds per reply. A bridge must generate a response within that bound or reject it. A successfully generated text reply can appear in history even if synthesis or playback later fails; history does not claim audio delivery. Audio samples are ephemeral. Transcript retention depends on the selected conversation store and provider.

See [speech protocol](speech-protocol.md) and [ADR 0009](adr/0009-bounded-portable-voice-turns.md).

## Audio collection

The browser worklet emits 20ms mono floating point chunks at the audio context rate. It reads the actual quantum length rather than assuming 128 samples, using the [Web Audio processing interface](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process). At most one message can be pending until the main thread acknowledges it. A reset changes the capture epoch, discards partial input and rejects acknowledgments from an older epoch.

The portable segmenter clips and converts finite samples to signed PCM. It keeps up to 200ms of pre-roll, requires at least 200ms of sound above RMS 0.012, and ends an utterance after 600ms of silence or ten seconds of accumulated audio. Short noises are discarded. This is an energy detector, not a speech classifier; recognition remains responsible for deciding whether the input contains words. A maximum-length utterance drops at most the remainder of its final capture chunk. Resetting capture clears the segmenter's buffers.

Capture graphs use the SDK's actual remote microphone track, require an encrypted publication and discard chunks unless the runtime permits the participant. Each backend participant has at most one capture graph, with a maximum of 16 graphs per worker. Replacing or unsubscribing a track releases its source, node and message port. Worklet processing and graph failures end the call. The graph emits silence to the host audio output; it does not play participants through server speakers.

The private browser inbox verifies each completed utterance against current SDK membership, key admission, encrypted live audio and device trust. Verification has a three-second deadline. It retains at most one verified utterance, expiring it after three seconds or at proof expiry, whichever comes first. Taking an utterance pauses capture for the entire voice turn; resuming changes its epoch and discards buffered audio. Membership changes and call shutdown clear the inbox. No public HTTP audio injection endpoint exists.

The Node driver polls this inbox through its private Playwright pipe every 100ms when connected and a voice listener is configured. Delivery is serialized. The driver checks its call generation before dispatch and before resuming capture, converts the private serialized samples back to PCM, and clears its owned samples afterward. A failure from a current voice turn ends that call and emits only a fixed public code. A late failure from an older call cannot terminate a newer call.
