# Agent HTTP protocol

A self-hosted agent service can implement this protocol using any agent framework or model provider. It needs no OpenClaw package, ClawHub account, or hosted AI account. The TypeScript agent port is another option for in-process integration.

The configured base URL ends at the service's agent API namespace. The adapter requests `GET <base>/capabilities` and then `POST <base>/turns`. Redirects are rejected. HTTPS is the default for remote hosts; explicitly permit plaintext HTTP only for a controlled private connection. Loopback HTTP is supported for local development.

## Capabilities

The capability response declares `protocolVersion: 1`, a fresh process `audience` UUID, and `historyMode`, either `messages` or `host-session`. It is signed using the dedicated secret and the response authentication format in [HTTP authentication](http-authentication.md).

In `messages` mode every turn includes all successful text exchanges in that call. A stateless service can generate its response directly from those messages. In `host-session` mode the service may retain internal state, but it must bind that state to the neutral conversation UUID and preserve call isolation. Internal host session identifiers stay within the adapter.

## Turn request

The JSON body contains `protocolVersion`, `conversationId`, `turnId`, `agentId`, `caller`, and ordered `messages`. The caller includes verified Matrix user/device and media-participant identity, the room, transport session, membership expiry, device trust, and encryption status. Messages contain `role`, `text`, `senderId`, and `timestampMs`.

Only the trusted calling worker supplies identity evidence after verification. Request authentication establishes trust in that worker, not in an arbitrary client that copies this JSON. The agent service must enforce its own owner mapping and tool approvals. Never translate a reported owner name into operator authority without that authenticated trust boundary.

The request is signed as `POST` using the exact path and UTF-8 body. Maximum serialized request size is 2,000,000 bytes. Per-message text is bounded to 16,000 characters and history to 256 messages. A service may apply smaller documented model-context limits.

## Turn response

A successful response is HTTP 200 with `protocolVersion: 1`, the same `conversationId` and `turnId`, and `text`. Sign it as `RESPONSE_200` using the original request path. The adapter verifies the signature and both identifiers before exposing the reply. Responses are limited to 100,000 bytes and 16,000 text characters.

Turn identifiers are idempotency keys. Services must not execute an already accepted turn twice. The adapter never retries a failed request automatically. Cancellation aborts the HTTP request; services must also propagate disconnect or cancellation to their agent host. External tool actions that completed before cancellation are not rolled back.

Tool requests, approval grants, model credentials, and provider-private reasoning are intentionally absent from the wire contract. Configure them in the selected agent host; the caller transcript cannot expand its permissions.
