# ADR 0018: Modern LiveKit transport configuration

## Status

Accepted. Refines the legacy discovery format used by the implementation of [ADR 0007](0007-explicit-focus-authorization.md); its credential, endpoint, membership and token authorization boundaries remain current.

## Date

2026-10-14.

## Context

The unmodified Element Call 0.28.0 release advertises a `livekit` service configuration without `livekit_alias` in compatibility mode. Matrix SDK 43 distinguishes this configuration from the older transport shape carrying an alias. Requiring the older field rejected the call before token exchange. The legacy authorization endpoint derives the actual SFU room from the authenticated request's Matrix room, rather than trusting an advertised alias.

## Decision

Accept the SDK's service configuration with an optional legacy alias. When present, an alias must still equal the current Matrix room. Select only an explicitly trusted endpoint and keep the request bound to the current local membership. Require the returned JWT's exact local participant and protocol-derived room, expiry and non-administrative media permissions before connection.

This is a format-compatibility change to the existing authorization adapter. It does not implement independent connections to multiple SFUs, sticky membership, hashed backend identities or the newer token endpoint. Actual released-client audio must pass separately before claiming compatibility.

## Alternatives considered

Keeping the mandatory alias excludes the current public SDK configuration. Synthesizing an alias from untrusted event fields confuses discovery metadata with room authority. Removing token room checks would weaken authorization. A separate modern backend adapter remains appropriate for capabilities requiring different identity or connection semantics.

## Consequences

The same endpoint, identity, device-trust and encrypted-media checks remain mandatory. Legacy mismatched aliases are fatal. Behavior tests cover an alias-free configuration with correct scope, a wrong JWT room and an untrusted endpoint. A successful format parse alone does not establish call interoperability.

## Sources

- [Matrix SDK 43 transport types](https://github.com/matrix-org/matrix-js-sdk/blob/v43.0.0/src/matrixrtc/LivekitTransport.ts).
- [Element Call 0.28.0 authorization requests](https://github.com/element-hq/element-call/blob/v0.28.0/src/livekit/openIDSFU.ts).
