# Focus authorization

`OpenIdFocusAuthorizer` exchanges an OpenID token obtained through `MatrixClient.getOpenIdToken` with an explicitly configured focus's `/sfu/get` endpoint. The initial compatibility target is authorization service 0.8.0 and MatrixRTC state membership in room slot `m.call#ROOM`; see [ADR 0007](adr/0007-explicit-focus-authorization.md).

Configure exact trusted focus and SFU URLs. A call's SDK-selected service must match a trusted focus. The SDK's modern service configuration may omit the legacy alias; when present, that alias must equal the current Matrix room. Returned token scope remains mandatory in both cases; see [ADR 0018](adr/0018-modern-livekit-transport-config.md). URLs must use HTTPS/WSS with no embedded credentials, query, or fragment. Plain HTTP/WS requires `allowInsecureLoopback: true` and a loopback hostname. This option is for isolated tests and does not authorize arbitrary plaintext network endpoints.

Authorization requires a current local membership matching the Matrix client's user/device and the tested backend identity format. OpenID is sent only after focus selection and membership checks, and its issuer must match the local Matrix user's server name. HTTP redirects are rejected; authorization failures do not select another focus or downgrade protocols.

The returned JWT must name the local backend identity and the protocol-derived SFU room alias: unpadded base64 SHA-256 of UTF-8 JSON `[matrixRoomId, "m.call#ROOM"]`. Require a bounded future expiry and media publish/subscribe grants without administrative room grants. Decode the payload only to check consistency. The actual SFU verifies the JWT signature on connection; payload decoding does not authenticate a caller.

Requests and streaming responses share a bounded timeout and cancellation signal. Responses are limited to 64 KiB. Membership is checked again after credential lookup and token exchange. Public failures contain stable error codes, with no upstream response body or credential details.

A temporarily missing local membership or undefined SDK-selected focus returns `membership-changed` before obtaining credentials. The browser retries that condition inside its existing connection deadline. A mismatched user/device/backend identity, unsupported slot, malformed focus, or differently scoped alias remains fatal. No configured endpoint substitutes for missing selected focus metadata.

This adapter does not receive SFU signing credentials or Gateway credentials. OpenID authenticates a Matrix user and cannot verify the claimed device. The separate Matrix crypto/key admission and live-media participant verifier remain required before any agent turn.

The legacy standalone endpoint does not check Matrix room membership server-side. Current SDK membership and configured call policy must therefore be enforced by the transport. The homeserver-mediated endpoint changed request shape in service 0.8.0; it and modern sticky membership remain separate compatibility work, without an automatic fallback.
