# Installed Gateway agent integration

Updated: 2026-10-14.

`pnpm verify:plugin` packs the native package, installs and enables the archive in a disposable OpenClaw 2026.10.2 profile, then starts an actual Gateway. It uses the bundled plugin, public SDK ingress, real host session storage and a loopback HTTP model-provider fixture. It does not mock `runCommandFromIngress` in this check.

The fixture returns deterministic completion text using the host's configurable `openai-completions` transport. It is not an AI model, needs no hosted account and supplies only temporary test credentials. Matrix caller evidence is synthetic and HMAC-authenticated; no Matrix homeserver or released client participates in this check. The separate [Matrix speech integration](speech-integration.md#combined-encrypted-matrix-check) exercises genuine Matrix identity, encrypted transport and local speech engines with its own deterministic agent fixture. These checks do not yet form one model-backed voice path.

## Checked behavior

- The packed package's cold configuration metadata permits the explicit owner, room, agent and loopback service settings.
- Signed capabilities negotiate host-session history through the existing portable HTTP adapter.
- Two turns in one conversation include the earlier user message and reply in the actual provider prompt. A different conversation excludes that history.
- An accepted turn cannot execute twice with a fresh authentication nonce. A conversation cannot be rebound to another RTC session.
- An unlisted caller is rejected before any provider request. Every provider request has no runtime tools.
- Worker disconnect aborts the real host-to-provider HTTP request. Signed busy responses preserve the operation slot until the cancelled host turn settles; only unaccepted busy requests are retried by the test harness.
- A provider HTTP failure becomes a fixed signed service error, and a subsequent independent turn succeeds.
- Gateway restart invalidates the old audience and opens a fresh conversation with no earlier call history.
- An actual channel-setting change restarts the plugin service, invalidates its previous audience and still dispatches through the retained instance's current SDK registry.
- Gateway shutdown with a held provider request completes with exit code zero, cancels that provider connection and closes the listener. The reloaded fixture service uses a two-second host deadline for this check; Gateway drain may wait for that deadline before plugin disposal.

The completed run makes nine actual provider-fixture requests. It removes its profile, configuration, secret, host state and model fixture after stopping the Gateway. Native lifecycle unit tests also cover hosts that ignore cancellation, serialized replacement, missing managed lifecycle support, failed listeners, unavailable credentials and redacted startup phases.

## Limits

Real model inference, model-generated Korean/English replies, speech-length handling, Gateway-to-worker control and a complete call entry flow remain unverified or unfinished. Administrator tools remain disabled under [ADR 0004](adr/0004-delegated-openclaw-ingress.md). Released Matrix client interoperability, sustained calls and clean operator setup still gate a public calling release.

The pinned host suppresses channel settings when `OPENCLAW_SKIP_CHANNELS` or `OPENCLAW_SKIP_PROVIDERS` is set; the fixture Gateway therefore configures only this development channel rather than using either suppression flag. Configuration changes use the public CLI and preserve auto-managed metadata. Listener installation and each host callback use `api.lifecycle.runInBackgroundContext` so configuration reload does not leave callbacks bound to the starting registry.
