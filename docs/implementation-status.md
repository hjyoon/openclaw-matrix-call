# Implementation status

Updated: 2026-10-13. This is the current development baseline; earlier server setup and the community voice-plugin audit are background, not deployment instructions for this repository.

## Current scope

- The repository is `hjyoon/openclaw-matrix-call`, with small commits pushed to `main`.
- Source, documentation, tests, and commit messages are in English. Design explanations belong in Markdown, with source comments kept minimal.
- Agent portability includes frameworks, model providers, conversation data, and authorization. OpenClaw is an adapter; the core does not import it.
- Matrix compatibility is defined by protocol capabilities. Element is one client to test. MatrixRTC and legacy Matrix VoIP need separate adapters.
- Runtime coverage requires 100% statements, branches, functions, and lines per file. Coverage does not prove real encrypted audio interoperability.
- The initial policy accepts explicitly configured owners, rooms, and logical agents. General-user approval is a later integration requiring an end-to-end authorization test.
- No production server deployment, Matrix user messaging, or marketplace publication has been performed as part of repository development.

Decision rationale and changes are recorded in [ADRs](adr/README.md). This status document describes implementation evidence, not a second set of development instructions.

## Implemented and checked

- Portable agent, speech, RTC, verification, and persistence interfaces.
- Strict caller policy and verification checks.
- Independent call lifecycle with concurrency limits, repeated caller verification, cancellation, and ordered persistence.
- Immutable conversation records with validated versioned JSON export/import.
- Dedicated HTTP message authentication with replay protection and process-incarnation binding.
- Portable agent HTTP protocol and adapter, including a complete core turn against a real local test service.
- Native channel registration through the actual pinned OpenClaw SDK, with a delegated, tool-free agent adapter and a status command.
- A packed plugin installed and loaded in a disposable OpenClaw profile, including cold channel configuration metadata.
- An authenticated worker control plane, secret-file configuration, cancellation-safe shutdown, and standalone process checks.
- A pinned worker image tested with a non-root user, read-only filesystem, dropped Linux capabilities, and no OpenClaw SDK.
- GitHub Actions checks using the same local build, coverage, installation, and container commands.
- A browser-safe MatrixRTC package with pinned public Matrix/LiveKit SDKs and a per-participant WebCrypto key provider. Imports that finish after call or membership invalidation are discarded.
- Authenticated remote-key admission matching Rust crypto sender/device evidence to the current room-scoped MatrixRTC membership, with expiry, scope, ambiguity, and lifecycle checks.
- A participant verifier binding public SDK membership identities to connected encrypted LiveKit audio, with fresh device-trust checks and bounded core proofs.
- Locally generated outbound keys distributed through the public encrypted Matrix API only after listener authorization and device verification. Local sending indices remain independent of remote rotations.
- Real bidirectional encrypted LiveKit audio using the repository key provider in sandboxed Chromium, including wrong-key rejection with continued RTP traffic, recovery, and key rotation. This media-layer check supplies test keys directly; see [evidence and limits](media-integration.md).
- Real MatrixRTC state membership and encrypted per-device key delivery against Synapse, followed by bidirectional encrypted audio and actual participant verification. Restart/rejoin preserves device trust while requiring fresh call keys; see [evidence and limits](matrix-integration.md).
- An explicit OpenID focus authorization adapter with trusted endpoints, room/identity binding, grant checks, bounded streaming responses, cancellation, and membership fencing. Actual authorization-service integration is tracked separately.

`pnpm check` and the worker container check pass locally. The current suite has 383 passing tests, with 100% per-file runtime coverage. Tests use isolated fixtures, temporary profiles, and local test services. GitHub Actions has also passed package installation, full coverage, image build, and container checks.

## Remaining release work

- MatrixRTC focus discovery/authorization, production device enrollment and worker wiring, automated membership-driven publication suspension/key rotation, modern sticky membership, and the browser-worker image.
- Legacy VoIP transport implementation.
- Speech provider adapters and the complete STT/agent/TTS audio pipeline.
- Model-backed OpenClaw dispatch and a supported privileged execution/approval path. The pinned SDK does not allow a community plugin to admit owner authority; see [ADR 0004](adr/0004-delegated-openclaw-ingress.md).
- Real encrypted audio interoperability with documented client versions, including a non-Element client where compatible calling support exists.
- Marketplace validation, source provenance, release assets, and publication setup.

Synthetic Matrix SDK peers have passed real encrypted audio tests. No released Matrix client application has passed interoperability testing yet. The worker still reports `ready: false`; the repository is a development baseline, not a deployable calling release.
