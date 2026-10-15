# ADR 0025: Outbound calling with opening speech

Status: Accepted

Date: 2026-10-15

## Context

Joining a call started by a person and playing operator test audio do not satisfy the requested workflow. The assistant must initiate a call, ring the intended recipient, wait for that recipient to answer and speak first without microphone input. Scheduling can later invoke this operation; it is not the operation itself.

## Decision

Add an explicit outbound operation to the signed portable worker protocol, with an exact room, recipient Matrix ID, opening message, bounded ringing deadline and caller-selected session UUID. Require an advertised outbound capability and configured room/recipient policies. Share the existing single-call slot, session ledger, current authority checks, cancellation and exact-session cleanup.

The Matrix transport must restrict ringing to a private two-party room, publish a supported RTC notification and wait for the intended participant's current verified encrypted media identity. Recheck that binding before synthesis and publication. Opening speech must not require a microphone utterance, fabricate an inbound transcript or grant agent tools. Use the existing replaceable speech port and bounded speech publication.

Expose the operation through the native administrator/owner boundary and an explicitly authorized agent tool. Tool arguments and display names cannot supply requester authority. Initial recipients remain configured owners; introducing other contacts needs explicit recipient policy rather than administrator privileges for callees.

## Alternatives considered

- Requiring a person to start a room call: does not implement outbound calling.
- Treating a room message as ringing: does not establish an incoming-call interaction.
- Speaking before the intended participant answers: can lose the announcement or disclose it to another listener.
- Using an operator debugger as the product interface: lacks a supported authenticated call operation.
- Coupling the operation to one scheduler or model provider: prevents replacing those integrations.

## Consequences

Dialing can appear as `ringing` while the signed request waits for connection and opening speech. Cancellation or deadline exhaustion cleans the owned session; failed operations are never retried automatically. Existing join behavior remains available and does not ring. Older workers without the advertised capability fail explicitly. Real-client incoming-call, encrypted playback and no-answer evidence are required before claiming this workflow works. Background push delivery is a separate client/device test.
