# ADR 0017: Reauthorized playback resume

## Status

Accepted. Extends the playback behavior of [ADR 0005](0005-browser-matrixrtc-media.md) and supports [ADR 0016](0016-bounded-segmented-speech.md).

## Date

2026-10-14.

## Context

Long actual model responses exposed a playback failure during MatrixRTC membership updates. The old media suspension stopped the buffer source and resolved playback early. Even a freshly authorized update then failed the old revision comparison, dropping remaining speech.

## Decision

Suspend the outgoing track immediately on membership changes, retaining at most one bounded PCM buffer and its playback offset. Resume that remaining buffer only when the publication guard has completed fresh current membership, owner, device-trust and key-distribution checks. A stopped source's stale ended callback cannot complete a newer source.

After complete playback, require the current guard revision to remain permitted rather than requiring the starting revision to remain unchanged. A pending or failed reauthorization still rejects output. Revocation, membership/crypto/media errors, cancellation and permanent closure remain terminal. Closing or canceling paused playback releases its buffer and rejects the pending operation; browser float samples are wiped on settlement.

## Alternatives considered

- Ignoring membership updates would lose immediate revocation and fresh listener authorization.
- Resolving a suspended source as completed silently drops content.
- Restarting an entire text or PCM piece repeats already delivered speech.
- Increasing membership lifetimes only in tests would hide production behavior.

## Consequences

Legitimate participant updates can resume remaining bounded audio after reauthorization. No authority or key proof is inherited across a changed revision. The existing per-piece limit and whole-turn cancellation/deadline still bound retention. Playback remains half duplex; client pronunciation, network loss and long-call reliability require separate evaluation.
