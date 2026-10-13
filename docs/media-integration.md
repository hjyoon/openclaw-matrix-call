# Encrypted media integration check

Run `pnpm browser:install` once, then `pnpm verify:media`. The check requires Linux, Docker, and Chromium's user-namespace sandbox. The browser is installed under the ignored `.cache/browsers` directory; `PLAYWRIGHT_BROWSERS_PATH` can override that location. No production homeserver, account, or hosted provider is used.

The harness starts a digest-pinned LiveKit 1.13.9 container using temporary credentials and three available loopback ports. Host networking is used only for this isolated local test, with SFU interfaces limited to loopback. The SFU runs as UID 1000 with a read-only filesystem, dropped capabilities, and no new privileges. The test browser runs with its Chromium sandbox enabled. Both resources and the temporary credential file are removed afterward.

Two independent browser contexts use the public LiveKit 2.22.4 SDK and the repository's `MatrixMediaKeyProvider`. Each participant publishes an independent oscillator tone through WebAudio and WebRTC. The receiver starts the remote track through the public SDK's attachment API and measures the decoded PCM waveform. A subscribed track or received RTP packet alone is not considered success.

The check requires a 440 Hz tone in one direction and a 660 Hz tone in the other, each with measurable amplitude and encrypted track metadata. It then installs an incorrect receiver key and requires silence while the RTP packet count continues to rise. Restoring the correct key must restore audio. Finally, replacing one participant's key at the next index must preserve both directions.

## Evidence

On 2026-10-13, this check passed with Chromium 156.0.8078.4, Playwright 1.64.0, LiveKit 1.13.9, and browser SDK 2.22.4. Bidirectional audio, wrong-key rejection, recovery, and key rotation passed.

This is media-layer evidence. The fixture supplies test keys and SFU tokens directly. It does not establish MatrixRTC membership, encrypted Matrix key distribution, focus authorization, persistent device verification, Element compatibility, legacy VoIP, or an end-to-end agent call.

GitHub Actions runs the same check in a disposable Ubuntu 24.04 runner. That job permits unprivileged user namespaces in the runner so Chromium can use its sandbox; it does not disable the Chromium sandbox. Production browser-worker containment still requires its own deployment test.
