# Local operator Compose integration

Checked locally: 2026-10-15. `pnpm verify:operator-setup` starts an empty disposable OpenClaw profile with the actual packed plugin and both workers through the published local-Gateway Compose files. It targets a native Gateway on the same Linux Docker host, not a remote or unrelated containerized Gateway.

## Reproduction

Use the pinned Node/pnpm versions, Docker and test Chromium. Build bundles and clean source-labelled worker candidates before running:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm browser:install
pnpm release:images
pnpm verify:operator-setup
```

The fixture uses the base browser, voice and local-speech files plus `browser-local-gateway.compose.yml`. It supplies private credentials, public device pins, independent HMAC keys and a verified `base` model. There is no production account or model credential in the ordinary run. The installed Gateway uses public SDK dispatch with a deterministic provider, while recognition, synthesis, Matrix messaging and encrypted audio are real.

Only test ownership, profile binding and a passive preload override deployment settings. The private profile bind is empty at first start and persists across replacement. The preload observes real completion and invokes the actual verifier; it does not supply a key, identity proof, plaintext audio result or model reply. Worker CPU/RAM/PID limits, read-only roots, dropped capabilities and Chromium isolation remain active. Gateway profiles, operator tokens and provider credentials are not worker mounts.

The unmodified Element Call 0.28.0 application sends Korean/English public clips and receives actual synthesized media. Eleven encrypted `/matrixcall` commands/replies cover entry, exact-session cleanup and an empty session after replacement. Two first-call turns retain ordered history; the next Korean turn has a different conversation UUID and independent host history.

The Gateway and speech service get new authentication audiences. Freshly signed requests using the previous audiences return 401 before inference or recognition. The worker retains its Matrix device keys when recreated, and no previous call or model turn is replayed. The original deterministic operator run passed all three turns and cleanup with these replacement checks.

The rebuilt readiness image also passes the complete setup with actual `openai/gpt-6.1-sol` inference, the existing `openclaw` runtime and `high` thinking. `/readyz` returns 200 before speech, 503 after replacing the agent backend while retaining the old worker, and 200 after explicit coordinated recovery. The Gateway's worker-control client reconnects through a fresh service instance while the worker is absent. All eleven encrypted controls, three spoken replies, two independent histories and orderly resource cleanup pass. No deterministic provider request occurs. The image source is `207ea5f22d0d7725a3a66f063de9575a4cd1eb73`; its browser ID is `sha256:a9b23969f6fa2337c05c06807682f1a508f84da1253e69cfed16bea9cf1a7948`.

| Call / language | Reply characters | First audio |
| --- | --- | --- |
| First / Korean | 29 | 23.44 s |
| First / English | 97 | 14.84 s |
| After replacement / Korean | 27 | 23.00 s |

These development-host timings include input playback, recognition, model inference and synthesis. They are not a target-host measurement or latency guarantee. The optional command is `MATRIX_CALL_LIVE_MODEL_FILE=/absolute/private/model.json pnpm verify:operator-setup-live`; use the private access-only preparation in [live model integration](live-model-integration.md).

The ignored default report is `.cache/speech/released-client-operator-result.json`; actual inference writes `released-client-operator-live-result.json`. `MATRIX_CALL_OPERATOR_REPLACEMENT=0 pnpm verify:operator-setup` instead checks leave/rejoin without replacing workers and writes `released-client-operator-rejoin-result.json`.

## Limits and observed failures

The initial no-replacement run passed Korean/English but timed out receiving second-call output; its browser stop also returned 143 instead of zero. That trace lacked the later passive worker diagnostics. The subsequent diagnosed no-replacement run passed without a production-code change. Its success does not establish a cause or fix for the first failure. Retain sustained-call/input/network stability as separate investigation.

An updated readiness run confirmed availability before speech and rejection after backend replacement, then failed Gateway control authentication. The Gateway had negotiated the old worker's audience before that worker was replaced. Explicitly restarting Gateway control while the worker is absent is required; automatic audience adoption would violate the ownership boundary. The passing fixture exercises this recovery with authentication and discovery rules unchanged.

Another attempt passed the functional checks but failed because concurrent cleanup removed a Compose container before its own cleanup command completed. Fixture cleanup now closes Gateway, browser, speech and application sequentially and attempts every close even after an error. A nonzero container exit or OOM still fails the test.

This test does not establish a separate-namespace HTTPS proxy route, physical microphone quality, arbitrary clients or target-server resource/latency results. Installation of a published registry package remains a distinct final distribution check. See [readiness](readiness.md), [operator setup](operator-setup.md) and [release readiness](release-readiness.md).
