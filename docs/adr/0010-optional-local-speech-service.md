# ADR 0010: Optional local speech service

## Status

Accepted. Extends [ADR 0009](0009-bounded-portable-voice-turns.md) without changing call authority or the portable speech protocol.

## Date

2026-10-14

## Context

The encrypted Matrix voice path uses deterministic protocol fixtures. A working recognition/synthesis backend is needed to evaluate real speech without making a hosted vendor, agent framework or client brand mandatory. The target server also runs unrelated services, so audio inference needs an independently bounded execution environment. Initial language checks cover Korean and English.

## Decision

Add an optional Node speech worker implementing the existing signed PCM HTTP protocol. Keep recognition and synthesis behind the core ports. Ship whisper.cpp and eSpeak NG as operator-selected subprocess adapters in a separate CPU image; neither engine is imported by the portable core, browser or OpenClaw adapter.

Pin upstream source revisions, source archive hashes and optional model artifacts. Verify the model's exact size and SHA-256 before listening and keep it read-only. Runtime startup does not download models. A developer/operator tool can download pinned multilingual models, and operators can supply a compatible alternative with their own integrity metadata.

Use multilingual `base` in the CPU example after comparing actual `base` and `small` service timings. Keep `small` as an explicit alternative. These two short clip checks do not establish recognition accuracy, and the target laptop has not been benchmarked.

Allow one active engine operation. Bound input/output, process resources and execution time. Pass text through stdin and use fixed arguments without a shell or inherited credentials. Cancel the child on disconnect, timeout or shutdown, escalate if necessary and wait for actual termination. Use a loopback listener, a dedicated secret and fresh process audience; service access never establishes Matrix caller authority.

The optional Compose override gives the speech service ownership of a shared network namespace and waits for its health check before starting the browser worker. Only the existing control port is host-published. Credentials, profiles, process namespaces, filesystems and resource limits remain separate. Restart both services when the speech incarnation changes to rediscover its audience and network namespace.

Compile upstream CPU variants with runtime feature selection rather than tying the image to the build machine's instruction set or disabling acceleration on every CPU. Keep the eSpeak engine as a subprocess, include its GPL license and corresponding unmodified source archive, and ship the build recipe with both engines' sources. The service does not establish production readiness or released Matrix-client support.

## Alternatives considered

- Require a hosted speech API: useful as an optional adapter, but unsuitable as a mandatory dependency.
- Load speech models in the Matrix browser or agent host: couples credentials, memory pressure and cancellation across unrelated boundaries.
- Use a neural TTS engine immediately: potentially better pronunciation, but model licensing, language support and resource measurements need separate evaluation. The lightweight eSpeak baseline does not claim natural voice quality.
- Share an engine-specific wire protocol with the core: makes replacing engines and providers harder.

## Consequences

The core remains independent of speech engines and account providers. Operators can replace this service with another conforming HTTP implementation without changing Matrix policy or conversation identity. Short fixture recognition and synthesized PCM demonstrate integration only; broader recognition accuracy, human pronunciation evaluation, real model-backed agent dispatch and released-client interoperability require separate evidence.
