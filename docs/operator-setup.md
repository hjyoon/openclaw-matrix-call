# Operator setup for a calling preview

This is an experimental manual setup, not a published turnkey release. Read [release readiness](release-readiness.md) before connecting production accounts. The tested calling scope is one shared trusted MatrixRTC backend, explicit owners and rooms, bounded half-duplex Korean/English speech and tool-free agent replies. General-user approval, privileged agent tools, automatic incoming calls, Matrix 2.0 and legacy VoIP are unavailable.

## Prepare the inputs

Use OpenClaw 2026.10.2 with Node 24.16.0, the repository's pinned pnpm version, and a Linux Docker host supporting Chromium's user namespaces and sandbox. The image recipes and CI target Linux x86-64. Configure a logical OpenClaw agent such as `main` with your chosen model and authentication. No particular model vendor is required by the worker; another runtime can implement [agent protocol v1](agent-protocol.md).

Prepare one encrypted Matrix call room, its exact opaque ID, the owner's full Matrix ID and the owner's device ID plus Ed25519/Curve25519 public keys. Compare the signing fingerprint through a trusted channel. Obtain a new device token for the worker on a dedicated bot account or a separate device of the messaging bot. Its authenticated `whoami` must match the configured user/device. Join the call room and grant the supported RTC membership state permissions. The worker and messaging adapter must have separate crypto stores and devices.

Configure trusted HTTPS homeserver/focus and WSS SFU endpoints. The tested authorization service is 0.8.0 with explicit OpenID `/sfu/get`. Element Call 0.28.0 must use standalone compatibility and per-participant E2EE. A homeserver advertising delayed-event support must accept the client's required duration; the released application used a one-hour delayed leave. Additional clients and backend modes need their own [compatibility evidence](released-client-integration.md).

Create a private configuration directory outside the checkout. Keep it owned by the operator, mode `0700`, and create files with `umask 077`. Generate three independent 64-character lowercase hex secrets for worker control, agent and speech, for example by redirecting `openssl rand -hex 32` into three separate files. Never substitute a Gateway operator token or model credential for these keys. Match the non-root container UID's read permissions.

## Build and inspect

From a pinned checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm verify:marketplace
docker build -f deployment/browser-worker.Dockerfile -t matrix-call-browser-worker:0.1.0-alpha.1 .
docker build -f deployment/speech-worker.Dockerfile -t matrix-call-speech-worker:0.1.0-alpha.1 .
pnpm speech:model
```

Review `.cache/release/release-report.json`, verify the archive with `SHA256SUMS`, and install that exact archive into a separate supported Gateway profile. Local-source fixtures use `plugins install <archive> --force --no-enable --accept-capabilities` after source/capability review, followed by `plugins enable matrix-call`. That local-source trust acknowledgment is not registry approval. Published-name installation is unavailable until a release is actually public. Configure an explicit plugin allowlist that includes `matrix-call` and, for chat controls, the official `matrix` plugin 2026.10.2.

## Configure the Gateway and workers

Combine the [native agent service](native-agent-service.md) and [native worker control](native-worker-control.md) examples into one `channels.matrix-call` section with the same owner, room and logical agent. Point the two services at their separate agent/control secret files. Use only operator-authored settings in `openclaw config patch --file <settings.json>`; preserve your model authentication and unrelated channel policy.

The agent listener binds loopback. Provision a trusted HTTPS reverse proxy to that listener when the worker is in a separate network namespace. Preserve the signed request path; put only the agent HMAC secret in the worker, never host session keys or a Gateway token. For a local native worker, explicitly opted-in loopback HTTP is supported. Unrelated containers' loopback addresses refer to different namespaces.

Copy the [browser configuration](browser-worker.md#device-enrollment) and [local speech configuration](local-speech-deployment.md) into the private directory. Set the actual Matrix credentials, exact owner pins, room and trusted endpoints. Set browser `voiceFile` to `/run/config/voice.json`. In the voice JSON, select the same logical agent (`main` for the native adapter), the reachable HTTPS agent endpoint and `/run/secrets/voice_agent_secret`; the shared local speech endpoint is `http://127.0.0.1:19792` with its distinct secret. The local speech example explicitly permits loopback HTTP. Keep the persistent asset port stable.

Verify the selected `base` model's bytes/hash against `deployment/speech-engines.json`. Set absolute paths for `MATRIX_CALL_BROWSER_CONFIG`, `MATRIX_CALL_MATRIX_CREDENTIALS`, `MATRIX_CALL_SECRET_FILE`, `MATRIX_CALL_VOICE_CONFIG`, `MATRIX_CALL_VOICE_AGENT_SECRET`, `MATRIX_CALL_VOICE_SPEECH_SECRET`, `MATRIX_CALL_SPEECH_CONFIG` and `MATRIX_CALL_SPEECH_MODEL`.

Validate the composition before starting it:

```sh
docker compose -f deployment/browser-compose.yml \
  -f deployment/browser-voice.compose.yml \
  -f deployment/browser-local-speech.compose.yml config --quiet
```

Prebuild the images and prepare the model/configuration before starting the Gateway control service. Its initial worker discovery has one bounded `timeoutMs` budget; choose enough time for worker startup/enrollment, such as 90000 ms. The agent service starts first, allowing the worker to authenticate its capabilities. Start the independently configured speech/browser pair inside that budget using the same Compose files with `up -d`. A missed budget requires an explicit service restart after correcting setup; it does not replay a join.

## Verify and enter the call

Worker `/healthz` is liveness. `/readyz` remains 503 because the full assistant readiness contract is unfinished. Check configured media control through an authenticated administrator client, using the intended Gateway profile:

```sh
openclaw gateway call matrixcall.control --params '{"operation":"status"}' --json
```

To use chat entry, configure the separate Matrix messaging adapter's sender/room allowlists and `dm.sessionScope: per-room`. Use a dedicated control room with `requireMention: false`, or an isolated DM. Send literal `/matrixcall status`, `/matrixcall join <room-id>` and `/matrixcall leave <exact-session-uuid>`. Visible bot-mention prefixes are unsupported in the pinned messaging adapter. The calling plugin checks owner identity independently. See [encrypted command evidence](matrix-command-integration.md).

Join with the tested client/mode and verify its actual device fingerprint before admitting speech. Test Korean and English, exact-session leave and a fresh call's independent history. State membership and media device verification are separate from messaging-bot cross-signing. The current worker handles one active call; it rejects overlapping joins. Speech input is bounded to ten seconds; generated output is bounded to individual pieces and sixty seconds in total.

## Diagnostics and replacement

An `enrollment` startup failure can mean a wrong device/token, a changed fingerprint, missing encrypted membership or an unavailable SDK device store. Enrollment waits for stored device records within thirty seconds and cancellation stops stalled lookups. A new profile cannot reuse an already-published device without its complete original crypto state. Restore the whole private profile with its stable asset origin, or issue a new device; do not suppress fingerprint checks.

`unsupported-call` requires checking the exact client mode, slot and advertised transport. `untrusted-focus`/`untrusted-sfu` require correcting trusted endpoints. A client-side delayed-event error requires matching server capability limits. Blank recognition results create no model turn; input quality and latency still need measurements on the actual host.

Service restart changes authentication audiences. Stop the owned call and Gateway control service before replacing a worker. After replacing agent or speech services, recreate/reconnect the browser to negotiate fresh capabilities; a speech namespace replacement also requires recreating the browser. No old call, media authority or model turn is replayed. Automated coordinated replacement and a fully tested clean operator deployment remain release work.
