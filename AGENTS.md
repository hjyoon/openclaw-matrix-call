# Repository instructions

Use English for source, documentation, tests, commit messages, and release metadata.

Avoid source comments. Explain architecture and operational decisions in `docs/*.md`.

Keep commits small and independently reviewable. Run the checks relevant to each change before committing and pushing to `main`.

Use public SDK interfaces and explicit version compatibility. Never treat a display name, transcript, or caller-supplied role as proof of identity.

Keep credentials and runtime state outside the repository. Use isolated test accounts and infrastructure for integration tests.

Document implementation status accurately. An encrypted call must pass an interoperability test before the package claims Element Call support.
