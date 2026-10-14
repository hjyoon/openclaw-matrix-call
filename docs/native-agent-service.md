# Native OpenClaw agent service

The experimental native package can expose the portable [agent HTTP protocol](agent-protocol.md) from OpenClaw 2026.10.2. The Gateway owns its start, stop and channel-configuration reload through the public `registerService` API. This service connects signed text turns to the exported delegated ingress adapter. Separately configured [native worker control](native-worker-control.md) supplies owner/admin media entry without launching or enrolling a worker.

## Configuration

Keep the dedicated agent secret outside the repository and Gateway configuration. Generate 32 random bytes, encode them as 64 lowercase hexadecimal characters, and store that value in a private file. Use permissions `0600` and restrict its parent directory to the operator. The file must be regular, at most 65 bytes, and neither symlinked nor hardlinked. This is a separate key from worker control, speech authentication, Matrix credentials and Gateway authentication.

Merge the following channel section into the supported Gateway configuration. Replace the user, room, logical agent and absolute secret path. The referenced agent must already be configured in OpenClaw with a model and its own provider authentication.

```json
{
  "channels": {
    "matrix-call": {
      "enabled": true,
      "policy": {
        "owners": ["@owner:example.org"],
        "rooms": ["!room:example.org"],
        "agents": ["main"]
      },
      "agentService": {
        "secretFile": "/private/matrix-call/agent.secret",
        "host": "127.0.0.1",
        "port": 19793,
        "timeoutMs": 30000
      }
    }
  }
}
```

The channel defaults to disabled. An enabled channel requires an explicit policy. The service starts only when `agentService` is also present. Its host accepts only `127.0.0.1` or `::1`; it does not bind a public interface. Port defaults to `19793` and timeout to 30 seconds. Inline secrets, unknown configuration keys and invalid limits are rejected by both the runtime schema and cold plugin metadata.

The standalone browser worker's external voice configuration can use `agent.baseUrl` set to `http://127.0.0.1:19793` and `agent.secretFile` set to its private copy of that same agent key. A container needs an explicitly configured network route to the Gateway loopback endpoint; an unrelated container's `127.0.0.1` refers to itself. Existing isolated Compose networking is described in [browser worker](browser-worker.md). Coordinated replacement, enrollment and a complete operator setup flow still require implementation.

After service restart or reload, reconnect the worker's agent adapter to negotiate the new audience. Do not replay prior turns while reconnecting; old adapters are intentionally rejected.

## Authority and lifecycle

The service checks owner, room, logical agent, verified device, encrypted media, current membership expiry and the transcript sender. The dedicated key authenticates a trusted verifier/worker; it does not allow a public client to supply its own identity claims. The conversation UUID is bound to its initial caller and transport identity. Requests cannot rebind an existing OpenClaw session to another user or device.

OpenClaw receives `senderIsOwner: false`, `toolsAllow: []`, `allowModelOverride: false` and `deliver: false`. Its policy remains authoritative. Provider credentials and private session keys stay in the Gateway. See [ADR 0004](adr/0004-delegated-openclaw-ingress.md) for the unsupported privileged execution boundary.

The service uses the public SDK logger-backed command runtime, which throws instead of exiting the Gateway. Command output is discarded; command errors produce a fixed log message. The HTTP response exposes only `meta.finalAssistantVisibleText`. Startup errors name only the failed phase (`configuration`, `credentials`, `runtime` or `listener`), without file paths or credentials.

Apply the channel section through `openclaw config patch --file <channel-settings.json>` or the supported configuration UI. A patch should contain only operator-authored settings, excluding OpenClaw's auto-managed `meta` fields. Avoid `OPENCLAW_SKIP_CHANNELS=1` and `OPENCLAW_SKIP_PROVIDERS=1` when testing this service: the pinned host removes channel settings from its startup runtime configuration with either flag. The service requires its explicit policy and never reconstructs authority from a suppressed configuration.

Start and stop transitions are serialized. Reload of `channels.matrix-call` stops the old listener and cancels its host operation before starting a fresh service audience. Shutdown waits for the operation to settle, including a host that ignores its abort signal. A hung host can therefore delay shutdown or reload; the service never clears the slot merely to admit replacement work. Timeout, disconnect, idempotency and capacity behavior follow the [portable server contract](agent-protocol.md#portable-server-implementation).

Listener installation and every host request use the managed instance's public `api.lifecycle.runInBackgroundContext` runner. This detaches the starting request's async context and selects the instance's current adopted registry after reload. The callback returns its host promise so the instance can drain it. Hosts without this capability are rejected during the runtime startup phase; disposed instances cannot admit new host work.

Gateway shutdown may drain active host work before disposing plugin services. Keep the supervisor's shutdown grace above the configured agent deadline plus host cleanup time; a host that ignores abort can take longer. The [installed Gateway check](agent-integration.md) verifies restart, actual configuration reload and shutdown with a held provider request. The [combined native Matrix check](native-matrix-integration.md) verifies encrypted Korean/English speech, host history and worker recognition cancellation with that actual SDK path. Those model endpoints are deterministic fixtures. Separate [live model](live-model-integration.md) and [released client](released-client-integration.md) checks provide additional evidence in their documented scopes.

The native channel continues to report unconfigured call support and `media: false` because assistant readiness and supported operator deployment setup remain unfinished. Signed text ingress and media control alone do not establish those capabilities.
