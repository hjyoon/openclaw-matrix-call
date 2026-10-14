# ADR 0022: Authenticated pipeline readiness

## Status

Accepted. Completes the runtime readiness boundary deferred by [ADR 0008](0008-browser-worker-and-explicit-device-enrollment.md). Deployment scope remains explicit in [ADR 0021](0021-local-gateway-worker-networking.md).

## Date

2026-10-15.

## Context

The worker's liveness endpoint and native descriptor previously reported an unconditional unavailable placeholder, even when a configured pipeline completed encrypted speech. Operators need a current service check before entering a call without generating an agent turn or granting caller authority.

## Decision

Use `/healthz` for liveness only. Remove its placeholder readiness field and the corresponding startup-log field. Use `/readyz` as the authoritative readiness endpoint. Generic and media-only workers remain unavailable.

A browser assistant is ready only while its enrolled driver and media controller are available and both agent and speech services return valid authenticated protocol-v1 capabilities. Check the audience negotiated at startup; a probe never adopts a replacement service's audience. Require the same agent history mode. Capability checks invoke neither inference nor a speech engine.

Bound the complete readiness check to two seconds, including implementations that ignore cancellation. Share only an in-flight check across requests, without caching a successful result afterward. Recheck media and driver availability after asynchronous checks. Fail closed on malformed capabilities, authentication changes, unavailable services, invalid probe results or timeouts. Return fixed failure codes without private errors.

The native channel reports configured only for an enabled account with explicit policy, agent service and worker control. Configuration is separate from runtime readiness. Keep `media: false` because the descriptor has no chat-attachment transport, and keep automatic incoming calls unavailable. Every voice turn still needs fresh Matrix membership, device, key and encrypted-media authorization.

## Alternatives considered

- Returning success solely because an HTTP listener exists does not establish a working voice route.
- Running a sample model turn in a health probe creates cost, history and side effects.
- Automatically adopting a new service audience would retain an adapter across a boundary that requires explicit reconnection.
- Caching readiness indefinitely would conceal service replacement or failure.

## Consequences

Operators can distinguish liveness, complete configuration and current authenticated pipeline availability. Readiness does not promise model-account validity, recognition quality, network reliability or a latency SLA. Actual inference, client interoperability and deployment checks remain separate evidence. Service replacement requires an explicit worker recreation and never replays an old call or turn.
