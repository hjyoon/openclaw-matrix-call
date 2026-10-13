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
