# Native Gateway with encrypted Matrix speech

Checked locally: 2026-10-14.

`pnpm verify:matrix-gateway` connects the packed native plugin to the real encrypted Matrix speech harness. It uses an actual OpenClaw 2026.10.2 Gateway, its public delegated SDK dispatch and host session storage, real signed worker HTTP control, isolated Matrix/LiveKit services, sandboxed Chromium and local whisper.cpp/eSpeak engines.

The model-provider endpoint returns deterministic Korean/English text. It is not an AI model. Matrix participants use SDK peers rather than a released client application. This checks the combined native/media path; it does not establish actual model inference, privileged agent execution or client interoperability.

## Running the check

Use the pinned Node/pnpm versions and Docker as a non-root user. Build the bundles, install test Chromium and build the speech/browser images before running:

```sh
pnpm build
pnpm browser:install
docker build -f deployment/speech-worker.Dockerfile -t matrix-call-speech-worker:0.1.0-alpha.1 .
docker build -f deployment/browser-worker.Dockerfile -t matrix-call-browser-worker:0.1.0-alpha.1 .
pnpm verify:matrix-gateway
```

The check uses disposable profiles, accounts, rooms, service credentials and infrastructure. It installs the locally built archive with the same explicit trust acknowledgement used by the existing packed-plugin check. The Gateway token stays in the test controller; the worker receives only its dedicated control, agent and speech credentials. Fixture provenance, model integrity and speech limits are documented in [speech evidence](speech-integration.md).

## Startup and observations

A fresh Gateway profile starts its agent listener before the browser worker. Its worker-control service initially sees a refused, preallocated loopback port and waits within one 60-second capability-discovery budget. The worker authenticates agent/speech services, restores its device profile and opens that control port. The native service then authenticates the worker, allowing administrator RPC status/join/leave to drive the actual Matrix media connection. No channel patch or audience rotation is needed during startup.

An isolated agent observer validates the worker's request authentication, records its exact strict request and forwards the original body and signed headers to the native listener. It does not re-sign requests or construct caller evidence. The worker's HMAC-authenticated capabilities and replies still originate from the native service. Provider HTTP observations independently show what the actual SDK submits to the configured model transport.

The fixture uses one fresh Gateway profile for each native/container worker runtime. Both share aggregate observations while keeping host state and agent audiences separate. This permits comparison of call history and fresh conversations without reusing a control client's audience after worker replacement.

## Required behavior

- Administrator control rejects an unconfigured room and opens a known owned session in the actual encrypted Matrix room.
- Korean/English public PCM fixtures pass actual participant verification, encrypted capture, local recognition, the signed native agent service, actual SDK dispatch, local synthesis and encrypted output.
- The observed agent caller matches the real Matrix owner, device and room, with current verified-device/encrypted-media evidence. The logical native agent is `main`.
- The portable transcript retains one user message on the first turn and three messages on the second. The native adapter submits the latest message, while the actual host prompt includes the earlier message/reply exactly once. No runtime tools reach the provider fixture.
- The restored browser image preserves device keys but starts a fresh neutral conversation and host history.
- Native RPC leave during actual recognition terminates the engine child, removes its private input WAV and prevents another agent turn.
- Gateway shutdown during image recognition closes its exact owned worker session, terminates recognition, removes the input and exits successfully. The worker image also exits with code zero and no OOM while retaining renderer PID/seccomp isolation.

The aggregate report is `.cache/speech/matrix-integration-result.json`. It identifies installed SDK dispatch and native control explicitly and records `modelInference: false` and `releasedClient: false`. Failure diagnostics are limited to public prerecorded fixtures as described in [speech evidence](speech-integration.md).

The [CI run for `91e5342`](https://github.com/hjyoon/openclaw-matrix-call/actions/runs/38525708297) passed package/container and encrypted media checks, but failed a whole-prompt substring history assertion on the first restored-image turn. Its log did not retain provider message roles or the matched phrase, so it cannot establish why that substring matched. The harness now checks exact ordered user/assistant counts and contents in both the actual provider request and public host history, plus exactly one current host session. Common prompt vocabulary cannot stand in for previous-call evidence; extra or duplicated user/reply records remain failures.

The completed local run passed all four speech turns, host-history checks, native leave cancellation and Gateway-stop cancellation. The first encrypted synthesized output was observed after these times from input playback start:

| Runtime | Korean | English |
| --- | --- | --- |
| Native browser driver | 17.88 s | 10.10 s |
| Restored browser image | 16.50 s | 9.96 s |

These are one development-host run with the multilingual `base` model and a deterministic provider. They include input playback, recognition, SDK dispatch and synthesis; they are neither model-inference timings nor a target-laptop benchmark. Every observed active output frame was encrypted.

## Remaining work

The optional [live-model check](live-model-integration.md) now passes concise actual `gpt-6.1-sol` responses through this encrypted speech path in both worker runtimes, plus longer bounded responses in the native driver. Host history and fresh sessions remain verified. Separate actual host cancellation and authentication-failure checks also pass. Its separate report records actual inference; ordinary CI continues to use the deterministic provider.

Longer restored-image replies, broader provider failure/reconnect behavior, live Matrix chat command entry, sustained-call stability, coordinated replacement, clean operator enrollment/setup and released-client interoperability still gate a calling release. Recognition, enrollment and later-input inconsistencies observed during development remain investigations. The native channel and worker continue to report assistant readiness unavailable.
