# Matrix Call for OpenClaw

This is an experimental development package for OpenClaw 2026.10.2. It registers a Matrix Call channel descriptor and `/matrixcall` status command. It does not join calls or exchange audio yet.

The exported agent adapter uses the public SDK ingress API, creates an independent host session for each neutral call UUID, preserves the verified Matrix caller, and propagates cancellation. It requires the host's `meta.finalAssistantVisibleText`; it fails closed when that field is absent instead of exposing ambiguous raw payloads or diagnostic text. A model-backed run still needs validation.

The adapter dispatches delegated, tool-free turns. OpenClaw 2026.10.2 restricts authenticated owner admission to bundled or trusted official plugins; community plugin installation does not remove that restriction. Privileged tasks and general-user approvals are not implemented. The worker must never receive a Gateway operator token.

See the repository's [implementation status](https://github.com/hjyoon/openclaw-matrix-call/blob/main/docs/implementation-status.md), [agent protocol](https://github.com/hjyoon/openclaw-matrix-call/blob/main/docs/agent-protocol.md), and [Matrix compatibility](https://github.com/hjyoon/openclaw-matrix-call/blob/main/docs/matrix-compatibility.md).
