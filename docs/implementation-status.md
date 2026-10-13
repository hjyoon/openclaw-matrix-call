# Implementation status

Updated: 2026-10-13. This is the current development baseline; earlier server setup and the community voice-plugin audit are background, not deployment instructions for this repository.

## Decisions

- The repository is `hjyoon/openclaw-matrix-call`, with small commits pushed to `main`.
- Source, documentation, tests, and commit messages are in English. Design explanations belong in Markdown, with source comments kept minimal.
- Agent portability includes frameworks, model providers, conversation data, and authorization. OpenClaw is an adapter; the core does not import it.
- Matrix compatibility is defined by protocol capabilities. Element is one client to test. MatrixRTC and legacy Matrix VoIP need separate adapters.
- Runtime coverage requires 100% statements, branches, functions, and lines per file. Coverage does not prove real encrypted audio interoperability.
- The initial policy accepts explicitly configured owners, rooms, and logical agents. General-user approval is a later integration requiring an end-to-end authorization test.
- No production server deployment, Matrix user messaging, or marketplace publication has been performed as part of repository development.

## Implemented and checked

- Portable agent, speech, RTC, verification, and persistence interfaces.
- Strict caller policy and verification checks.
- Independent call lifecycle with concurrency limits, repeated caller verification, cancellation, and ordered persistence.
- Immutable conversation records with validated versioned JSON export/import.
- Dedicated HTTP message authentication with replay protection and process-incarnation binding.
- Portable agent HTTP protocol and adapter, including a complete core turn against a real local test service.

Type checking passes. The current suite has 138 passing tests, with 100% per-file runtime coverage. Tests use isolated fixtures and local test services.

## Remaining release work

- Native OpenClaw adapter registration and clean-host installation checks.
- RTC worker packaging and operational lifecycle.
- MatrixRTC and legacy VoIP transport implementations, verified device state, and media encryption.
- Speech provider adapters and bidirectional audio integration.
- Real encrypted audio interoperability with documented client versions, including a non-Element client where compatible calling support exists.
- Marketplace validation, source provenance, release assets, and publication setup.

No Matrix client has passed a real audio call test yet. The repository is a development baseline, not a deployable calling release.
