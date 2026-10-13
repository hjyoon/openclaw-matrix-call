# Worker media control

`WorkerMediaController` manages one media transport per worker. It accepts only explicitly configured opaque Matrix room IDs and creates a new random session ID for every connection. The backend implements the portable `RtcTransportPort` connection/shutdown methods; the worker does not import Matrix, LiveKit, OpenClaw, or an agent framework.

Requests cannot supply caller roles, device-verification flags, model settings, or backend URLs. Matrix identity and media verification remain inside the transport. Media connection is not an agent turn, and its success does not establish assistant readiness.

Capacity is reserved before asynchronous connection starts. Concurrent joins are rejected. Cancellation or a connection timeout returns promptly, while the reservation remains until the backend finishes and cleanup completes. A late connection cannot replace another active session. Connection errors are redacted and trigger cleanup. Cleanup failure closes the controller permanently, requiring a fresh worker/transport instead of assuming the old connection is gone.

The connection deadline applies only to opening media. Completing an HTTP operation must not abort the connected session, and its connection timer is cleared after opening. Leaving requires the exact active session ID. Concurrent leave/shutdown operations share the same backend cleanup. Shutdown blocks new joins, aborts an in-flight connection, and waits for cleanup.

Backend drivers must honor the connection abort signal and release their browser/media resources when disconnected. A driver must create new media/key resources for a new call while preserving only its private Matrix crypto profile. A transport that never settles after cancellation cannot be safely reused; the controller retains its reservation.

Adapters can call `endSession()` when the backend ends a call. It shares the existing cancellation and cleanup path and releases the active reservation without treating a status message as caller authority. `startWorker` accepts an optional close hook for idle backend resources and invokes it even when media cleanup fails.

The control layer does not create, reset, or delete an SFU room. It delegates connection to the configured transport. Agent ingress, STT/TTS, speaker authorization, and listener-aware publication/key rotation remain separate runtime responsibilities.

## Authenticated API

Inject the controller into `createWorkerServer(secret, media)` or `startWorker(env, media)`. The control-only CLI reports unavailable media. The optional [browser worker](browser-worker.md) supplies a production driver; another driver can be substituted without importing its SDK into the portable worker.

| POST path | Strict request body | Success |
| --- | --- | --- |
| `/v1/media/status` | `{}` | Controller availability and current session, or `null` |
| `/v1/media/join` | `{ "roomId": "!opaque" }` | A new session ID, exact room ID, and connected state |
| `/v1/media/leave` | `{ "sessionId": "uuid" }` | `{ "closed": true }` after cleanup |

All paths require the dedicated [worker message authentication](http-authentication.md), including process audience and replay protection. Success and media-control error responses are signed against the actual HTTP status and path. Invalid requests return 400, unconfigured rooms 403, missing sessions 404, busy/closed controllers 409, and redacted backend failures 503.

Disconnecting an HTTP client cancels only a connection still being opened. The response-close listener is removed after the operation completes, so finishing a successful request does not terminate its media session. Worker shutdown closes the injected media controller after stopping its HTTP listener.

Health may advertise `media-control` when an injected controller exists. `/readyz` remains 503 and `/v1/calls` remains unavailable because the assistant pipeline is not implemented. Media control readiness and assistant readiness are separate capabilities.
