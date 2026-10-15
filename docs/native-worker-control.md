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

The channel defaults to disabled. Its `matrix-call-worker` service starts only when `enabled`, policy and `workerControl` are configured. Startup requires the public managed background-context runner and authenticated worker capabilities with caller-selected session IDs. Failure exposes a fixed message without private paths, URLs or credentials. The agent service is registered first. During initial discovery, a refused TCP connection waits in 100 ms intervals within one overall `timeoutMs` budget, allowing the worker to authenticate that already-started agent service before opening its own listener. Authentication, schema, credential, TLS and other terminal failures are not retried. No media operation is retried, and there is no discovery retry after a connection or ownership record exists. Worker deployment, enrollment and coordinated replacement remain operator responsibilities.

## Call entry

Chat entry requires the separately installed `@openclaw/matrix` 2026.10.2 messaging plugin, configured with its own bot credentials and sender/room access policies. The calling package registers controls but does not receive Matrix messages itself. Set `channels.matrix.dm.sessionScope` to `per-room` when multiple DMs reach the bot. Installing only the calling archive still permits the administrator RPC when worker control is configured.

Send these literal commands as the message body in a DM, or in a dedicated allowlisted control room with `requireMention: false`:

| Command | Result |
| --- | --- |
| `/matrixcall` or `/matrixcall status` | Worker availability and current permitted session |
| `/matrixcall dial !room:example.org @owner:example.org Good morning!` | Source builds after alpha.1: ring the configured recipient and speak after a verified answer |
| `/matrixcall join !room:example.org` | Open media in an explicitly configured room and return its session UUID |
| `/matrixcall leave <session-uuid>` | Close that exact current session after backend cleanup |

The command is restricted to the canonical Matrix channel. The host must identify an authorized sender, and its exact full Matrix user ID must be present in the current policy's owners. Display names, `from`, caller-supplied roles and transcript text never establish authority. Missing, unauthorized or unlisted senders are rejected. This command does not grant owner authority to an agent turn or implement general-user approval.

Visible bot-mention prefixes before custom `/matrixcall` commands are unsupported by the pinned messaging adapter's command detector. The observed prefix form went to the model instead of this handler. Keep ordinary conversation-room mention policy independent and use DM entry or a dedicated control room. See [actual command evidence](matrix-command-integration.md) for the tested message forms and limits.

The Gateway entry point is `matrixcall.control`, registered with `operator.admin` scope and independent profile access. It also requires current live transport authority before execution and after asynchronous work. Request bodies are strict and accept only these operations:

```sh
openclaw gateway call matrixcall.control --params '{"operation":"status"}' --json
openclaw gateway call matrixcall.control --params '{"operation":"dial","roomId":"!room:example.org","recipientId":"@owner:example.org","message":"Good morning!","ringTimeoutMs":20000}' --json
openclaw gateway call matrixcall.control --params '{"operation":"join","roomId":"!room:example.org"}' --json
openclaw gateway call matrixcall.control --params '{"operation":"leave","sessionId":"<session-uuid>"}' --json
```

## Model tool in source builds after alpha.1

The optional `matrix_call` tool accepts `dial`, `status` and exact-session `leave`. Add only `matrix_call` to `tools.alsoAllow` when the selected host tool profile requires explicit opt-in. With `selfCalls` disabled, the V2 tool factory requires host-provided `messageChannel: matrix`, `senderIsOwner: true`, an exact configured owner `requesterSenderId` and live `assertInvocationCurrent`. A retained tool rechecks that authority before effects and after asynchronous work. No request argument supplies identity or permissions. Delegated voice ingress remains tool-free and cannot use this entry.

The tool advertises the configured room and recipient IDs. Initially recipients must be configured owners and have a dedicated encrypted two-person room with the bot. Adding someone to the owner policy grants control authority; do not use that as a substitute for a future separate non-owner recipient policy. A matching worker must advertise signed outbound capability. Use a control timeout long enough for ringing, connection and opening speech; the installed setup uses 90000 ms. Errors do not authorize retries. Scheduling and calls to arbitrary contacts are not implemented. See [outbound calls](outbound-calls.md).

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

The [native Matrix check](native-matrix-integration.md) runs the same administrator control against actual encrypted Matrix media with local speech engines and installed SDK agent dispatch. It also checks initial discovery ordering and Gateway shutdown cancelling recognition inside the restored browser image. The provider remains deterministic and client participants remain SDK peers.

The [actual command check](matrix-command-integration.md) passes fifteen Matrix replies through both installed plugins, including owner controls, forged display-name/role rejection, two isolated DMs, exact-session errors and owned-session cleanup. Its chat is unencrypted and media transport is a fixture; it performs zero inference. The combined check also passes eleven encrypted commands/replies and real Korean/English speech in both worker modes. The separate [Element Call check](released-client-integration.md) passes one released application configuration. Media connection alone does not establish assistant readiness. The native descriptor reports configured for complete enabled policy/agent/control settings; live availability requires the [readiness check](readiness.md). `media: false` indicates that no chat-attachment adapter exists. Automatic incoming calls remain unavailable. See [release readiness](release-readiness.md).

## General-user self-calls

Source alpha.3 adds explicit `selfCalls` opt-in on both native channel and browser worker. It binds general-user model calls to the trusted Matrix sender, discovers an existing encrypted private room and scopes status/leave to that user. Verified device setup remains required. See [self-calls](self-calls.md) for configuration, enrollment and integration evidence.

## Explicit third-party requests

Alpha.4 adds `channels.matrix-call.thirdPartyCalls: true`, requiring `selfCalls: true`. Any admitted Matrix requester can select an exact recipient ID with `matrix_call`, or use `/matrixcall call-to <recipient-id> <opening-message>` if the host admits that command. Omission still means the requester. Existing self-only installations remain self-only by default. The same alpha.3 worker capability/discovery protocol is used.

Request ownership follows the trusted Matrix sender, while private-room discovery and ephemeral voice authorization follow the recipient. The requester can inspect and leave their requested session; another general user cannot. The callee can hang up through their client. Recipient device verification and exact encrypted two-person-room checks remain mandatory. This does not add scheduling or automatic enrollment. See [ordinary-user calling](self-calls.md) and [ADR 0027](adr/0027-third-party-call-requesters-and-recipients.md).
