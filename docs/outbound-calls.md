# Outbound calls and opening speech

The required workflow is assistant-initiated calling: ring the intended Matrix user, wait for their verified answer, then speak an opening message without waiting for microphone input. A reminder scheduler can invoke this operation later. See [ADR 0025](adr/0025-outbound-call-and-opening-speech.md).

## Signed worker contract

The unpublished alpha.4 source candidate supports `POST /v1/media/dial`. Use an outbound-capable worker with signed capabilities; the immutable public alpha.1 does not support the new operation or extended capabilities. It uses the existing request/response HMAC, current worker audience and replay protection. Its strict JSON body contains `roomId`, `recipientId`, `message`, optional `sessionId` and `ringTimeoutMs` (1000–60000 ms, default 20000). Opening messages are trimmed, nonempty and bounded to 1000 characters. Endpoints, credentials and caller roles are not request fields.

The controller requires explicitly configured rooms and recipients plus an injected outbound transport. Capabilities advertise `outboundCalls: true` only when that support is present. A client does not send dial requests to a worker lacking the capability. Unknown recipients and rooms fail before transport admission.

The operation shares the existing call slot and retained session-ID ledger. Status reports `ringing` during the operation and `connected` after the transport has completed answer handling and opening speech. Results must match the exact requested room/session. Cancellation, errors and timeout retain the existing owned cleanup rules. The overall worker deadline includes the ringing budget plus its existing connection/cleanup budget; configure the controlling client's timeout accordingly.

## Implementation status

The portable contract, authenticated client/server, bounded controller and browser implementation are covered by automated tests. The browser sends a MatrixRTC ringing notification bound to its own current membership and waits for the SDK's successful-send event. It accepts an answer only from the configured recipient's verified device, in an encrypted two-person room without an existing call. It then synthesizes and publishes the opening message without a microphone utterance or agent turn. Incoming utterances remain paused during the opening sequence.

Native source builds expose the same operation through administrator `/matrixcall dial`, the administrator RPC and an optional V2 `matrix_call` model tool. The tool supports ordinary requesters with separately configured self-call and third-party-call policy. [Native control](native-worker-control.md) documents trusted invocation context and opt-in. The [isolated outbound check](outbound-call-integration.md) passes actual Matrix ringing events, a verified answer, encrypted fixture audio without microphone input and unanswered-call cleanup. The installed public alpha.1 remains unchanged and does not implement this operation. Production incoming-call behavior still requires testing with the installed client.

The [installed alpha.2 candidate](installed-client-outbound-call.md) is ready with native control, outbound capabilities and normal Matrix messaging. The operator's real iPhone ringing and first-speech result is pending.

## Ordinary callers

Alpha.3 adds opt-in [authenticated self-calls](self-calls.md). Every admitted Matrix sender can request a call to themselves after private-room and device setup. Model status and leave are scoped to that caller; administrator management remains separate.

The [installed alpha.3 self-call deployment](installed-self-calls.md) enables this policy for ordinary Matrix requesters while preserving existing administrator permissions and device verification.

Alpha.4 additionally supports `channels.matrix-call.thirdPartyCalls: true` with `selfCalls: true`. An admitted requester can select another exact Matrix ID; control belongs to the requester and delegated voice participation belongs to the recipient. The existing signed alpha.3 worker protocol remains compatible. No administrator enrollment is required for either person.

The current [installed alpha.4 deployment](installed-third-party-calls.md) enables ordinary-user third-party requests, with existing recipient device verification and separate requester/callee authority.
