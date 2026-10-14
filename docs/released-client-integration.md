# Released Matrix client integration

Checked locally: 2026-10-14. Element Call 0.28.0 passes encrypted Matrix command entry, actual Korean/English speech and leave/rejoin through the production native worker. This records one supported application configuration, rather than universal Matrix client support.

## Reproduction

Use the pinned Node/pnpm versions, Docker, installed test Chromium and the speech image:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm browser:install
docker build -f deployment/speech-worker.Dockerfile -t matrix-call-speech-worker:0.1.0-alpha.1 .
pnpm verify:released-client
```

The check downloads the official standalone release archive and verifies its pinned SHA-256 before extracting it into private temporary files. It serves the unmodified application with local homeserver/focus configuration. No application code or Matrix/media cryptography is patched. The fixture supplies an existing disposable login through the app's session storage and a controlled browser `MediaStream` microphone; it does not use a person's microphone, camera or recording. A simulated camera comes from Chromium's test device.

## Tested scope

| Component | Tested configuration |
| --- | --- |
| Application | Official Element Call 0.28.0 standalone archive |
| Application archive SHA-256 | `a406fdc7ecdf9ab010e134113e949d5b22366abab7cd23f62a9076ee3f055166` |
| Browser / homeserver | Chromium 156.0.8078.4 / Synapse 1.162.0, room version 12 |
| Calling mode | Compatibility, state membership, room slot `m.call#ROOM`, one shared trusted backend |
| Encryption | Application per-participant E2EE enabled; authenticated pinned Matrix devices; encrypted microphone admitted by the worker |
| Media / authorization | LiveKit 1.13.9 / authorization service 0.8.0, explicit OpenID `/sfu/get` |
| Worker / agent | Production native browser worker / packed plugin in OpenClaw 2026.10.2 using public SDK dispatch |
| Speech / model | Real local `base` recognition and eSpeak synthesis / deterministic provider text |

Two spoken turns pass in the first call, Korean then English. Recognition must contain the fixture's expected words, the worker must verify the actual Matrix user/device and encrypted participant, and the application must receive non-silent synthesized audio through its normal media elements. Public host history must contain exactly the matching user and assistant turns.

Both sides then leave. The application reloads and rejoins with identical device keys; the worker opens a different owned media session. A third Korean turn starts a distinct conversation containing one user/reply pair. The host reports exactly two independent call sessions and three deterministic provider requests. Media, engine, Gateway, browser and homeserver cleanup must complete before the check succeeds.

The application-owned public Matrix SDK sends literal `/matrixcall` messages and decrypts replies from the separately installed official messaging plugin. The application bundle and cryptography remain unchanged. This exercises Matrix messaging through the released application's actual client; it does not claim that Element Call supplies a chat-composing UI.

Ten encrypted commands and replies pass: initial status, rejection of an unconfigured room, first join, connected status, rejection of a different leave UUID, exact-session leave, second join, connected status, final leave and empty final status. The fixture checks server-side `m.room.encrypted` input and decrypted replies retaining their encrypted wire metadata. Chat controls cause no additional agent turns or provider requests. Separate messaging/worker devices are enrolled against their actual published keys.

A physical microphone, interruptions, sustained calls and additional clients still require evidence. Multi-backend connections, Matrix 2.0 sticky/hashed identity mode, homeserver-mediated authorization and legacy VoIP remain outside the implementation.

## Optional actual model

Prepare private, access-only settings using [live model instructions](live-model-integration.md), then run:

```sh
MATRIX_CALL_LIVE_MODEL_FILE=/absolute/private/model.json pnpm verify:released-client-live
```

Missing or invalid settings fail before infrastructure starts. This mode retains all application, encrypted chat, recognition, identity, playback and independent-history checks. The deterministic provider must receive no requests, public host history must identify the configured model with generated output tokens, and Korean/English replies must use the input language. Reports contain reply hashes and lengths rather than generated text or credentials. Ordinary CI uses the deterministic path without a hosted account.

Ignored reports are stored separately as `.cache/speech/released-client-result.json` and `.cache/speech/released-client-live-result.json`. Both record the exact application archive, chat counts, speech input measurements, model/history metadata and first-audio timings after successful cleanup.

The local actual-model run passed all three turns with `openai/gpt-6.1-sol`, the existing `openclaw` runtime and `high` thinking. Ten encrypted commands/replies passed with zero deterministic provider requests. Public histories contained two user/reply pairs in the first call and one in the independent second call. The source login was read without refresh ownership or modification; the private access snapshot and disposable profiles were removed after the check.

| Call / language | Reply characters | First audio |
| --- | --- | --- |
| First / Korean | 28 | 34.29 s |
| First / English | 80 | 24.90 s |
| Second / Korean | 26 | 29.39 s |

Timings include fixture preparation/playback, recognition, actual model inference and synthesis on one development host. They are not target-server measurements or a latency guarantee. This combined path uses the production native worker; released-application interoperability with the restored worker image remains a separate unverified configuration.

## Setup failures corrected during validation

The current application advertises a service configuration without the deprecated `livekit_alias`. [ADR 0018](adr/0018-modern-livekit-transport-config.md) accepts that shape while retaining exact token room/participant and endpoint checks. Before that change, worker join failed with `unsupported-call`.

The app also requested a one-hour delayed leave event. The fixture had advertised delayed-event support while allowing only ten seconds, producing `ORG.MATRIX.MSC4140_DELAY_TOO_LARGE` and disconnecting the app. The released-client fixture now permits one hour, matching the app's default. Ordinary SDK tests keep their shorter limit. Operators must align the actual client's delayed-event needs with homeserver capabilities; this check does not change a production server.

The public sources are the [official release](https://github.com/element-hq/element-call/releases/tag/v0.28.0) and [pinned fixture metadata](../tests/fixtures/clients/element-call.json). Application binaries remain an ignored test dependency and are absent from the plugin archive. Passing this scoped check does not complete [public release readiness](release-readiness.md).
