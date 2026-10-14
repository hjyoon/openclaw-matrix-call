# ADR 0014: Bounded initial worker discovery

## Status

Accepted. Extends the startup behavior of [ADR 0013](0013-native-owner-media-control.md).

## Date

2026-10-14.

## Context

A browser voice worker authenticates agent capabilities before opening its media-control listener. The same Gateway owns that agent service and worker control. Requiring the listener to exist before Gateway startup creates a deployment dependency cycle; changing channel settings afterward also rotates the agent audience.

## Decision

Start the agent service first. During one fresh worker-control startup, retry only a refused TCP connection while authenticating capabilities. Use 100 ms intervals and one overall configured deadline covering attempts and streamed bodies. Authentication, protocol, file, TLS and other failures remain terminal.

No media operation or retained-ownership cleanup is retried or reconnected under this rule. A connected client's audience remains fixed. Failure to clean old owned sessions still blocks service replacement before discovery starts.

## Alternatives considered

- Changing worker configuration after browser startup rotates the agent audience and invalidates its initialized voice adapter.
- Retrying joins or silently reconnecting an existing client can duplicate work or attach ownership to a replacement worker.
- Launching browser containers from the Gateway couples deployment and media lifecycle to the native adapter.

## Consequences

An independently supervised worker can start after the agent listener and complete the dependency chain within the configured startup budget. The native service still does not create or enroll a worker. Supervisors must allow startup and shutdown deadlines; coordinated replacement remains separate work. Real encrypted-media integration must check this ordering rather than infer it from fixture readiness.
