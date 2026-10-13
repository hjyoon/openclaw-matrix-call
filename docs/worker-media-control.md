# Worker media control

`WorkerMediaController` manages one media transport per worker. It accepts only explicitly configured opaque Matrix room IDs and creates a new random session ID for every connection. The backend implements the portable `RtcTransportPort` connection/shutdown methods; the worker does not import Matrix, LiveKit, OpenClaw, or an agent framework.

Requests cannot supply caller roles, device-verification flags, model settings, or backend URLs. Matrix identity and media verification remain inside the transport. Media connection is not an agent turn, and its success does not establish assistant readiness.

Capacity is reserved before asynchronous connection starts. Concurrent joins are rejected. Cancellation or a connection timeout returns promptly, while the reservation remains until the backend finishes and cleanup completes. A late connection cannot replace another active session. Connection errors are redacted and trigger cleanup. Cleanup failure closes the controller permanently, requiring a fresh worker/transport instead of assuming the old connection is gone.

The connection deadline applies only to opening media. Completing an HTTP operation must not abort the connected session, and its connection timer is cleared after opening. Leaving requires the exact active session ID. Concurrent leave/shutdown operations share the same backend cleanup. Shutdown blocks new joins, aborts an in-flight connection, and waits for cleanup.

Backend drivers must honor the connection abort signal and release their browser/media resources when disconnected. A driver must create new media/key resources for a new call while preserving only its private Matrix crypto profile. A transport that never settles after cancellation cannot be safely reused; the controller retains its reservation.

The control layer does not create, reset, or delete an SFU room. It delegates connection to the configured transport. Agent ingress, STT/TTS, speaker authorization, and listener-aware publication/key rotation remain separate runtime responsibilities.
