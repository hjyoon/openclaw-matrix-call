# ADR 0003: Separate instructions from decision history

Status: Accepted

Date: 2026-10-13

## Context

The development scope changed during initialization. The project owner requested a cleanup of stale context and specifically required `AGENTS.md` and `CLAUDE.md` to contain only effective development instructions, with changed decisions stored as ADRs.

## Decision

Use `AGENTS.md` as the single source of current repository rules. `CLAUDE.md` references it instead of duplicating rules. Store architectural decisions and changes in numbered records under `docs/adr`.

When a decision changes, add a successor ADR, update the earlier record's status and link, and reconcile current instructions and operational documentation. Keep changing test counts and implementation evidence in the status document, not instruction files.

## Alternatives considered

- Appending historical notes to instruction files: leaves stale guidance competing with current rules.
- Keeping separate rules for each coding agent: creates divergence and maintenance overhead.
- Relying only on chat history: makes the rationale unavailable to future contributors.

## Consequences

Coding agents share one current instruction source. Reviewers can inspect the decision history without treating superseded rationale as an active command. Operational documents and implementation evidence still need updates when behavior changes.
