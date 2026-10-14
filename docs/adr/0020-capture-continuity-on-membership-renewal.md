# ADR 0020: Capture continuity on membership renewal

## Status

Accepted. Refines capture handling in [ADR 0009](0009-bounded-portable-voice-turns.md). Outbound publication retains the reauthorization requirements of [ADR 0017](0017-reauthorized-playback-resume.md).

## Date

2026-10-14.

## Context

MatrixRTC emits membership changes when an existing participation extends its expiry. Resetting capture on every such notification discards partial speech, including speech awaiting the endpointer's trailing silence. A CI failure recorded voiced English input followed by a capture reset, without another admitted utterance or agent dispatch. The aggregate trace identifies a capture-loss candidate, not proof that every intermittent failure has the same cause.

## Decision

Compare immutable snapshots of the complete membership set. Preserve bounded capture only when the local service remains joined, every prior and current member is active, and each participant keeps the same Matrix user, device, member ID, backend identity and creation timestamp. Ordering is irrelevant. Both finite lifetimes must remain finite and must not decrease; two unchanged unbounded lifetimes are allowed. Invalid clocks or timestamps, duplicates, added or removed participants, replacement participation, expired membership, shortened lifetime or a changed lifetime representation reset the inbox and segmenters.

This comparison grants no authority. Every capture chunk still requires current local participation and admitted remote keys. Every completed utterance still passes the current Matrix/device/encrypted-track verifier. The inbox retains its existing proof expiry and three-second storage bound; renewal never extends a stored proof. Outbound media always suspends and reauthorizes on a membership notification.

## Alternatives considered

- Unconditionally clearing capture loses a valid utterance during routine renewal.
- Ignoring all membership notifications would retain partial speech across revocation or a new participation.
- Extending test membership durations or replaying input would conceal the production failure.
- Retaining a queue or retrying old PCM would violate bounded, current-authority input handling.

## Consequences

An unchanged active participation can finish one bounded utterance across renewal. A revoked or replaced participation cannot inherit that partial utterance. Regression tests use the real PCM segmenter and verified inbox to distinguish preserved speech from discarded prefixes. Actual encrypted-call and sustained-call evidence remains necessary; this change does not resolve unrelated enrollment or rejoin failures.
