# Development

Use Node.js 24.16.0 and pnpm 10.28.2. OpenClaw 2026.10.2 requires Node.js `>=24.16.0 <25 || >=26.1.0`.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm check
```

The project tests the actual pinned OpenClaw SDK. Dependency installation permits only esbuild's build script; other dependency lifecycle scripts are not needed for source development. Runtime installation is validated separately against a supported Gateway.

Coverage is enforced per file at 100% for statements, branches, functions, and lines across the plugin, shared core, and worker runtime sources. Generated bundles, dependencies, tests, and build tooling are outside the runtime coverage scope. Build and package checks validate those artifacts separately.

Tests must exercise security decisions, invalid inputs, cancellation, concurrency, failure recovery, and transport boundaries. Full unit coverage does not establish Matrix calling interoperability. The release process also requires a real encrypted call with actual audio.

Build output and coverage reports are generated locally and are not committed. Explain design changes in Markdown rather than adding source comments.

`pnpm build` bundles the portable core, voice coordinator, and HTTP agent/speech adapters under `dist/`, and the native plugin under `packages/openclaw-plugin/dist/`. `pnpm verify:artifacts` loads these outputs, checks native plugin metadata, and verifies that portable bundles have no OpenClaw SDK dependency or other external package requirement. The plugin leaves public OpenClaw SDK imports external so the host supplies the tested SDK.

The OpenClaw adapter's runtime boundary is described in [ADR 0004](adr/0004-delegated-openclaw-ingress.md). Its current turns are delegated and tool-free. SDK registration tests do not establish model-backed execution or RTC audio support. The optional [live-model check](live-model-integration.md) uses a private access-only snapshot of an existing operator login to verify actual text inference and host-history recall. Its fake-credential validation runs in ordinary `pnpm check`; hosted model access is never required by CI.

When changing the native channel configuration shape, run `pnpm schema:sync` and commit the manifest change with the source change. Artifact verification checks that `channelConfigs.matrix-call.schema` matches the runtime channel schema. This metadata lets a host validate configuration before loading plugin code.

`pnpm check` also starts the standalone worker and installs a packed plugin in a disposable OpenClaw profile. The install check accepts capabilities only inside that isolated profile; it never dispatches an agent or starts a call. Production installation remains a separate operational action.

To check the container, build `deployment/worker.Dockerfile` with the `matrix-call-worker:0.1.0-alpha.1` tag and run `pnpm verify:container`. It uses a temporary secret and removes its test container afterward. GitHub Actions runs these same standard commands; local development and other CI hosts do not require GitHub APIs or marketplace access.

For actual encrypted WebRTC audio, run `pnpm browser:install` and `pnpm verify:media`. This separate integration check starts temporary local infrastructure and sandboxed browsers; see [media integration](media-integration.md) for its evidence and scope.

Run `pnpm verify:matrix` to add a disposable Synapse homeserver, persistent device trust, encrypted MatrixRTC key delivery, actual participant verification, and audio across restart/rejoin. See [Matrix integration](matrix-integration.md) for the tested protocol mode and remaining production gaps.

The optional [browser worker](browser-worker.md) is built under `dist/browser-worker`, including local browser assets, crypto WASM, E2EE and capture worklets, and dependency notices. Its Node host keeps Matrix and LiveKit SDKs in the browser bundle and leaves only Playwright external. Artifact checks enforce these boundaries and align image build dependencies with the workspace. Node-side Zod and Playwright notices are included alongside browser dependency notices.

Build `deployment/browser-worker.Dockerfile` with tag `matrix-call-browser-worker:0.1.0-alpha.1`, then run `pnpm verify:browser-sandbox` and `pnpm verify:browser-container`. These checks preserve Chromium sandboxing, drop container capabilities, and use private temporary state. The latter includes the complete Matrix integration check and exercises the production image with the same persisted device profile. GitHub Actions runs these commands on its disposable runner. Runtime instructions and seccomp provenance are documented in [Browser worker](browser-worker.md).

Both `pnpm verify:matrix` and the image check exercise the real voice capture path against signed local speech/agent protocol fixtures. They validate audio-to-agent routing, two-turn history, actual STT request cancellation, encrypted synthesized output and fresh history after container restart. Fixtures analyze test tones and return deterministic text/PCM; they do not run a speech or language model. Always build artifacts before starting integration checks, and do not rebuild `dist` while an integration process uses it.

The optional speech package is built under `dist/speech-worker` and has no Matrix, browser or OpenClaw SDK dependency. Build `deployment/speech-worker.Dockerfile` as `matrix-call-speech-worker:0.1.0-alpha.1`, then run `pnpm verify:speech` for real Korean/English recognition and synthesis with the multilingual `base` model. Run `MATRIX_CALL_SPEECH_TEST_MODEL=small pnpm verify:speech` for the larger alternative. These checks download only pinned public model artifacts into ignored `.cache/speech`, verify their size/hash, and use disposable constrained containers and attributed public clips. No participant recordings or hosted accounts are used. See [speech evidence](speech-integration.md) for latency and quality limits.

`pnpm speech:model [base|small]` prepares a pinned model for development/operator use; runtime startup never downloads one. `pnpm verify:speech-compose` validates the optional shared-loopback deployment without starting services. Instructions are in [local deployment](local-speech-deployment.md), and the service decision is recorded in [ADR 0010](adr/0010-optional-local-speech-service.md). GitHub Actions runs both model checks in a separate job; newer runs cancel superseded checks for the same branch.

With both speech and browser images built and test Chromium installed, run `pnpm verify:matrix-speech` to add real local speech to the encrypted Matrix harness. It checks Korean/English public clips, actual Matrix caller admission, real synthesized output, leave cancellation and restored image profiles. Playback gain and the continuous English phrase are controlled test inputs. Native-driver diagnostics retain counts and energy only; the image runs without that instrumentation. See [Matrix evidence](matrix-integration.md#real-speech-through-matrix). Agent dispatch remains a signed deterministic fixture, and intermittent enrollment/input stability remains release work. The speech CI job builds both images and runs this command after the standalone model checks.
