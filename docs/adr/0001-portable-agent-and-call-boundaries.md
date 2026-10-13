# ADR 0001: Portable agent and call boundaries

Status: Accepted

Date: 2026-10-13

## Context

The repository began as an OpenClaw plugin project. The project owner subsequently required vendor independence for both the overall structure and the AI agent itself. Merely allowing a different model identifier inside one agent framework would not satisfy that requirement.

## Decision

Keep call authorization, lifecycle, and versioned conversation records in a core package that does not import OpenClaw or a proprietary model SDK. Define replaceable ports for agents, speech recognition, speech synthesis, RTC transport, participant verification, and persistence.

Implement OpenClaw as one adapter. Provide a documented, authenticated agent HTTP protocol for self-hosted services and other agent frameworks. Keep host session keys, provider credentials, and hidden host state inside adapters. Preserve supported package installation outside ClawHub.

## Alternatives considered

- An OpenClaw-only core with configurable model providers: couples orchestration and history to one framework.
- An OpenAI-compatible model API as the entire agent interface: does not represent agent framework lifecycle, caller authorization, or tool approvals.
- A universal abstraction over private host state: cannot promise migration of undocumented tool traces or internal model state.

## Consequences

Portable text history and verified caller context can cross adapter boundaries. Replacing an agent must preserve authorization and start a fresh call unless a deliberate migration is implemented. Each adapter still needs host-specific authorization and cancellation tests. Media interoperability remains a separate release requirement.
