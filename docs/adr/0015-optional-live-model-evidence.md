# ADR 0015: Optional live model evidence

## Status

Accepted. Extends the evidence workflow for [ADR 0011](0011-plugin-owned-agent-service.md) without changing production authentication or portable agent interfaces.

## Date

2026-10-14.

## Context

Deterministic providers establish dispatch, policy and lifecycle behavior but cannot prove model inference or model-backed conversation history. An operator already has a working OpenClaw model login. Copying a refresh token into disposable profiles would give multiple processes ownership of the same rotating credential.

## Decision

Add an explicitly requested live integration mode using a private, access-only OAuth snapshot and the operator's configured model, runtime settings and thinking level. Import it through the pinned public SDK into a fresh private Gateway state directory. The snapshot must contain an empty refresh value and at least ten minutes of remaining validity; it never updates the source login. Expired or invalid input fails with a redacted error.

Keep hosted authentication optional. Ordinary checks use deterministic providers and require no hosted account. Validate snapshot boundaries with fake credentials in ordinary CI. Keep credentials, Gateway profiles, prompts and full model replies outside committed artifacts. Export timings, hashes, lengths and safe model/session metadata as evidence.

Verify actual signed native replies and public Gateway session/history results. A successful deterministic run must never be labeled as model inference. Keep the core, worker and speech implementations independent of the selected model and authentication method.

## Alternatives considered

- Reusing the production Gateway would mix test conversations and lifecycle operations with real service state.
- Copying refresh credentials would create a second refresh owner and unnecessary access to the source account.
- Requiring hosted credentials in CI would prevent independent contributors from running ordinary checks.
- Treating a provider-shaped fixture as a model would overstate the evidence.

## Consequences

Live checks require an operator-provided private file and can consume model quota. They fail when access is revoked or expires rather than refreshing or silently substituting a provider. Text checks use synthetic caller evidence; only the encrypted Matrix check can establish actual Matrix admission and spoken transport. A concise test workspace limits replies for bounded speech; arbitrary long answers, provider failure recovery and released-client interoperability need their own evidence.
