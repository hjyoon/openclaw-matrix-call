# Outbound calls and opening speech

The required workflow is assistant-initiated calling: ring the intended Matrix user, wait for their verified answer, then speak an opening message without waiting for microphone input. A reminder scheduler can invoke this operation later. See [ADR 0025](adr/0025-outbound-call-and-opening-speech.md).

## Signed worker contract

Source builds after alpha.1 add `POST /v1/media/dial`. It uses the existing request/response HMAC, current worker audience and replay protection. Its strict JSON body contains `roomId`, `recipientId`, `message`, optional `sessionId` and `ringTimeoutMs` (1000–60000 ms, default 20000). Opening messages are trimmed, nonempty and bounded to 1000 characters. Endpoints, credentials and caller roles are not request fields.

The controller requires explicitly configured rooms and recipients plus an injected outbound transport. Capabilities advertise `outboundCalls: true` only when that support is present. A client does not send dial requests to a worker lacking the capability. Unknown recipients and rooms fail before transport admission.

The operation shares the existing call slot and retained session-ID ledger. Status reports `ringing` during the operation and `connected` after the transport has completed answer handling and opening speech. Results must match the exact requested room/session. Cancellation, errors and timeout retain the existing owned cleanup rules. The overall worker deadline includes the ringing budget plus its existing connection/cleanup budget; configure the controlling client's timeout accordingly.

## Implementation status

The portable contract, authenticated client/server and bounded controller are implemented and covered by actual signed HTTP tests. Browser ringing, answer verification, first speech and native agent entry are under implementation. The installed public alpha.1 remains unchanged and does not implement this operation. No live incoming-call notification has been sent for this change yet.
