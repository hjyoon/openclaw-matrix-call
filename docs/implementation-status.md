# Implementation status

Updated: 2026-10-14. This is the current development baseline; earlier server setup and the community voice-plugin audit are background, not deployment instructions for this repository.

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
- An explicit OpenID focus authorization adapter with trusted endpoints, room/identity binding, grant checks, bounded streaming responses, cancellation, and membership fencing. The real Matrix/audio harness obtains tokens through authorization service 0.8.0 with SFU automatic room creation disabled.
- A portable worker media controller with configured room access, independent session IDs, capacity reservation, cancellation/timeouts, late-completion fencing, and idempotent backend cleanup.
- Authenticated media status/join/leave HTTP endpoints with signed results and errors, replay/path binding, request-disconnect cancellation, and injected transport shutdown. Assistant readiness remains unavailable.
- Real worker media-control HTTP requests driving the encrypted Matrix/LiveKit browser harness, including configured-room rejection, signed session responses, leave, and fresh sessions after restart.
- An optional production browser package with strict external credential configuration, actual token/user/device binding before crypto initialization, explicit fingerprint pinning, persistent device-key manifests, stable loopback origins, and exclusive private profiles.
- Fresh MatrixRTC/media resources per call, authenticated-key admission before remote audio subscription, immediate playback suspension on membership changes, serialized listener verification/key rotation, and bounded reauthorization of discarded membership snapshots.
- A pinned browser-worker image and Compose example retaining Chromium's namespace and Seccomp-BPF sandboxes with non-root execution, a read-only root, dropped capabilities, a private data volume, and a documented Moby-derived seccomp policy.
- Production-driver encrypted PCM publication and participant verification against real isolated infrastructure, including preserved device keys, fresh worker sessions, and restart/rejoin. See [Browser worker](browser-worker.md) for configuration and remaining limits.
- The production browser image restoring the same device profile, exchanging authenticated Matrix keys, connecting through the actual authorization service, retaining extra PID/seccomp isolation, and shutting down without an OOM or nonzero exit.
- Provider-independent speech HTTP schemas and a canonical signed mono PCM codec with strict size, format, UTF-8 and request-ID checks.
- An authenticated speech adapter with separate service authentication, process-incarnation binding, bounded streaming responses and cancellation, including a real local HTTP service test.
- A portable half-duplex voice coordinator using existing conversation and caller policy, repeated same-device verification, silence handling, bounded volatile history, deadlines, overlap rejection and late-result discard.
- Remote microphone capture through a backpressured audio worklet, bounded energy segmentation, current encrypted/live publication checks, reset epochs and a verified one-utterance private inbox.
- Optional external voice configuration and Compose mounts, with distinct control, agent and speech secrets and authenticated capability checks before Matrix starts.
- A complete production-driver voice path using real encrypted input, signed STT/agent/TTS protocol fixtures and measured encrypted synthesized PCM output. Two turns preserve the call's history; session end aborts a real pending STT HTTP request.
- The same voice path inside the production browser image after restoring its profile, with a fresh conversation UUID and empty history while retaining device keys and renderer isolation.
- An optional standalone signed speech service with one active operation, strict UTF-8/request limits, dedicated secret-file configuration, model integrity checks, deadlines, disconnect cancellation and graceful shutdown.
- Replaceable local whisper.cpp/eSpeak adapters with private WAV inputs, owned PCM conversion, band-limited recognition resampling, no-shell execution, bounded output and actual child termination on cancellation.
- A pinned non-root CPU speech image with upstream CPU feature selection, read-only model mounts, explicit CPU/RAM/PID limits, source archives, license files and a corresponding build recipe.
- Real Korean and English public speech clips through the speech service and portable voice coordinator using both multilingual `base` and `small` models. Signed agent dispatch is a deterministic fixture; identity and output transport are fixtures. Both models produce expected words but make Korean transcription errors; see [speech evidence](speech-integration.md).
- Non-silent Korean/English 22,050 Hz synthesis, actual recognition cancellation and temporary-file removal, signed concurrent-work rejection, and a subsequent successful synthesis in the same service.
- Independent peer-container loopback access with separate model/credential mounts and rejected unauthenticated execution, plus a checked three-file Compose configuration with speech health before browser startup and no published speech port.
- Real encrypted 22,050 Hz fixture PCM publication through the existing Matrix/browser-driver integration, matching the local synthesis engine's output rate.
- Real Korean/English recognition and synthesis through encrypted Matrix microphones, actual participant verification, the production browser driver and the restored production image. Two turns preserve history; the image starts a fresh conversation while retaining device keys.
- Signed media leave during actual recognition terminates the engine child, removes its temporary WAV and prevents a late agent turn in both worker modes. The real speech path retains image sandboxing and clean shutdown.

The current suite has 870 passing tests, with 100% per-file runtime coverage across 47 non-empty files. Full package/worker/plugin checks and the combined real Matrix speech image check pass locally. The original Matrix voice fixtures use deterministic text/PCM. Separate speech image checks run actual engines with fixture authority, agent and output transport. The combined check runs actual engines with real Matrix identity and encrypted transport; only agent dispatch remains a fixture. Its controlled clip gain/selection does not establish arbitrary-speech or long-call reliability. GitHub Actions runs package, image, sandbox, encrypted integration, both separate speech models and the combined `base`-model check.

## Remaining release work

- Homeserver-mediated MatrixRTC focus discovery/authorization, modern sticky membership, SAS enrollment UI, and target-server deployment/resource measurements.
- Legacy VoIP transport implementation.
- Broader recognition accuracy, quiet-input/pausing behavior, human pronunciation evaluation and target-server latency/resource measurements. Cold enrollment and later-input timeouts occurred during development and remain a stability investigation. Streaming and interruption remain separate design work.
- Model-backed OpenClaw dispatch and a supported privileged execution/approval path. The pinned SDK does not allow a community plugin to admit owner authority; see [ADR 0004](adr/0004-delegated-openclaw-ingress.md).
- Real encrypted audio interoperability with documented client versions, including a non-Element client where compatible calling support exists.
- Marketplace validation, source provenance, release assets, and publication setup.

Native agent-service registration, worker control integration and a clean operator setup flow remain missing. See [public release readiness](release-readiness.md) for the implementation order and evidence gates.

Synthetic Matrix SDK peers have passed real encrypted audio tests. No released Matrix client application has passed interoperability testing yet. The worker still reports `ready: false`; the repository is a development baseline, not a deployable calling release.
