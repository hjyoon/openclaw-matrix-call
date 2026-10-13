# MatrixRTC integration evidence

Run `pnpm browser:install` once, then `pnpm verify:matrix`. The check uses disposable local Synapse and LiveKit containers, test accounts, and separate persistent sandboxed Chromium profiles. It does not access production Matrix accounts or services. The Synapse container runs with the invoking non-root user's UID/GID so its private temporary data remains readable only to that user.

## Tested stack

On 2026-10-13, the check passed with Synapse 1.162.0, room version 12, `matrix-js-sdk` 43.0.0, Rust crypto WASM 18.9.0 from the lockfile, LiveKit 1.13.9, `livekit-client` 2.22.4, Playwright 1.64.0, and Chromium 156.0.8078.4. Both server images are pinned by digest in the harness. The peers are SDK test clients, not Element or another released client application.

The tested MatrixRTC mode uses `m.call.member` state membership, room slot `m.call#ROOM`, and per-participant media keys sent over encrypted to-device messages. This is the older MatrixRTC membership representation, not legacy one-to-one `m.call.*` VoIP signaling. Sticky membership is parsed in unit tests but is not covered by this real server check.

## Verified behavior

- Both clients initialize Rust crypto with persistent IndexedDB stores and complete real homeserver sync.
- The harness compares each remote device's Ed25519 fingerprint and Curve25519 identity key against the other isolated client's actual keys before marking that device verified. This explicit test trust setup is not a production auto-verification flow.
- The repository generates local outbound keys and distributes them through the public encrypted Matrix API, with the SDK's own media-key management disabled.
- Remote key admission uses Rust crypto's authenticated and verified sender/device metadata and the current SDK membership.
- Plaintext key messages and encrypted messages claiming a different device are rejected.
- The same admitted keys decrypt actual 440 Hz and 660 Hz audio in both directions through the SFU.
- The actual participant verifier matches the Matrix user/device to a connected, subscribed, encrypted audio track and obtains fresh device trust.
- Leaving removes the old remote key's authority. Restarting preserves device fingerprints and trust while restoring no active-call key proof.
- Rejoining generates new local media keys. One peer rotates to index 1 while the restarted peer sends at index 0; both directions still work, including a distinct 880 Hz rejoined stream.
- Caller verification succeeds again after rejoin using the actual new membership and live media.

The separate [media check](media-integration.md) also verifies that wrong-key receivers remain silent while receiving RTP packets, followed by recovery and key rotation.

## Limits

The harness issues SFU tokens directly using temporary local server credentials. Homeserver focus discovery and MatrixRTC focus authorization have not been integrated. A configured production transport, automatic membership-driven publication suspension/rotation, production device enrollment, a browser-worker image, STT/TTS, and model-backed call dispatch remain unfinished.

No released Matrix client application has an interoperability claim yet. Future checks must cover modern sticky membership, supported client versions, network interruption, concurrent calls, and actual spoken input/output through the complete agent pipeline.

GitHub Actions runs both integration commands in an isolated runner. Local development uses the same commands without a GitHub or hosted-vendor account. Test credentials, crypto stores, databases, profiles, and containers are removed afterward.
