# ADR 0007: Explicit MatrixRTC focus authorization

Status: Accepted

The implementation's legacy discovery-format requirement is refined by [ADR 0018](0018-modern-livekit-transport-config.md). Authorization and credential boundaries below remain current.

[ADR 0023](0023-explicit-legacy-focus-room-encoding.md) adds an explicit operator-selected older room encoding without changing these authorization boundaries.

Date: 2026-10-13

## Context

The existing real audio harness minted SFU tokens directly. An executable transport must obtain tokens through a MatrixRTC authorization service without receiving SFU signing credentials or Gateway credentials.

The pinned Matrix SDK 43.0.0 exposes an experimental homeserver-mediated token request with a `member` object. Authorization service 0.8.0 changed that endpoint to `member_id`. Silently substituting request formats or falling back after authorization failure would obscure compatibility and trust boundaries.

The tested MatrixRTC mode uses state membership and the room-wide slot. Authorization service 0.8.0 retains the OpenID `/sfu/get` endpoint for this mode and validates the OpenID subject against its issuer. OpenID authenticates the Matrix user; its claimed device field is not device-verification evidence.

## Decision

Implement the explicit OpenID authorization mode first. Obtain OpenID tokens through the public Matrix client API and exchange them only with configured trusted focus URLs. Require configured trusted SFU URLs in the response, a token subject matching the SDK's local backend identity, the expected room, a valid expiry, and call-scoped media grants. Let the SFU validate the JWT signature during connection. JWT payload inspection is a consistency check, never caller authority.

Select an existing call's advertised focus only if it is allowed by configuration. Never forward credentials to an arbitrary room-advertised URL, follow redirects, accept a different SFU, or use an SFU administrative key in the worker. Require TLS except for explicitly enabled loopback test endpoints. Bound response sizes, timeouts, and cancellation. Recheck membership after asynchronous authorization.

Keep authenticated participant/device verification and media encryption independent of focus tokens. Homeserver-mediated MSC4195 and sticky membership require a separately tested compatibility mode; an authorization failure must not trigger a protocol downgrade.

## Alternatives considered

- Giving the worker an SFU signing key: grants unnecessary server authority and prevents independent authorization-service operation.
- Automatically forwarding OpenID to any advertised focus: lets room metadata redirect credentials outside the operator's trust boundary.
- Sending the SDK's experimental request unchanged to service 0.8.0: uses incompatible request formats.
- Treating the token's claimed device as verified: loses the authenticated Matrix crypto/device boundary.

## Consequences

The initial transport requires explicitly configured focus and SFU endpoints and the tested room-wide state-membership mode. The legacy standalone endpoint does not enforce Matrix room membership on the server; the adapter must require current SDK membership and its own room/caller policy. The service remains replaceable through the authorization port. The worker cannot create administrative tokens or infer caller permissions from a token.

## Evidence

- [Authorization service 0.8.0 release](https://github.com/element-hq/lk-jwt-service/releases/tag/v0.8.0).
- [Versioned request definitions](https://github.com/element-hq/lk-jwt-service/blob/v0.8.0/src/requests.rs).
- [Versioned authorization handlers](https://github.com/element-hq/lk-jwt-service/blob/v0.8.0/src/handler.rs).
- Published Matrix SDK 43.0.0 `MatrixClient.getOpenIdToken` and `_unstable_getLivekitToken` declarations.
