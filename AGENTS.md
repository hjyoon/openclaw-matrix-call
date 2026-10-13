# Repository instructions

Use English for source, documentation, tests, commit messages, and release metadata. Avoid source comments; explain design and operational details in `docs/*.md`.

Keep this file limited to current, actionable development instructions. Keep decision history, alternatives, and superseded guidance in numbered records under `docs/adr`. When a decision changes, add an ADR, link the superseded record, and update current guidance. Do not duplicate rules in `CLAUDE.md`.

Keep commits small and independently reviewable. Run the checks relevant to each change before committing and pushing to `main`.

Maintain 100% statement, branch, function, and line coverage for every runtime source file in `packages/*/src`. Do not lower thresholds, ignore executable branches, or replace behavior tests with implementation snapshots to satisfy coverage.

Use public SDK interfaces and explicit version compatibility. Never treat a display name, transcript, or caller-supplied role as proof of identity.

Keep the core and worker independent of OpenClaw and hosted vendors. Isolate agent, speech, RTC, identity-verification, and persistence integrations behind documented ports and adapters. No hosted vendor account may be mandatory for the portable core.

Keep host session keys and provider credentials inside agent adapters. Maintain a documented agent protocol and exportable conversation records. Replacing an agent runtime or model provider must never broaden caller permissions.

Keep credentials and runtime state outside the repository. Use isolated test accounts and infrastructure for integration tests.

Document implementation status accurately. Require a real encrypted audio interoperability test before claiming support for a client or calling protocol.

Target Matrix protocols rather than Element-specific UI behavior. Keep MatrixRTC and legacy Matrix VoIP signaling behind separate transport adapters. Publish tested protocol capabilities and client interoperability results; do not infer calling support from Matrix login or messaging alone.
