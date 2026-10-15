# Outbound MatrixRTC integration

On 2026-10-15, `pnpm verify:matrix-outbound` (`MATRIX_CALL_OUTBOUND=1 pnpm verify:matrix`) passed with disposable accounts and infrastructure. The stack was Synapse 1.162.0, matrix-js-sdk 43.0.0, Chromium 156.0.8078.4, authorization service 0.8.0 and LiveKit 1.13.9. The test uses the production browser worker and signed worker HTTP client.

The caller and recipient occupy a private encrypted two-person room with no existing call. A signed dial request causes the recipient's independent SDK browser to receive an actual MatrixRTC `ring` notification, bound to the caller membership and configured lifetime. Before the recipient joins, status is `ringing` and no speech synthesis occurs.

The recipient answers by joining the MatrixRTC session and encrypted SFU audio, publishes a silent audio track and shares authenticated media keys. Both devices use explicitly compared test enrollment keys. Without a microphone utterance or model turn, the worker synthesizes the supplied opening text and the recipient measures the resulting encrypted 1320 Hz fixture audio. Exact-session leave clears the owned worker slot. A subsequent unanswered call expires and eventually clears its closing session without another synthesis or automatic retry.

Speech and agent services in this check are authenticated protocol fixtures. The tone measures the media route; it is not intelligible real TTS or proof that an installed phone rings. Existing bidirectional voice, persistence and restart/rejoin checks also pass in this run. Installed-client ringing and real spoken opening require separate evidence. Legacy VoIP and sticky membership are not covered.

## Actual owner chat to model tool

`pnpm verify:matrix-commands` also passes with the packed alpha.2 candidate installed alongside the official Matrix 2026.10.2 messaging plugin in a disposable native Gateway. The manifest declares `contracts.tools: ["matrix_call"]`, and the minimal host tool profile explicitly opts in through `tools.alsoAllow`.

The homeserver-authenticated owner sends a normal message, and the deterministic model provider receives `matrix_call` in its tool catalog. Its function call reaches signed worker dialing exactly once. A separately allowed visitor with the owner's display name and forged role fields never receives that tool; an attempted model function call has no dialing effect. Exact-session leave succeeds, literal commands still invoke no model, and Gateway shutdown cleans only its owned session.

The run records 17 chat replies, three ordinary joins, one outbound dial and four completed disconnects. Its model and media transport are fixtures, and its Matrix chat is unencrypted. The separate RTC check above supplies encrypted ringing/answer/audio evidence; this test establishes native routing and authority rather than phone interoperability.
