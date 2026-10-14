# Native worker control

The experimental OpenClaw 2026.10.2 package can control an independently running worker through the portable [signed media API](worker-media-control.md). It registers an optional managed service, a Matrix command and an administrator Gateway RPC. It does not launch a browser, enroll a device or automatically accept an incoming call.

## Configuration

Merge this channel section using `openclaw config patch --file <settings.json>`. Replace the owner, opaque room ID, logical agent, URL and absolute secret-file path. The worker must already have the same room configured and a functioning media transport. Its dedicated control key must match this file and differ from the agent-service key.

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
      "workerControl": {
        "baseUrl": "https://worker.example.org/control/",
        "secretFile": "/private/matrix-call/control.secret",
        "timeoutMs": 35000
      }
    }
  }
}
```

Store a 64-character hexadecimal key in a private regular file, optionally followed by one newline. Symlinks, hardlinks and files larger than 65 bytes are rejected. Keep credentials outside the repository and inline Gateway configuration. URLs must use HTTPS. For an explicitly configured local connection, use `http://127.0.0.1:<port>` and `allowInsecureLoopback: true`; container loopback refers to that container. A namespace prefix is preserved in every signed request.

The channel defaults to disabled. Its `matrix-call-worker` service starts only when `enabled`, policy and `workerControl` are configured. Startup requires the public managed background-context runner and authenticated worker capabilities with caller-selected session IDs. Failure exposes a fixed message without private paths, URLs or credentials. The agent service is registered first, but worker deployment, readiness and retry supervision remain operator responsibilities. Failed startup is not automatically retried.

## Call entry

The installed native Matrix messaging integration dispatches these commands:

| Command | Result |
| --- | --- |
| `/matrixcall` or `/matrixcall status` | Worker availability and current permitted session |
| `/matrixcall join !room:example.org` | Open media in an explicitly configured room and return its session UUID |
| `/matrixcall leave <session-uuid>` | Close that exact current session after backend cleanup |

The command is restricted to the canonical Matrix channel. The host must identify an authorized sender, and its exact full Matrix user ID must be present in the current policy's owners. Display names, `from`, caller-supplied roles and transcript text never establish authority. Missing, unauthorized or unlisted senders are rejected. This command does not grant owner authority to an agent turn or implement general-user approval.

The Gateway entry point is `matrixcall.control`, registered with `operator.admin` scope and independent profile access. It also requires current live transport authority before execution and after asynchronous work. Request bodies are strict and accept only these operations:

```sh
openclaw gateway call matrixcall.control --params '{"operation":"status"}' --json
openclaw gateway call matrixcall.control --params '{"operation":"join","roomId":"!room:example.org"}' --json
openclaw gateway call matrixcall.control --params '{"operation":"leave","sessionId":"<session-uuid>"}' --json
```

Use the returned UUID for leave. A missing or different UUID is rejected, rather than closing whichever session currently occupies the worker. The configured target-room policy applies to join and to status/leave; an independently started session in another room is not exposed. Errors contain only fixed codes. No agent tool is registered by this control entry point.

## Ownership and lifecycle

The service chooses a random join UUID and records it before HTTP dispatch. If the response is lost or authority changes, shutdown still knows the exact candidate ID. Authenticated errors that prove pre-admission rejection release that candidate; ambiguous failures retain it. The worker never reuses accepted IDs in the same incarnation.

The native service admits at most 16 pending operations and retains at most 4,096 candidate sessions per lifecycle. It never evicts an uncertain ownership record to admit more calls. Successful explicit leave removes its record; an already-ended session is resolved by exact cleanup returning `not-found`.

Start, reload and stop are serialized. Stop cancels pending operations, waits for settlement, and sends signed leave only for retained IDs. It never discovers a shutdown target by inspecting the worker's current status. Independent sessions survive service disposal. Cleanup failure keeps admission closed and blocks replacement until exact cleanup can succeed.

Every HTTP operation has a deadline, including streamed response bodies. Cleanup uses a fresh deadline because the admission signal has already been aborted. Keep supervisor grace above the configured deadline and backend drain time. An uncooperative backend is not assumed to have stopped just because a request was cancelled.

A worker restart changes its authentication audience. This service does not silently reconnect, retry a join or attach old ownership records to a replacement worker. Stop the Gateway-owned control service before replacing a live worker, then authenticate a fresh service instance against the new worker. Agent-service reload separately changes its audience, so the browser voice adapter also needs an explicit reconnect through its configured lifecycle. Automatic coordinated worker/agent replacement is unfinished.

## Evidence and limits

Behavior tests use real signed worker HTTP operations and managed SDK contexts. They cover owner identity, strict arguments, room policy, exact-session leave, response loss, cancellation, admission bounds, independent sessions, policy reload and blocked replacement after cleanup failure.

The [installed Gateway check](agent-integration.md) drives the packed plugin's administrator RPC against a real signed HTTP worker. It also verifies rejection of a read-scoped public SDK client, restart, configuration reload and owned-session shutdown. Its media transport is deterministic; real Matrix media is checked separately.

The command handler is tested with public SDK command contexts. Actual Matrix chat command dispatch and released-client interoperability still need an isolated end-to-end check. Media connection alone does not establish verified voice input, model inference or assistant readiness. The native descriptor retains `isConfigured: false` and `media: false`; `/readyz` and automatic incoming calls remain unavailable. See [release readiness](release-readiness.md).
