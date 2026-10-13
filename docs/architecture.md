# Architecture

The repository contains an OpenClaw channel plugin, an isolated RTC worker, and shared protocol and policy code. The first supported host target is OpenClaw 2026.10.2 on Node.js 24.16 or newer.

The core owns caller policy, independent conversation records, and call lifecycle. The selected agent adapter owns dispatch to its host. The worker's transport adapter owns Matrix device state, call signaling, audio, and media encryption. Speech recognition and synthesis use explicitly configured providers, including self-hosted implementations.

The portable voice package composes the existing call coordinator with recognition, synthesis and publishing ports. Its half-duplex turns have bounded audio, one active operation and explicit cancellation. The optional browser worker obtains audio through its private automation pipe and authenticates separately configured agent and speech services before starting Matrix. See [voice pipeline](voice-pipeline.md), [speech protocol](speech-protocol.md) and [ADR 0009](adr/0009-bounded-portable-voice-turns.md).

The core and worker are host-independent. OpenClaw, MatrixRTC, legacy Matrix VoIP, LiveKit, speech, and persistence integrations use replaceable adapters as described in [Portability](portability.md). Client support is recorded by protocol capability in [Matrix compatibility](matrix-compatibility.md).

Each call receives a new random identifier. A room identifier and an agent identifier do not define a call session. Concurrent calls must not share history or mutable active-agent state.

The worker-to-plugin boundary uses a dedicated secret and authenticated messages. The worker does not receive the Gateway operator token. Caller identity must come from verified Matrix membership and the corresponding LiveKit participant, not from speech, display names, or HTTP payload assertions alone.

Existing Matrix plugin policy is not inherited implicitly. This plugin must declare its own policy and approval integration. Gateway execution-host approvals remain authoritative.

The first release accepts explicitly configured owners in explicitly configured rooms. General-user approval is a later capability and must remain unavailable until it has an end-to-end authorization test.

Matrix message encryption and LiveKit media encryption are separate requirements. Device verification, key distribution, key rotation, and crypto persistence must be validated with compatible Matrix clients. Missing encryption must fail closed. The optional MatrixRTC media adapter uses public browser SDKs and a dedicated persistent browser profile; see [ADR 0005](adr/0005-browser-matrixrtc-media.md). Outbound keys are generated inside the adapter, with authenticated inbound admission; see [ADR 0006](adr/0006-local-outbound-key-provenance.md).

The worker must reuse active LiveKit rooms. Starting the bot must not delete or reset another participant's call.

## Release requirements

- A native plugin package loads against the supported OpenClaw SDK.
- Unknown callers, unknown rooms, expired memberships, and replayed requests cannot dispatch an agent turn.
- Independent calls remain isolated during concurrency, cancellation, reconnect, and restart.
- A compatible encrypted MatrixRTC call can exchange actual audio in both directions, with client versions recorded.
- Secrets, media keys, and transcripts are absent from default logs and publish artifacts.
- A packed plugin installs in a clean supported Gateway.
- The worker image builds and runs without root or a Docker socket.

## Sources

- [OpenClaw channel SDK](https://docs.openclaw.ai/plugins/sdk-channel-plugins)
- [OpenClaw channel approvals](https://docs.openclaw.ai/plugins/sdk-channel-plugins/approvals)
- [ClawHub publishing](https://docs.openclaw.ai/clawhub/publishing)
- [LiveKit encryption](https://docs.livekit.io/transport/encryption/)
