# ADR 0024: Container Gateway loopback networking

Status: Accepted

Date: 2026-10-15

## Context

[ADR 0021](0021-local-gateway-worker-networking.md) describes a native Linux Gateway and Docker workers sharing host loopback. An existing Gateway can instead run inside a bridge-networked container. Host networking would not reach its loopback-only agent listener, and publishing that listener alone would not change its bind address.

## Decision

For an explicitly configured same-host Docker deployment, allow browser and speech workers to join the Gateway container's network namespace using Compose `network_mode: service:<gateway-service>`. Keep separate non-root filesystems, PID namespaces, capability restrictions, private credential mounts and resource limits. Publish no worker ports. Mount only the dedicated agent/control HMAC files in the Gateway; keep model credentials and host session keys there.

Keep the workers in a separate included Compose file within the same project. Stop and remove both workers before recreating the Gateway namespace. Start the agent service and speech worker before the browser, then require authenticated readiness and native control availability. Use a bounded startup wait that includes cold Gateway initialization; do not interpret process liveness as service readiness or a fresh authentication audience as authorization to replay a call.

## Alternatives considered

- Host networking for all services: changes the existing Gateway's network exposure and unrelated deployment behavior.
- Binding the agent listener publicly: broadens its listener scope.
- A TLS reverse proxy: remains suitable for separate hosts or namespaces, with additional certificate/proxy operations.
- Sharing provider stores or a Docker socket: grants unrelated host and model authority.

## Consequences

This optional route shares network access and service lifetime dependencies. It does not share process/filesystem authority or grant a Gateway token to workers. A Gateway container replacement requires coordinated worker replacement and fresh capability negotiation. Current deployment evidence establishes signed readiness and control with an enrolled device; actual installed-client audio remains a separate gate.

The pinned Gateway's live reload can impose a shorter service-start deadline than configured initial discovery. An absent/enrolling browser exceeded its observed 5000 ms deadline. Use a coordinated cold Gateway restart for this replacement path; a saved enabled setting does not establish runtime activation.
