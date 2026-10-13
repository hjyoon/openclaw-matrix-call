# Repository instructions

Use English for source, documentation, tests, commit messages, and release metadata.

Avoid source comments. Explain architecture and operational decisions in `docs/*.md`.

Keep commits small and independently reviewable. Run the checks relevant to each change before committing and pushing to `main`.

Maintain 100% statement, branch, function, and line coverage for every runtime source file in `packages/*/src`. Do not lower thresholds, ignore executable branches, or replace behavior tests with implementation snapshots to satisfy coverage.

Use public SDK interfaces and explicit version compatibility. Never treat a display name, transcript, or caller-supplied role as proof of identity.

Keep the core and worker independent of OpenClaw and hosted vendors. Isolate agent, speech, RTC, identity-verification, and persistence integrations behind documented ports and adapters. No hosted vendor account may be mandatory for the portable core.

Agent portability includes the agent framework, model provider, conversation data, and tool authorization. Keep host session keys and provider credentials inside adapters. Maintain a documented agent protocol and exportable conversation records. Replacing an agent must never broaden caller permissions.

Keep credentials and runtime state outside the repository. Use isolated test accounts and infrastructure for integration tests.

Document implementation status accurately. An encrypted call must pass an interoperability test before the package claims Element Call support.
