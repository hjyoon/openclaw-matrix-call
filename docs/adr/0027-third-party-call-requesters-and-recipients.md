# ADR 0027: Separate call requesters from recipients

Status: Accepted

Date: 2026-10-15

Partially supersedes [ADR 0026](0026-authenticated-self-calls.md): ordinary-user recipients are no longer necessarily the requester.

## Context

Any admitted Matrix user must be able to ask the assistant to call another person and speak first. The authenticated requester establishes who owns a request; it does not require the call recipient to be that same person. Treating both as one identity either blocks this use case or grants the requester voice authority in someone else's room.

## Decision

Add `channels.matrix-call.thirdPartyCalls`, disabled by default and requiring `selfCalls: true`. Operators can explicitly enable ordinary-user recipient selection without adding requesters or recipients to administrator lists. The existing self-only behavior remains available when this option is false.

The trusted current Matrix sender remains the requester. A dial can specify an exact recipient Matrix ID; omission continues to mean the requester. A display name, message-supplied role or tool argument cannot change the requester. Resolve the existing encrypted two-person bot room for the selected recipient, checking actual membership and existing device verification. A preferred room is a hint and never substitutes for these checks. Do not create rooms, invite recipients or trust devices automatically.

Record requester and recipient separately. General-user status and exact-session leave belong to the requester. The callee can end the media call in their own client; answering does not grant control over the requester's other sessions or administrator operations. Only the recipient and their private room receive the ephemeral, delegated, tool-free voice participant policy. Preserve explicit administrator RPC and owner-command management.

Reuse the existing signed worker discovery and dial protocol. Its legacy `selfCall` wire flag selects verified dynamic private-room admission; the native adapter now applies the separately configured recipient-selection policy before signing it. The worker never accepts unsigned model-supplied authority. This change needs no browser or speech runtime modification.

Provide `/matrixcall call-to <recipient-id> <opening-message>` for hosts that admit that command. Natural model invocation remains the ordinary-user path when host slash-command authorization is narrower than Matrix messaging admission.

## Alternatives considered

- Adding all requesters and callees to control owners grants unrelated administrative operations.
- Treating the callee as the requester loses the authenticated request owner's status and cancellation boundary.
- Silently broadening existing self-call settings changes recipient permissions on upgrade without an operator decision.

## Consequences

An ordinary requester can ask the bot to ring another enrolled Matrix recipient, speak after a verified answer and cancel their own request. Recipient readiness is independent of requester readiness. Missing recipient setup fails before dialing. One active call, no automatic retries, and no scheduling remain the limits. Existing installations do not gain third-party dialing merely by updating the package. Real-client outgoing ringing and intelligible speech still require separate evidence.
