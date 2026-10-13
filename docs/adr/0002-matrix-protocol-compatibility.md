# ADR 0002: Matrix protocol compatibility

Status: Accepted

Date: 2026-10-13

## Context

The initial description focused on Element Call because the existing server uses Element and MatrixRTC with LiveKit. The project owner expanded the target to Matrix protocol implementations independent of the client brand.

## Decision

Define support by negotiated and tested calling capabilities. Keep MatrixRTC and legacy Matrix VoIP in separate transport adapters using the same verified-participant and audio interfaces. Avoid mandatory Element widgets, user agents, or service URLs.

Document actual protocol, encryption, and client-version evidence. A client supporting Matrix messaging alone is not sufficient evidence of calling interoperability.

## Alternatives considered

- An Element-only integration: conflicts with the expanded compatibility requirement.
- Silently converting a legacy call invite into a MatrixRTC conference: can break caller expectations and lacks equivalent negotiation semantics.
- Claiming all Matrix clients are supported without testing: ignores differences in calling and encryption capabilities.

## Consequences

Legacy VoIP requires SDP/ICE and direct WebRTC work beyond the MatrixRTC conference adapter. Encryption must be validated for each transport. Both transport families are implementation targets; neither currently has a passing real audio test in this repository.
