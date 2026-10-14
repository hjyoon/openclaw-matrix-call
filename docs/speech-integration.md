# Local speech integration evidence

Checked: 2026-10-14.

Whisper results containing only one or more `[BLANK_AUDIO]` markers, including lowercase variants and whitespace, are normalized to an empty transcript. The voice coordinator treats that as silence without creating or advancing an agent conversation. Spoken text containing the literal marker remains unchanged. This prevents an observed no-speech result from being sent to the model; it does not establish reliable recognition or repair missing input. Temporary WAV and result-buffer cleanup also apply to this path.

Build artifacts with `pnpm build` and build `deployment/speech-worker.Dockerfile` as `matrix-call-speech-worker:0.1.0-alpha.1` before running these checks.

`pnpm verify:speech` starts a disposable non-root image with a read-only root, all capabilities dropped, no privilege gain, 1,536 MiB RAM, no additional swap, two CPUs and 128 PIDs. It uses the [public Korean and English fixtures](../tests/fixtures/speech/README.md), real signed speech requests and a signed deterministic agent fixture. Both turns pass through the portable voice coordinator, preserve one call's history and produce non-silent 22,050 Hz PCM. Identity and output transport are fixtures; this is not a released-client or complete Matrix speech-call test. The existing Matrix integration also checks encrypted publication of 22,050 Hz fixture audio through the production browser driver.

The check rejects a concurrent authenticated operation, aborts an actual recognition request, confirms the child exits and its input WAV is removed, then verifies another synthesis can run. It checks graceful shutdown, source/license availability, and absence of Matrix, browser or OpenClaw dependencies. Reports are written under `.cache/speech/integration-result-<model>.json` and contain timings and counts rather than transcripts. To select the larger model, run `MATRIX_CALL_SPEECH_TEST_MODEL=small pnpm verify:speech`.

Across the serial and concurrent development-host checks, each service used the stated two-CPU limit. The Korean 4.68-second clip and English eight-second clip took 9.3–14.4 and 10.4–12.8 seconds with `base`, compared with 30.8–44.1 and 28.5–35.7 seconds with `small`. Synthesis requests took 26–101 ms and generated approximately 1.30 seconds of Korean and 2.02 seconds of English speech. These are single-run service timings, not a benchmark or measurements from the target laptop. The examples therefore use `base` as the CPU baseline. Recognition checks match a few expected words; both models made Korean transcription errors. Natural pronunciation and broader recognition quality remain unvalidated.

The container check also starts a separate peer in the service's network namespace. It can reach loopback health but cannot see the model or secret mounts, and an unsigned synthesis request is rejected. Sharing loopback connectivity does not share credentials or filesystems.

## Longer local synthesis

The same standalone check sends prepared Korean and English responses that exceed the engine's ten-second single-result limit. A direct request must return the authenticated, request-bound `synthesis-too-long` result. The portable coordinator then delivers each complete response through sequential bounded pieces, verifying authority before generation and publication. Only that explicit duration result permits subdivision; ordinary failures are terminal. The agent fixture is called once per response, and concatenated synthesis inputs must preserve every non-whitespace character.

| Language | Prepared characters | Successful pieces | Generated speech |
| --- | --- | --- | --- |
| Korean | 164 | 3 | 24.66 s |
| English | 359 | 6 | 21.72 s |

These local `base`-model checks passed with the real speech image. Each piece is non-silent and at most ten seconds; the coordinator allows at most 64 synthesis attempts and 60 seconds of generated audio within the turn deadline. Identity, agent and output transport are fixtures. This establishes actual signed engine limits and complete bounded synthesis, not audible pronunciation quality or Matrix delivery. See [ADR 0016](adr/0016-bounded-segmented-speech.md) and the separate [live model evidence](live-model-integration.md).

## Combined encrypted Matrix check

`pnpm verify:matrix-speech` uses the same speech image with `base` and the production browser image. Korean and English public clips travel through an encrypted Matrix microphone, real capture and participant verification, actual recognition/synthesis engines and encrypted output. The agent service remains a deterministic fixture; Matrix identity and transport are real. Both the native driver and restored image pass two-turn history, fresh conversation state, child cancellation on leave, input-file removal and shutdown checks.

Playback is peak-normalized and the English input is the continuous three-second phrase at seconds 5–8 of the original fixture. This differs from the full eight-second standalone recognition input. The [Matrix evidence](matrix-integration.md#real-speech-through-matrix) records timing, diagnostic instrumentation and unresolved stability/quality limits. This establishes the speech-service connection to the Matrix path, not native Gateway model dispatch or released-client support.

`pnpm verify:matrix-gateway` replaces the separate agent fixture with an installed native Gateway and deterministic model-provider endpoint, and drives actual media through the administrator RPC. The [native Matrix evidence](native-matrix-integration.md) records four Korean/English turns, host history and recognition cancellation on native leave and Gateway shutdown. CI uses this combined check after building both images. Actual AI inference and released-client interoperability remain separate requirements.

The [2026-10-14 CI run for `9c1a220`](https://github.com/hjyoon/openclaw-matrix-call/actions/runs/38497499888) failed the Korean keyword assertion after admitting a 5.32-second captured segment. Package/container and encrypted media jobs passed, as did the preceding standalone speech checks. That run did not report the recognized text, so the missing word and capture/recognition cause cannot be established from its log. Recognition consistency joins enrollment and later-input timing as an unresolved release gate.

On a future keyword mismatch, the isolated Matrix harness emits `matrix-speech-recognition-mismatch` with fixture provenance, input duration, expected/missing keywords and at most 512 recognized characters. This diagnostic belongs only to the disposable test using public prerecorded fixtures. Production logging and participant transcripts are unchanged. All required keywords, encrypted output, history and cancellation assertions remain mandatory; the harness neither retries nor substitutes speech results to turn a mismatch into a pass.
