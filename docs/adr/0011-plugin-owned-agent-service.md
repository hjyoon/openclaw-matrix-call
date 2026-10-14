# ADR 0011: Plugin-owned portable agent service

Status: Accepted

Date: 2026-10-14

## Context

The worker already implements signed agent requests, while the native package previously exported an ingress adapter without owning its HTTP service. Provider keys and host session authority must remain inside the agent runtime. The portable worker must also support agent hosts other than OpenClaw.

## Decision

Implement the signed server against `AgentPort` in the vendor-independent agent HTTP package. The optional native OpenClaw service supplies that port through public SDK ingress and owns listener lifecycle through public `registerService`. Require explicit loopback configuration, a separate private secret file and exact tested host compatibility. Retain the delegated, tool-free authority boundary in ADR 0004.

Bind host-session conversation IDs to the original agent, Matrix user/device, room and transport participant. Keep a bounded accepted-turn ledger for the negotiated process incarnation. Refuse capacity instead of evicting idempotency keys. Do not automatically retry or replay turns after an audience change.

On timeout or disconnect, return promptly where the connection remains available and propagate abort to the host. Keep an unfinished operation's slot until the host settles. Serialize service replacement and wait for old host work before admitting new work. Redact HTTP errors, startup failures and command output.

## Alternatives considered

- Embedding OpenClaw dispatch in the worker would couple transport to one runtime and expose host credentials beyond the agent boundary.
- Reusing a Gateway operator token would bypass the intended delegated caller authority.
- Evicting old turn IDs would allow accepted work to execute twice during the same incarnation.
- Releasing the slot on cancellation without host settlement would let a new request race unfinished session mutation.

## Consequences

The server and its policy are portable; the optional native wrapper remains explicitly version-bound. The in-memory ledger resets only with a new audience and cannot safely support transparent cross-restart retries. Host cancellation cooperation is required for timely reload and shutdown. HTTP text ingress does not complete worker control, native call entry, real model/voice validation or public distribution.
