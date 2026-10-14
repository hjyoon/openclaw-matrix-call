# OpenClaw Matrix Call

A portable Matrix calling core, an OpenClaw adapter, and an isolated RTC worker for conversations with AI agents.

The project targets public distribution through ClawHub. Development starts with explicit room and caller authorization, independent call sessions, and encrypted MatrixRTC interoperability.

Agent runtimes, model providers, speech services, and persistence use replaceable interfaces. Element is one interoperability target; Matrix protocol support must not depend on a particular client brand. See [Portability](docs/portability.md) and [Matrix compatibility](docs/matrix-compatibility.md).

Current development rules live in [AGENTS.md](AGENTS.md). Architectural decisions and changes are recorded in [ADRs](docs/adr/README.md).

This repository is under active development. The native OpenClaw package registers a channel descriptor, optional [signed agent service](docs/native-agent-service.md) and [owner/admin media controls](docs/native-worker-control.md). Its Matrix command and administrator RPC can join or leave a separately provisioned worker; installing the package alone cannot provide calls. See [public release readiness](docs/release-readiness.md) for the remaining integration and setup requirements.

The portable core, agent adapters, worker control/media APIs and MatrixRTC key/identity/focus authorization components are implemented. The optional [browser worker](docs/browser-worker.md) provides a sandboxed runtime, explicit device enrollment and private persistent profiles. Its [voice pipeline](docs/voice-pipeline.md) connects verified capture to replaceable speech and agent HTTP services, with bounded sequential output and fresh authorization for every piece. SDK peers pass encrypted audio, authorization-service token exchange, device persistence and restart/rejoin in the production driver and image. The optional [local speech worker](docs/speech-worker.md) passes Korean/English turns through that encrypted Matrix path, including recognition cancellation and restored image profiles. The [native Matrix check](docs/native-matrix-integration.md) runs installed OpenClaw SDK dispatch and Gateway-owned media control with a deterministic provider. An optional [live-model check](docs/live-model-integration.md) passes actual Korean/English speech and host history in both worker modes, longer native replies and actual host cancellation/authentication failures using an existing operator login. [Element Call 0.28.0](docs/released-client-integration.md) also passes actual Korean/English speech and independent call history after leave/rejoin in standalone compatibility mode. Broader client/protocol support, clean operator setup and input/session stability remain unfinished; assistant readiness stays false. See [implementation status](docs/implementation-status.md).

Use Node.js 24.16.0 and pnpm 10.28.2, then run `pnpm install --frozen-lockfile` and `pnpm check`. Runtime coverage is enforced at 100% per file. See [Development](docs/development.md) for container checks and [Worker](docs/worker.md) for the development control plane.

For real media checks, run `pnpm build`, `pnpm browser:install`, `pnpm verify:media`, and `pnpm verify:matrix`. These commands use disposable local infrastructure and sandboxed browsers. See [MatrixRTC integration evidence](docs/matrix-integration.md) for the tested stack and protocol mode.

For real local speech checks, build `deployment/speech-worker.Dockerfile` as `matrix-call-speech-worker:0.1.0-alpha.1` and run `pnpm verify:speech`. See [speech integration evidence](docs/speech-integration.md) for model selection, measured limits and fixture provenance, and [local deployment](docs/local-speech-deployment.md) for the optional private Compose configuration.

Build the browser image as `matrix-call-browser-worker:0.1.0-alpha.1`, install test Chromium with `pnpm browser:install`, then run `pnpm verify:matrix-speech` for real engines through encrypted Matrix audio in both the production driver and restored image. The check uses disposable infrastructure and public speech clips, not production accounts or participant recordings.
