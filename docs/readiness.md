# Assistant readiness

`GET /healthz` is liveness. It returns protocol/development metadata and configured transport names. It does not run a voice-service check or include a cached readiness flag. Startup logs likewise describe startup rather than promise readiness.

`GET /readyz` returns HTTP 200 with `{"ready":true}` only for an available browser driver, available media controller, configured voice route and valid current agent/speech capabilities. Generic and media-only workers return 503. The unavailable response has a fixed `transport-unavailable` or `service-unavailable` code; backend errors, credentials and private paths are absent.

Checks use the HMAC keys and audiences negotiated at startup. A replacement service's valid new audience still fails the old adapter. No probe changes an audience, dispatches inference, runs a speech engine, queues PCM, joins a call or grants a caller permission. Every actual turn retains its independent current Matrix/device/key/media verification.

The complete check has a two-second deadline, including callbacks that ignore cancellation. Concurrent requests share the in-flight check; the next completed request starts a fresh check. A closed controller or driver cannot become ready from an earlier asynchronous result. Capability protocol shape and agent history mode must remain compatible.

The native channel's `configured` flag requires an enabled account with explicit policy, agent service and worker control. It does not indicate live availability. `media: false` describes the absence of a chat-attachment adapter, not a result of the runtime call check. Incoming calls remain unsupported.

Readiness does not establish model-account validity, speech accuracy, uninterrupted network delivery or a latency guarantee. Validate actual inference separately. After service replacement, stop the old call and recreate the browser to negotiate fresh capabilities; never replay a previous turn. See [operator setup](operator-setup.md) and [ADR 0022](adr/0022-authenticated-pipeline-readiness.md).
