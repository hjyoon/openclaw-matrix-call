# ADR 0028: Verify outbound listeners independently of incoming audio

Status: Accepted

Date: 2026-10-15

Partially supersedes [ADR 0025](0025-outbound-call-and-opening-speech.md): answer admission must not depend on incoming microphone media.

## Context

An operator's iPhone rang and joined an outbound call, but the opening remained silent and the dial failed at its 60-second answer deadline. The server recorded a connected recipient and encrypted microphone publication. The previous implementation required an accepted incoming media key and a subscribed live audio track before declaring the answer ready. Those conditions can remain unavailable after the recipient answers, and they are unnecessary for a recipient who only wants to listen. The old diagnostics did not record which incoming condition remained pending.

## Decision

Add a separate portable MatrixRTC recipient verifier. It requires the exact room and supported slot, an active unambiguous Matrix membership, the matching connected SFU identity, enabled local end-to-end media encryption, fresh verified Matrix device trust and a bounded valid membership lifetime. Recheck membership and connection after asynchronous device verification. Return a recipient proof without the incoming `mediaEncrypted` assertion.

Use this verifier only for outgoing answer admission and opening-speech revalidation. Enforce the selected recipient and active local call before and after verification, retaining generation fences, private-room checks and recipient hangup cleanup. The publication guard still checks the complete listener set and delivers a fresh outgoing key only to verified devices before audio publication. No incoming recipient key, microphone publication or utterance is needed for opening speech.

Keep the existing participant verifier, incoming authenticated-key admission, encrypted live-track checks and delegated voice authorization unchanged. A recipient-only proof cannot authorize an agent input turn.

Log only fixed outbound stages and the failed stage. Do not log opening text, device keys, credentials or raw backend errors. Validate with a real encrypted Matrix/SFU call whose recipient publishes no microphone track or media key until after the opening has been received.

## Alternatives considered

- Increasing the answer timeout leaves a valid receive-only recipient waiting forever.
- Requiring the user to unmute or speak conflicts with assistant-initiated opening speech.
- Loosening the shared input verifier would allow unverified or unencrypted agent input.

## Consequences

Opening speech can start after a verified listener answers while voice input retains its existing stronger media proof. Device enrollment and administrator/requester/recipient boundaries remain unchanged. This fixes an unnecessary admission dependency; installed-client audibility still needs a new operator result.
