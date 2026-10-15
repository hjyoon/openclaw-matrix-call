# Operator setup for a calling preview

This is an experimental manual setup for the [public alpha](publication-0.1.0-alpha.1.md). Read [release readiness](release-readiness.md) before connecting production accounts. The tested calling scope is one shared trusted MatrixRTC backend, explicit owners and rooms, bounded half-duplex Korean/English speech and tool-free agent replies. General-user approval, privileged agent tools, automatic incoming calls, Matrix 2.0 and legacy VoIP are unavailable.

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
pnpm release:images
pnpm speech:model
```

For the public version, review its source/capabilities and run `openclaw plugins install clawhub:@hjyoon/openclaw-matrix-call@0.1.0-alpha.1 --accept-capabilities` in a separate supported profile. This exact public-name installation has been verified. For a source build, review `.cache/release/release-report.json`, verify the archive with `SHA256SUMS`, and install that exact archive. Local-source fixtures use `plugins install <archive> --force --no-enable --accept-capabilities` after review, followed by `plugins enable matrix-call`. Configure an explicit plugin allowlist that includes `matrix-call` and, for chat controls, the official `matrix` plugin 2026.10.2.

Image packing requires a clean checkout and writes a separate checksum/report under `.cache/release-images/`. Match its version and commit to the plugin report. The [public prerelease](https://github.com/hjyoon/openclaw-matrix-call/releases/tag/v0.1.0-alpha.1) supplies matching reviewed plugin/image archives and reports; download all five assets before checking the combined archive checksums. Load the images as described in [worker image distribution](worker-image-distribution.md) and use Compose `up --no-build -d` to require them. A public image registry is not required.

## Configure the Gateway and workers

Combine the [native agent service](native-agent-service.md) and [native worker control](native-worker-control.md) examples into one `channels.matrix-call` section with the same owner, room and logical agent. Point the two services at their separate agent/control secret files. Use only operator-authored settings in `openclaw config patch --file <settings.json>`; preserve your model authentication and unrelated channel policy.

The agent listener binds loopback. Provision a trusted HTTPS reverse proxy to that listener when the worker is in a separate network namespace. Preserve the signed request path; put only the agent HMAC secret in the worker, never host session keys or a Gateway token. For a local native worker, explicitly opted-in loopback HTTP is supported. Unrelated containers' loopback addresses refer to different namespaces.

For an existing Gateway inside Docker, an optional [container Gateway deployment](container-gateway-deployment.md) shares that container's network namespace with the separate workers and publishes no calling ports. It requires coordinated container replacement and separate installed-client audio validation. The host-network overlay below targets a native Gateway.

For a native OpenClaw Gateway on the same Linux Docker host, use the optional local overlay below. It explicitly shares host networking, while retaining separate worker filesystems, PID namespaces, non-root execution and resource limits. This route needs no agent reverse proxy. It is not the route for a Gateway in an unrelated container namespace. See [ADR 0021](adr/0021-local-gateway-worker-networking.md).

Copy the [browser configuration](browser-worker.md#device-enrollment) and [local speech configuration](local-speech-deployment.md) into the private directory. Set the actual Matrix credentials, exact owner pins, room and trusted endpoints. Set browser `voiceFile` to `/run/config/voice.json`. In the voice JSON, select the same logical agent (`main` for the native adapter), the reachable HTTPS agent endpoint and `/run/secrets/voice_agent_secret`; the shared local speech endpoint is `http://127.0.0.1:19792` with its distinct secret. The local speech example explicitly permits loopback HTTP. Keep the persistent asset port stable.

Verify the selected `base` model's bytes/hash against `deployment/speech-engines.json`. Set absolute paths for `MATRIX_CALL_BROWSER_CONFIG`, `MATRIX_CALL_MATRIX_CREDENTIALS`, `MATRIX_CALL_SECRET_FILE`, `MATRIX_CALL_VOICE_CONFIG`, `MATRIX_CALL_VOICE_AGENT_SECRET`, `MATRIX_CALL_VOICE_SPEECH_SECRET`, `MATRIX_CALL_SPEECH_CONFIG` and `MATRIX_CALL_SPEECH_MODEL`.

Validate the composition before starting it:

```sh
docker compose -f deployment/browser-compose.yml \
  -f deployment/browser-voice.compose.yml \
  -f deployment/browser-local-speech.compose.yml config --quiet
```

## Local native Gateway example

Use three distinct private HMAC files and the actual Matrix credentials/pins prepared above. Default images run as UID 1000; their private input files and persistent profile must be readable by that UID. A reviewed user override and correctly owned profile are required for a different UID. The fixture tests this ownership override without granting root to either runtime.

Merge this operator-authored section into the existing Gateway configuration, replacing the owner, room and absolute private paths. Its logical `main` agent must already have the chosen model/authentication:

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
        "secretFile": "/home/operator/private/matrix-call/agent.secret",
        "port": 19793
      },
      "workerControl": {
        "baseUrl": "http://127.0.0.1:19790",
        "secretFile": "/home/operator/private/matrix-call/control.secret",
        "allowInsecureLoopback": true,
        "timeoutMs": 90000
      }
    }
  }
}
```

The browser JSON uses `/run/secrets/matrix.json`, `/data/profile`, `/app/assets`, a stable asset port and `/run/config/voice.json`. Fill in the actual homeserver, owner/device pins, exact room and trusted focus/SFU endpoints from the [browser example](browser-worker.md#device-enrollment). Keep the Matrix account token in the separate credentials file.

Set the voice JSON to:

```json
{
  "agentId": "main",
  "agent": {
    "baseUrl": "http://127.0.0.1:19793",
    "secretFile": "/run/secrets/voice_agent_secret"
  },
  "speech": {
    "baseUrl": "http://127.0.0.1:19792",
    "secretFile": "/run/secrets/voice_speech_secret"
  },
  "allowInsecureLoopback": true,
  "requestTimeoutMs": 70000,
  "timeoutMs": 120000
}
```

Use `deployment/speech-config.example.json` with its independently verified model. Define the eight absolute `MATRIX_CALL_*` paths listed above; set `MATRIX_CALL_CONTROL_PORT=19790` and `MATRIX_CALL_SPEECH_PORT=19792`. If changing the speech port, change the speech JSON's `port` as well. Require the reviewed loaded images:

```sh
docker compose -f deployment/browser-compose.yml \
  -f deployment/browser-voice.compose.yml \
  -f deployment/browser-local-speech.compose.yml \
  -f deployment/browser-local-gateway.compose.yml config --quiet

docker compose -f deployment/browser-compose.yml \
  -f deployment/browser-voice.compose.yml \
  -f deployment/browser-local-speech.compose.yml \
  -f deployment/browser-local-gateway.compose.yml up --no-build -d

curl --fail http://127.0.0.1:19790/readyz
```

Start the Gateway's agent service before the workers. Its worker-control service waits only within the configured initial discovery budget. A worker's liveness does not replace the authenticated readiness check. See [operator integration](operator-compose-integration.md) for the exact empty-profile test and its remaining limits.

Prebuild the images and prepare the model/configuration before starting the Gateway control service. Its initial worker discovery has one bounded `timeoutMs` budget; choose enough time for worker startup/enrollment, such as 90000 ms. The agent service starts first, allowing the worker to authenticate its capabilities. Start the independently configured speech/browser pair inside that budget using the same Compose files with `up -d`. A missed budget requires an explicit service restart after correcting setup; it does not replay a join.

## Verify and enter the call

Worker `/healthz` is liveness. Require `/readyz` HTTP 200 for an available enrolled driver and current authenticated agent/speech services before entering a call; generic/media-only workers remain 503. This does not run inference or attest model-account validity. See [readiness](readiness.md). Check configured media control through an authenticated administrator client, using the intended Gateway profile:

```sh
openclaw gateway call matrixcall.control --params '{"operation":"status"}' --json
```

To use chat entry, configure the separate Matrix messaging adapter's sender/room allowlists and `dm.sessionScope: per-room`. Use a dedicated control room with `requireMention: false`, or an isolated DM. Send literal `/matrixcall status`, `/matrixcall join <room-id>` and `/matrixcall leave <exact-session-uuid>`. Visible bot-mention prefixes are unsupported in the pinned messaging adapter. The calling plugin checks owner identity independently. See [encrypted command evidence](matrix-command-integration.md).

Join with the tested client/mode and verify its actual device fingerprint before admitting speech. Test Korean and English, exact-session leave and a fresh call's independent history. State membership and media device verification are separate from messaging-bot cross-signing. The current worker handles one active call; it rejects overlapping joins. Speech input is bounded to ten seconds; generated output is bounded to individual pieces and sixty seconds in total.

## Diagnostics and replacement

An `enrollment` startup failure can mean a wrong device/token, a changed fingerprint, missing encrypted membership or an unavailable SDK device store. Enrollment waits for stored device records within thirty seconds and cancellation stops stalled lookups. A new profile cannot reuse an already-published device without its complete original crypto state. Restore the whole private profile with its stable asset origin, or issue a new device; do not suppress fingerprint checks.

`unsupported-call` requires checking the exact client mode, slot and advertised transport. `untrusted-focus`/`untrusted-sfu` require correcting trusted endpoints. A client-side delayed-event error requires matching server capability limits. Blank recognition results create no model turn; input quality and latency still need measurements on the actual host.

Service restart changes authentication audiences. Leave the exact owned call and stop/remove the browser before replacing services; preserve its complete private profile and stable asset port. Stop/restart the Gateway control service while the worker is absent, then recreate speech and browser within the initial discovery budget. The new worker negotiates fresh agent/speech capabilities, and Gateway control negotiates the new worker audience. No old call, media authority or model turn is replayed.

If the Gateway was restarted while an old worker was still alive, its control client remains bound to that old worker audience. After replacing the worker, explicitly restart that Gateway service again while the worker is absent. An availability check does not silently adopt a new audience. The integration exercises this negative ordering and explicit recovery; an automated deployment supervisor remains separate work.
