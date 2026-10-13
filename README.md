# OpenClaw Matrix Call

A portable Matrix calling core, an OpenClaw adapter, and an isolated RTC worker for conversations with AI agents.

The project targets public distribution through ClawHub. Development starts with explicit room and caller authorization, independent call sessions, and encrypted MatrixRTC interoperability.

Agent runtimes, model providers, speech services, and persistence use replaceable interfaces. Element is one interoperability target; Matrix protocol support must not depend on a particular client brand. See [Portability](docs/portability.md) and [Matrix compatibility](docs/matrix-compatibility.md).

Current development rules live in [AGENTS.md](AGENTS.md). Architectural decisions and changes are recorded in [ADRs](docs/adr/README.md).

This repository is under active development. A working encrypted call is a release requirement, not an assumed capability.
