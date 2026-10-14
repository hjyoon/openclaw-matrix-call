# MatrixRTC integration evidence

Run `pnpm build`, install Chromium once with `pnpm browser:install`, then run `pnpm verify:matrix`. The check uses disposable local Synapse and LiveKit containers, test accounts, and separate persistent sandboxed Chromium profiles. It does not access production Matrix accounts or services. The Synapse container runs with the invoking non-root user's UID/GID so its private temporary data remains readable only to that user.

## Tested stack

On 2026-10-14, the check passed with Synapse 1.162.0, room version 12, `matrix-js-sdk` 43.0.0, Rust crypto WASM 18.9.0 from the lockfile, LiveKit 1.13.9, authorization service 0.8.0, `livekit-client` 2.22.4, Playwright 1.64.0, and Chromium 156.0.8078.4. All server images are pinned by digest in the harness. The peers are SDK test clients, not Element or another released client application.

The tested MatrixRTC mode uses `m.call.member` state membership, room slot `m.call#ROOM`, and per-participant media keys sent over encrypted to-device messages. This is the older MatrixRTC membership representation, not legacy one-to-one `m.call.*` VoIP signaling. Sticky membership is parsed in unit tests but is not covered by this real server check.

## Verified behavior

- Both clients initialize Rust crypto with persistent IndexedDB stores and complete real homeserver sync.
- The harness compares each remote device's Ed25519 fingerprint and Curve25519 identity key against the other isolated client's actual keys before marking that device verified. This explicit test trust setup is not a production auto-verification flow.
- The repository generates local outbound keys and distributes them through the public encrypted Matrix API, with the SDK's own media-key management disabled.
- Remote key admission uses Rust crypto's authenticated and verified sender/device metadata and the current SDK membership.
- The configured focus exchanges actual homeserver OpenID tokens through authorization service 0.8.0. The browser receives no SFU signing key. The adapter checks the token's identity, room alias, media grants, and SFU endpoint before connecting.
- Real worker HTTP media-control endpoints start and stop each browser transport. Requests and responses use the dedicated HMAC protocol and per-worker audience. An unconfigured room is rejected before transport dispatch. The control layer exposes no SFU signing credential or Gateway token.
- LiveKit automatic room creation is disabled. The authorization service creates the permitted room, and the actual SFU accepts its signed join tokens.
- Plaintext key messages and encrypted messages claiming a different device are rejected.
- The same admitted keys decrypt actual 440 Hz and 660 Hz audio in both directions through the SFU.
- The actual participant verifier matches the Matrix user/device to a connected, subscribed, encrypted audio track and obtains fresh device trust.
- Leaving removes the old remote key's authority. Restarting preserves device fingerprints and trust while restoring no active-call key proof.
- Rejoining generates new local media keys with independent sending indices. Discarded snapshots consume indices instead of reusing them; both directions still work, including a distinct 880 Hz rejoined stream.
- Rejoining through a fresh worker control instance produces a new media session ID. Media leave cleans up the Matrix session and audio resources, and the other peer loses the departed membership's key authority.
- Caller verification succeeds again after rejoin using the actual new membership and live media.
- The production browser package validates a new service device, enrolls explicitly pinned owner keys, and executes the same signed worker control protocol.
- The production driver sends real 880 Hz and 1100 Hz PCM through encrypted media and verifies the owner's actual inbound track. Its persistent profile survives restart with the same device keys and fresh call/session state.
- The optional image restores that device profile, completes real authorization and encrypted Matrix key exchange, retains non-root execution and additional Chromium PID/seccomp isolation, and exits cleanly after signed media leave.
- The production capture worklet collects encrypted 660 Hz and 770 Hz microphone utterances, verifies current participants, and sends signed PCM requests to local speech protocol fixtures.
- Those fixtures return deterministic transcripts, the agent fixture receives the verified Matrix user/device and call history, and the synthesis fixture returns 1320 Hz PCM that the other peer measures through encrypted media.
- Two voice turns share a conversation UUID and ordered history while using distinct turn IDs. Leaving during a stalled recognition request aborts the actual HTTP request without dispatching an agent or accepting its late transcript.
- The restored browser image runs the same audio-to-speech-to-agent-to-audio path with a new conversation UUID and an empty initial history. Its device keys and sandbox isolation remain intact.

The synthetic peers wait for joined, unique current membership before attempting key publication; discarded attempts never reuse indices. Production authorization still rejects unsupported or unauthorized identities and endpoints. Temporary absence of selected focus/local membership is reauthorized only inside the bounded connection deadline.

The separate [media check](media-integration.md) also verifies that wrong-key receivers remain silent while receiving RTP packets, followed by recovery and key rotation.

## Real speech through Matrix

Build both browser and speech images with the documented `0.1.0-alpha.1` development tags, then run `pnpm verify:matrix-speech`. This extends the existing protocol-fixture checks with the actual CPU speech image and multilingual `base` model. Public speech is played through the peer's encrypted microphone track; the production capture worklet and verifier admit it before recognition. The signed agent fixture receives the actual Matrix owner/device, recognized text and call history. Real eSpeak synthesis returns through encrypted media to the peer.

The check peak-normalizes playback to 0.8 full scale. It uses the complete 4.68-second Korean clip and seconds 5–8 of the English clip, a continuous phrase selected for the half-duplex endpointer. It checks Korean fixture keywords and the English word `country`, not an exact transcript. File hashes and original attribution remain unchanged. Quiet-input and arbitrary-pause robustness are not established by this controlled playback.

Each worker mode completes two language turns in one conversation. Restoring the image starts a fresh conversation with empty history and unchanged device keys. A third utterance starts an actual recognition child; signed media leave must terminate it, remove its input WAV and prevent another agent turn. The image retains renderer PID/seccomp isolation and exits without an OOM or nonzero status. The speech service also shuts down cleanly.

The native test launcher adds a passive worklet-message probe that counts chunks, acknowledgements, resets and signal energy without retaining PCM. The production container runs without that probe. Results under `.cache/speech/matrix-integration-result.json` contain scalar observations and image/model identifiers rather than transcripts. The first non-silent replies in the recorded development run arrived approximately 14.5–19.6 seconds after starting input playback, including the input duration and deterministic agent fixture; these are not target-laptop measurements or a model-response benchmark.

## Limits

The tested focus mode is the explicit standalone OpenID endpoint. Homeserver-mediated MSC4195 discovery/authorization is not covered. The default check uses signed speech/agent protocol fixtures and 22,050 Hz synthesized PCM. The extended check runs real speech engines with actual Matrix identity and encrypted transport; its agent remains a deterministic fixture. Separate [speech image checks](speech-integration.md) cover both model sizes. The optional [live-model check](live-model-integration.md) additionally verifies actual model responses and host history through encrypted speech in both worker modes, plus longer bounded native responses. Broader recognition quality, target-server latency and SAS enrollment UI remain unfinished; speech remains subject to the documented per-piece and whole-turn limits.

Intermittent cold enrollment and later-input timeouts occurred in development runs. The successful controlled-clip check does not establish that those stability cases are resolved; sustained calls, membership renewal, quiet speech and arbitrary pauses still need investigation.

The [CI run for `7bda04f`](https://github.com/hjyoon/openclaw-matrix-call/actions/runs/38534162127) passed package/container, encrypted media and both standalone speech models, but timed out before admitting its first native Korean utterance. The passive capture probe recorded all 234 voiced chunks, four resets and continued acknowledgements. This places the failure before agent dispatch; the aggregate counts alone cannot distinguish capture reset, inbox verification or delivery loss.

The [CI run for `5b673ef`](https://github.com/hjyoon/openclaw-matrix-call/actions/runs/38539249407) stopped at a single participant verification immediately after rejoined encrypted audio. RTP decryption alone does not establish current Matrix key/membership authority. The setup now waits within the existing thirty-second budget for the actual verifier to return the exact expected user/device and verified encrypted media in both directions. Missing or stale authority still fails; no key, media result or proof is substituted. The updated local Matrix check passed.

The native harness now records at most eight reset timestamps with cumulative voiced counts, an input-start timestamp, and scalar verification/delivery/publication counters on failure. The optional image preload records the same counters. A subsequent local diagnostic run passed all four turns and cleanup, but observed a native capture reset during the first clip. Its cause and effect on failed runs remain unproven. These observations neither replay input nor relax keywords, authority, encryption, history or cancellation checks. No private participant audio or model text is retained.

An optional live-model attempt on 2026-10-14 stopped during initial production-driver enrollment, before any model request. The next instrumented attempt passed enrollment; no specific cause was established. The disposable harness now includes a bounded credential-sanitized first error line when enrollment does not match a known diagnostic code. Production logging is unchanged, and a subsequent successful enrollment is not evidence that the original fault is fixed.

The authorization service reaches the real Synapse OpenID userinfo endpoint through a temporary loopback HTTPS proxy. That proxy has a disposable self-signed test certificate, so certificate verification is disabled only inside this isolated test authorization-service container. Production clients retain the TLS requirement; no insecure setting is added to the worker deployment.

The separate [Element Call 0.28.0 check](released-client-integration.md) passes actual speech and leave/rejoin in standalone compatibility mode with one trusted backend. Future checks must cover modern sticky membership, supported client versions, network interruption, concurrent calls, and actual spoken input/output through the complete agent pipeline.

GitHub Actions runs media, Matrix protocol-fixture and extended real speech checks in isolated runners. Local development uses the same commands without a GitHub or hosted-vendor account. Test credentials, crypto stores, databases, profiles, and containers are removed afterward. Test containers share host loopback to reach disposable services; production deployment uses the separately checked shared-network-namespace Compose configuration, without host networking.
