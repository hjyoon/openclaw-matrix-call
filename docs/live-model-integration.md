# Optional live model integration

Checked locally: 2026-10-14. This workflow tests an existing operator login in disposable infrastructure. It does not install or configure a production calling service.

## Private configuration

Use the pinned OpenClaw 2026.10.2 SDK and a supported Node version. Prepare a private directory outside the repository with mode `0700` and a regular, singly linked `model.json` file with mode `0600`, owned by the test user. The file has this shape:

```json
{
  "schemaVersion": 1,
  "model": "openai/gpt-6.1-sol",
  "settings": { "agentRuntime": { "id": "openclaw" } },
  "thinking": "high",
  "credential": {
    "type": "oauth",
    "provider": "openai",
    "access": "EXISTING_VALID_ACCESS_TOKEN",
    "refresh": "",
    "expires": 0
  }
}
```

Replace the model, model-scoped settings, thinking level and credential metadata with the existing operator configuration. `expires` is the credential's real expiry in Unix milliseconds and must be at least ten minutes in the future. Optional credential fields are `accountId` and `chatgptPlanType`. Unknown credential fields are rejected. Do not copy refresh tokens, setup descriptors or an entire auth database. Do not put credentials in shell arguments or repository files.

The existing auth store can be read with public `loadAuthProfileStoreWithoutExternalProfiles` from `openclaw/plugin-sdk/agent-runtime`; this avoids discovery/import of external credentials. Export only the selected profile's access token, expiry and necessary account metadata. The integration never writes the source store. This snapshot workflow is an optional test adapter, not a portable-core authentication requirement or a general login export format.

The helper validates the private input and writes the credential using public `saveAuthProfileStore` in a child process with isolated `HOME`, `OPENCLAW_HOME`, state and config paths. Its agent directory must remain beneath that state directory, and `copyToAgents` is false. The packed plugin and selected provider are explicitly allowed in that disposable profile. The packer alone uses the developer's normal home to resolve the pinned pnpm installation; Gateway processes do not inherit ambient provider credentials.

## Actual model and history check

Build artifacts before running:

```sh
pnpm build
MATRIX_CALL_LIVE_MODEL_FILE=/absolute/private/model.json pnpm verify:agent-live
```

The check installs the packed plugin into a fresh Gateway, sends Korean and English greetings through its signed agent endpoint, and asks the actual model to recall a randomly generated code from an earlier Korean turn. The recall request supplies only the latest message, so the prior code must come from host session history. English uses a separate conversation. Synthetic test caller proofs do not establish Matrix identity or media support.

A transparent observer verifies original signed requests and replies without constructing identity evidence or re-signing traffic. Public Gateway `sessions.list` results must identify the configured model/provider with generated output tokens. Public `chat.history` results must contain exactly the expected user and assistant turns in order. The fixture provider must receive no requests. Logs contain reply hashes/lengths, timings and safe model metadata rather than full replies or credentials. Test Gateway profiles are removed on completion; delete the input snapshot after use.

The local check used `openai/gpt-6.1-sol`, the existing `openclaw` runtime and `high` thinking. Actual greetings, cross-turn code recall and both isolated session histories passed.

## Actual model through encrypted Matrix speech

Prepare the images and test Chromium as described in [native Matrix integration](native-matrix-integration.md), then run:

```sh
MATRIX_CALL_LIVE_MODEL_FILE=/absolute/private/model.json pnpm verify:matrix-live
```

This command requires valid private settings before starting infrastructure. Missing credentials fail instead of selecting a fixture. The ordinary `verify:matrix-gateway` mode remains deterministic and requires no hosted account.

The local live run passed four actual model-backed speech turns: Korean and English in the production driver, then both languages in the restored browser image. Each turn used real encrypted input, current Matrix owner/device verification, whisper.cpp recognition, the installed signed native agent service, public SDK model dispatch, eSpeak synthesis and encrypted output. Required fixture keywords and audio/encryption assertions remain unchanged.

Signed replies matched their original conversation/turn IDs. The second portable transcript contained the actual first model reply. Public Gateway history contained exactly one user/reply pair after the first turn and two after the second, in order. Each fresh Gateway contained only the current call's session, while the browser image retained its Matrix device keys. All four session observations identified `openai/gpt-6.1-sol` with generated output tokens, and the deterministic provider received zero requests.

| Runtime | Korean first output | English first output |
| --- | --- | --- |
| Native browser driver | 22.48 s | 13.16 s |
| Restored browser image | 28.04 s | 13.80 s |

Times start at input playback and include input duration, recognition, actual model inference and synthesis. They describe one development-host run with `base` recognition and `high` thinking; they are not target-server measurements or a latency guarantee. Every observed active output frame was encrypted. Replies were 30/97 characters in the native driver and 43/98 in the image. The workspace requests one concise sentence; unrestricted answer lengths are not established.

Native leave canceled an actual recognition child and removed its private WAV. Gateway SIGTERM during image recognition closed the exact owned call, canceled recognition and removed its input without another agent turn. The browser/speech containers exited successfully with no OOM, and the browser retained renderer PID/seccomp isolation.

The separate ignored report `.cache/speech/matrix-live-integration-result.json` records timings, reply hashes/lengths, safe model metadata and `modelInference: true`. It leaves `releasedClient: false`: peers are Matrix SDK fixtures rather than released applications. This report does not overwrite deterministic evidence. Initial enrollment failed in an earlier attempt and remains an investigation recorded in [Matrix evidence](matrix-integration.md).

## Longer actual model responses

The optional long-response mode uses the same private login, public SDK dispatch, speech engines and encrypted Matrix path:

```sh
MATRIX_CALL_LIVE_MODEL_FILE=/absolute/private/model.json pnpm verify:matrix-live-long
```

Its native driver requests a longer explanation in each input language. The speech observer checks the original request and response signatures, matching synthesis request IDs and complete non-whitespace model text across successful pieces. It forwards original bytes and authentication rather than re-signing traffic. The native coordinator must finish every publication before the harness can admit the next turn. Each generated piece remains at most ten seconds; total generated audio is limited to sixty seconds and at most 64 synthesis attempts within the existing turn deadline. Typed duration limits permit further subdivision, while ordinary failures and model requests are not retried.

| Native language | Successful pieces | Generated speech | First encrypted output |
| --- | --- | --- | --- |
| Korean | 4 | 28.31 s | 31.26 s |
| English | 6 | 19.21 s | 17.22 s |

Both native turns passed with the actual configured model, producing 201 Korean and 312 English characters. Every observed active output frame was encrypted; signed replies and exact ordered public host histories remained intact. Times describe one development-host run with `base` recognition and `high` thinking. The restored-image portion intentionally retains concise replies because its ordinary cross-process completion observation does not expose the coordinator's busy state. Longer image replies are not established by this mode.

Two earlier native attempts failed during MatrixRTC membership updates. Suspension stopped an active buffer and the starting-revision check rejected even a freshly authorized update. [ADR 0017](adr/0017-reauthorized-playback-resume.md) records the fix: suspend output immediately, retain the remaining bounded buffer, and resume only after current listener/device/key authorization. Stale source callbacks cannot complete resumed playback; revocation, cancellation and closure remain terminal. The passing long-response run exercised multiple membership updates without weakening authority or output checks.

The first post-fix attempt passed both long native turns and concise Korean image output, then timed out awaiting the image's English input. Its cause was not established. A separately instrumented attempt passed the complete check, including concise image output of 5.09/5.99 seconds, native leave cancellation and Gateway-stop recognition cancellation. Before image English input, scalar probes recorded one completed publication, one input delivery and one capture resume. This successful observation does not explain or resolve the preceding timeout.

Set `MATRIX_CALL_CAPTURE_DIAGNOSTICS=1` to add the disposable image's passive Node preload. It counts worklet chunks, acknowledgements, energy, input deliveries, capture resumes and publication completion, writing an atomic private snapshot inside the temporary test volume. It retains no PCM, transcripts, replies or credentials. The preload does not control playback, retries, identity or test admission; all original speech, encryption, history and cleanup assertions remain mandatory. It is not part of the production image or operator setup.

## Actual model cancellation and authentication failure

After building artifacts, run the opt-in failure check with the same private settings:

```sh
MATRIX_CALL_LIVE_MODEL_FILE=/absolute/private/model.json pnpm verify:agent-failures-live
```

The cancellation check subscribes through the public Gateway SDK, observes an admitted active model run, and aborts the original signed request after the first actual assistant text event. The host must settle the run, and a new independent conversation must receive a real reply. Events retain identifiers rather than generated text. This passed with the selected `openai/gpt-6.1-sol` model; it establishes host settlement after model activity, not direct observation of the provider's network connection closing.

The authentication check changes only the access token in a disposable, refresh-free copy. Two explicit user attempts through the actual installed host must fail, close their portable records, clear the busy state and use distinct conversation IDs. No synthesis or publication occurs, and the voice coordinator does not resubmit either agent turn automatically. The deterministic provider receives no requests. Synthetic recognition, caller proofs and transport isolate this host-error test from the separate real Matrix checks. It does not simulate arbitrary provider outages or measure retries inside a model provider.

Both local checks passed. The input login and source auth store remain unchanged, and the altered copy and Gateway profiles are removed on completion.

## Limits

The operator's source login and production configuration remain unchanged. Snapshot state is temporary, has no refresh owner and is removed on completion; the operator removes the input snapshot after testing. No production Matrix messages, calls or plugin deployment are part of this workflow.

The native adapter still uses delegated, tool-free ingress. Broader provider failures and reconnect behavior, sustained calls, human pronunciation quality, target-server resources, operator enrollment and combining live inference with released-client entry remain release work. The separate [Element Call check](released-client-integration.md) passes actual speech and leave/rejoin with deterministic provider text. Speech remains bounded by the piece and whole-turn limits in [ADR 0016](adr/0016-bounded-segmented-speech.md); unrestricted answer lengths are unavailable. See [release readiness](release-readiness.md).

## Ordinary checks

`pnpm verify:live-model` uses fake credentials to check expired input, rejected refresh ownership, unexpected metadata, malformed/oversized input, symlink/hardlink rejection, private modes, isolated SDK storage and redacted preparation failures. It is included in `pnpm check`. Ordinary CI does not use an operator login or call a hosted model. Deterministic provider and encrypted Matrix checks remain independently reproducible.
