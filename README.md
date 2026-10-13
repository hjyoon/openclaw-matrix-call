# OpenClaw Matrix Call

A portable Matrix calling core, an OpenClaw adapter, and an isolated RTC worker for conversations with AI agents.

The project targets public distribution through ClawHub. Development starts with explicit room and caller authorization, independent call sessions, and encrypted MatrixRTC interoperability.

Agent runtimes, model providers, speech services, and persistence use replaceable interfaces. Element is one interoperability target; Matrix protocol support must not depend on a particular client brand. See [Portability](docs/portability.md) and [Matrix compatibility](docs/matrix-compatibility.md).

Current development rules live in [AGENTS.md](AGENTS.md). Architectural decisions and changes are recorded in [ADRs](docs/adr/README.md).

This repository is under active development. The portable core, agent adapters, native plugin registration, worker control plane, and MatrixRTC key/identity components are implemented. Synthetic Matrix SDK peers pass encrypted bidirectional audio, device persistence, and restart/rejoin tests. Production transport wiring, focus authorization, speech integration, and client interoperability remain unfinished; no calling release is ready. See [Implementation status](docs/implementation-status.md).

Use Node.js 24.16.0 and pnpm 10.28.2, then run `pnpm install --frozen-lockfile` and `pnpm check`. Runtime coverage is enforced at 100% per file. See [Development](docs/development.md) for container checks and [Worker](docs/worker.md) for the development control plane.

For real media checks, run `pnpm browser:install`, `pnpm verify:media`, and `pnpm verify:matrix`. These commands use disposable local infrastructure and sandboxed browsers. See [MatrixRTC integration evidence](docs/matrix-integration.md) for the tested stack and protocol mode.
