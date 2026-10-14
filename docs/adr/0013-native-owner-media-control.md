# ADR 0013: Native owner media control through the portable worker API

## Status

Accepted.

## Date

2026-10-14.

## Context

The native package already owns a signed delegated agent service, while Matrix media runs in a separate portable worker. Operators need a supported call entry point without introducing a private SDK dependency or allowing agent text to manufacture owner authority.

## Decision

Register an optional Gateway-owned worker-control service using the client and session contract from [ADR 0012](0012-owned-worker-control-sessions.md). Expose strict status/join/leave operations through an `operator.admin` Gateway method and a Matrix-only command requiring the host's authorized sender and exact current owner Matrix ID. Recheck live authority after asynchronous work.

Use separate external control and agent secrets. Perform capability negotiation and every operation through the public managed background context. Serialize lifecycle transitions, retain candidate session IDs before dispatch, and close only exact owned candidates during disposal. Bound pending operations and retained ownership without eviction. Cleanup failure blocks replacement.

No model-call tool, transcript role, display name or `senderIsOwner` flag can grant control authority. Agent ingress remains delegated and tool-free under [ADR 0004](0004-delegated-openclaw-ingress.md). Media control does not establish voice readiness.

## Alternatives considered

- Calling browser or RTC SDKs inside the native plugin couples host lifecycle to vendor-specific media resources.
- Closing the worker's current status session can terminate independently started work after a lost response or replacement.
- Letting a model supply room, role or execution authority bypasses the trusted host and transport boundaries.
- Automatic retry or audience renegotiation can dispatch a second join or attach old ownership to a new worker incarnation.

## Consequences

Core and worker remain free of OpenClaw imports. The native wrapper depends only on the public pinned SDK and portable worker client. A different agent runtime can use the same signed control protocol.

Operators must provision the worker separately and coordinate restart/reload with agent and media lifecycles. General-user approval, automatic incoming calls, coordinated replacement, clean setup and real released-client spoken turns remain separate work. Current call capability metadata stays unavailable until assistant readiness has completed evidence.
