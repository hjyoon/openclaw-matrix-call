# ADR 0023: Explicit legacy focus room encoding

Status: Accepted

Date: 2026-10-15

## Context

The first public alpha checks the authorization service 0.8.0 room alias: unpadded base64 SHA-256 of the JSON array containing the Matrix room and slot. An existing operator deployment uses authorization service 0.4.1, which hashes the room, a pipe separator and the slot instead. Both services retain the standalone OpenID exchange and user/device participant identity.

Accepting either alias automatically would make an authentication response select the expected room binding. Upgrading an operator's shared calling backend solely to deploy a worker also changes unrelated clients.

## Decision

Allow the operator to select `roomAliasFormat` in browser configuration: `json-array` by default, or `legacy-pipe` for an explicitly reviewed older backend. The portable authorizer validates this option before obtaining credentials and accepts only the selected encoding. All configured focus endpoints in one worker must use the selected format; different formats require separate worker configurations.

Keep exact trusted endpoints, current membership, participant identity, token room, expiry, media grants, device verification and encryption checks. Do not probe other encodings after a failure. The SFU still verifies the token signature.

Keep the published alpha.1 archives immutable. A deployment using this new option must identify its custom worker image by source commit and a separate image tag. Configuration/unit evidence alone does not establish encrypted audio interoperability with the older backend.

## Alternatives considered

- Accepting both encodings: makes expected authentication scope negotiable by the response.
- Disabling room checks: permits a differently scoped grant.
- Upgrading shared authorization infrastructure: expands the deployment beyond the plugin and workers.
- Adding a separate modern authorization endpoint: does not place existing clients in the same backend room.

## Consequences

The existing default and public alpha.1 behavior remain unchanged. A worker can target the older room derivation without receiving signing credentials or changing the shared service. Operators must inspect their backend version and select its format deliberately. Real encrypted client evidence remains required before claiming support.

## Evidence

- [Authorization service 0.4.1 legacy handler](https://github.com/element-hq/lk-jwt-service/blob/v0.4.1/main.go#L192-L244).
- [Initial authorization boundary](0007-explicit-focus-authorization.md).
