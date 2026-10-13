# Matrix compatibility

The project targets Matrix calling protocols. It must not require an Element client, an Element widget, an Element user agent, or a hardcoded Element service URL. Homeserver and RTC focus discovery belong to the configured transport adapter.

Matrix messaging support does not imply that a client implements a compatible calling protocol. Support is negotiated and tested by capability. A missing transport or an incompatible encryption mode produces an explicit unsupported result rather than silently weakening security.

## Transport families

| Protocol | Adapter responsibility | Current implementation |
| --- | --- | --- |
| MatrixRTC | Membership, focus discovery, authenticated participant binding, conference media, encryption keys | Planned; no audio interoperability claim |
| Matrix VoIP | `m.call.*` signaling, SDP/ICE negotiation, party identifiers, direct WebRTC audio | Planned; no audio interoperability claim |

MatrixRTC and legacy Matrix VoIP are separate transports. A client implementing only legacy VoIP must not be treated as a MatrixRTC client, and a legacy invite must not be converted into a conference without an explicit supported negotiation path.

Call authorization uses verified Matrix user and device identities, room identifiers, current membership, and the corresponding media participant. Display names, client names, transcripts, and caller-supplied owner flags never establish authority.

Both transports must expose the same core participant-verification and audio interfaces. Their encryption mechanisms differ, so the adapter must verify the actual mechanism used. Secure transport to an SFU alone is not proof of media confidentiality from that SFU.

## Interoperability evidence

Before a release claims support, record the client and version, homeserver and version, transport protocol, encryption mode, verification flow, and audio results. Include at least one non-Element client where an appropriate implementation exists. Check bidirectional audio, leave/rejoin, key rotation, network interruption, and independent simultaneous calls.

No client has passed this repository's audio interoperability tests yet. This document describes the implementation target and release criteria.

## Sources

- [Matrix Client-Server API: Voice over IP](https://spec.matrix.org/latest/client-server-api/#voice-over-ip)
- [MatrixRTC proposal MSC4143](https://github.com/matrix-org/matrix-spec-proposals/pull/4143)
- [LiveKit media encryption](https://docs.livekit.io/transport/encryption/)
