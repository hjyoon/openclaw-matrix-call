# Architecture

The repository contains an OpenClaw channel plugin, an isolated RTC worker, and shared protocol and policy code. The first supported host target is OpenClaw 2026.10.2 on Node.js 24.16 or newer.

The plugin owns agent dispatch, call session routing, and caller policy. The worker owns Matrix device state, MatrixRTC membership, LiveKit audio, and media encryption. Speech recognition and synthesis use explicitly configured external providers.

The core and worker are host-independent. OpenClaw, MatrixRTC, LiveKit, speech, and persistence integrations use replaceable adapters as described in [Portability](portability.md).

Each call receives a new random identifier. A room identifier and an agent identifier do not define a call session. Concurrent calls must not share history or mutable active-agent state.

The worker-to-plugin boundary uses a dedicated secret and authenticated messages. The worker does not receive the Gateway operator token. Caller identity must come from verified Matrix membership and the corresponding LiveKit participant, not from speech, display names, or HTTP payload assertions alone.

Existing Matrix plugin policy is not inherited implicitly. This plugin must declare its own policy and approval integration. Gateway execution-host approvals remain authoritative.

The first release accepts explicitly configured owners in explicitly configured rooms. General-user approval is a later capability and must remain unavailable until it has an end-to-end authorization test.

Matrix message encryption and LiveKit media encryption are separate requirements. Device verification, key distribution, key rotation, and crypto persistence must be validated with Element clients. Missing encryption must fail closed.

The worker must reuse active LiveKit rooms. Starting the bot must not delete or reset another participant's call.

## Release requirements

- A native plugin package loads against the supported OpenClaw SDK.
- Unknown callers, unknown rooms, expired memberships, and replayed requests cannot dispatch an agent turn.
- Independent calls remain isolated during concurrency, cancellation, reconnect, and restart.
- An encrypted Element Call can exchange actual audio in both directions.
- Secrets, media keys, and transcripts are absent from default logs and publish artifacts.
- A packed plugin installs in a clean supported Gateway.
- The worker image builds and runs without root or a Docker socket.

## Sources

- [OpenClaw channel SDK](https://docs.openclaw.ai/plugins/sdk-channel-plugins)
- [OpenClaw channel approvals](https://docs.openclaw.ai/plugins/sdk-channel-plugins/approvals)
- [ClawHub publishing](https://docs.openclaw.ai/clawhub/publishing)
- [LiveKit encryption](https://docs.livekit.io/transport/encryption/)
