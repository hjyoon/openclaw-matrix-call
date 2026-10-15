# A Gateway already running in Docker

The native Linux host-network overlay does not reach another container's loopback-only agent listener. An optional same-host route shares the existing Gateway container's network namespace with the two calling workers. See [ADR 0024](adr/0024-container-gateway-loopback-networking.md). A separate-host deployment still needs an authenticated reachable HTTPS route.

## Compose layout

Keep the existing Gateway service and messaging-browser service in their parent Compose file. Include a separate private calling Compose file in the same project. Configure both calling services with `network_mode: service:<actual-gateway-service-name>` and no published ports. Compose `include` resolves its file paths separately; validate the complete parent model with `docker compose -f <parent-file> config --quiet` before replacing a running service. Avoid printing expanded configuration containing the existing environment's credentials.

Retain the browser sandbox/seccomp profile, non-root execution, dropped capabilities, read-only worker roots, private persistent browser profile and resource limits from the supplied deployment examples. Mount only the agent and control HMAC files into the Gateway, read-only. Give speech only its speech key, configuration and verified model. Give the browser its dedicated Matrix device, profile, three separate keys and configuration. Never mount the Docker socket, Gateway operator token, model credential store or host session database into either worker.

Inside the shared namespace, bind control on `127.0.0.1:19790`, browser assets on stable port `19791`, speech on `127.0.0.1:19792` and the agent service on `127.0.0.1:19793`. Voice/control HTTP configuration must explicitly opt into loopback. This does not authorize remote plaintext focus, SFU or homeserver endpoints. Preserve the original Gateway's host binding and messaging settings.

## Installation and replacement

Back up the original Compose/environment/configuration privately and take a consistent persistent-state backup with the Gateway stopped. Review and install the exact [public plugin](publication-0.1.0-alpha.1.md), preserving unrelated plugin allowlists and channel configuration. The full CLI run inside a busy Gateway shares that container's memory limit; a temporary maintenance container can use the same persistent mounts and a bounded Node heap while the Gateway is stopped. After a killed maintenance process, let a remaining lifecycle lease expire normally instead of deleting state locks.

Use the following ordering for initial activation and replacement:

1. Stop and remove the browser and speech containers, preserving the complete browser profile and private inputs.
2. Start or recreate the Gateway with the reviewed mounts and native agent/control settings.
3. Start speech. Wait for the agent `/capabilities` listener and speech liveness with a bounded cold-start budget, for example six minutes on a small host. Listener availability alone does not authenticate capabilities.
4. Create the browser within the native control service's initial discovery budget. The browser authenticates agent/speech capabilities, enrolls its device, then opens control.
5. Require browser `/readyz` HTTP 200, administrator `matrixcall.control` availability and the original Matrix channel's connection. These checks do not run inference or prove installed-client audio.

The native control's discovery budget starts when that service starts, rather than when Docker starts the Gateway container. Waiting for a Gateway health check before starting every worker can create an unnecessary dependency cycle. A missed discovery budget needs an explicit managed-service restart; do not retry a media join or silently adopt replacement audiences. See [readiness](readiness.md) and [native worker control](native-worker-control.md).

Shared network namespaces couple replacement: restarting only a worker or recreating only the Gateway can leave a stale authenticated client or an old namespace. Use a coordinated procedure, including exact-session leave when a call is active. A normal process restart preserves no call authority or conversation history.

## Backend and evidence limits

The public alpha.1 paired images were tested with authorization service 0.8.0 and LiveKit 1.13.9. An existing 0.4.1 authorization backend uses a different room encoding. A source build can explicitly select [legacy encoding](focus-authorization.md), identified by its own image tag and source commit; never relabel that image as the immutable public alpha.1 browser archive. Leave shared Matrix/authorization/SFU services unchanged unless separately planning their migration.

A Docker Gateway deployment has passed new-device enrollment, explicit owner-device pinning, signed agent/speech readiness, native control availability and preservation of messaging connectivity. Those checks do not establish real audio with an operator's installed client/backend combination. Confirm its supported MatrixRTC membership mode, encrypted speech, model response and exact-session cleanup before claiming interoperability. General-user approval, automatic incoming calls and privileged agent tools remain unavailable.
