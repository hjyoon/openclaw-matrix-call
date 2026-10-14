# ADR 0021: Local Gateway worker networking

## Status

Accepted. Adds an optional local route to [ADR 0010](0010-optional-local-speech-service.md); the separate speech-owned network namespace remains the default.

## Date

2026-10-15.

## Context

The native agent service binds loopback. Workers in an unrelated container namespace require a separately provisioned HTTPS route. A local Linux installation can connect a host Gateway and container workers directly without a reverse proxy.

## Decision

Provide an explicit `browser-local-gateway.compose.yml` overlay for a native Gateway on the same Linux Docker host. Both workers use host networking and publish no Docker ports. Control and speech listeners bind loopback; configurable healthcheck ports must match their listener configuration. Agent, speech and control authentication retain distinct dedicated secrets.

Keep worker filesystems, PID namespaces, non-root execution, read-only roots, dropped capabilities, Chromium sandboxing and resource limits separate. Host networking intentionally permits access to host loopback services; it is not network isolation. Never mount a Docker socket, Gateway profile, operator token or model credential into either worker.

The optional overlay targets a host-native Gateway. A containerized Gateway or remote agent needs its own validated route. It does not change caller policy, trust enrollment, media encryption or automatic call entry.

## Alternatives considered

- Requiring a reverse proxy for a same-host native Gateway adds routing and certificate setup.
- Binding the native agent service publicly expands its exposure and changes the current listener contract.
- Mounting Gateway credentials or a Docker socket into a worker would violate the agent boundary.
- Replacing default networking would change existing isolated deployments without an explicit choice.

## Consequences

The local overlay renders with unchanged filesystem and process restrictions. Complete installation, encrypted speech and coordinated replacement must pass through this exact Compose path before it becomes a supported calling deployment. The 2026-10-15 [operator integration](../operator-compose-integration.md) records those passes, including actual model replies and bounded longer image output. Other routes and platforms retain separate evidence requirements.
