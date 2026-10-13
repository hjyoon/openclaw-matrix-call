# ADR 0004: Delegated OpenClaw ingress

Status: Accepted

Date: 2026-10-13

## Context

Inspection of the pinned OpenClaw 2026.10.2 runtime found an explicit guard in its plugin-scoped `agent.runCommandFromIngress` API. A community plugin cannot admit authenticated owner authority through that API, even when its own policy has verified an owner. The runtime also requires that the plugin owns the selected channel.

The initial deployment architecture expected owner-only calls to retain administrative capabilities. That is a future integration requirement, not an available community-plugin capability in this SDK.

## Decision

Use the public native ingress API with delegated authority, `senderIsOwner: false`, model overrides disabled, and an empty runtime tool allowlist. Preserve the verified Matrix sender and independent call session key. Require exact tested SDK compatibility.

Do not reuse the Gateway operator token, forge official-plugin provenance, patch host authorization, or use private internal APIs to bypass the guard. Privileged execution requires a supported upstream authorization interface and end-to-end approval tests before it can be enabled.

## Alternatives considered

- Operator-authenticated HTTP chat completions: promotes all accepted input to operator authority and loses the native caller boundary.
- Direct private agent invocation: bypasses the SDK's deliberate admission checks.
- Making community installation appear official: misrepresents provenance and breaks the host trust model.

## Consequences

The adapter can support delegated text inference during development. It cannot currently provide the intended administrator tool execution or approval-gated general-user tasks. Runtime policy remains authoritative. Actual model-backed dispatch, clean-host installation, and audio interoperability still require separate checks.

## Evidence

The pinned package's `dist/registry-854ZO8XT.mjs`, inside the plugin-scoped `runCommandFromIngress` implementation, checks plugin origin, active registration, and channel ownership before admitting owner authority. This filename is version-specific evidence, not a supported import path.
