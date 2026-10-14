# Browser worker

The optional browser worker connects the portable authenticated media controller to a real Matrix/LiveKit browser runtime. It implements the RTC connection/publication port, participant verification and optional half-duplex STT/agent/TTS dispatch. Automatic incoming-call handling is not implemented. Assistant readiness remains `false` until released-client and real speech/agent integrations are verified.

The control-only [worker image](worker.md) remains SDK-free. The browser image includes pinned Matrix SDK 43.0.0, LiveKit client 2.22.4, Playwright 1.64.0, Chromium 156.0.8078.4, packaged Rust crypto WASM, and the LiveKit E2EE worker. It does not need an OpenClaw installation, hosted model account, SFU signing secret, or Gateway operator token.

## Configuration and enrollment

Issue a new Matrix device access token for the service account. The existing account can be reused with a separate device. Keep its credential file and the control secret outside the repository. Join the configured encrypted rooms and grant only the room-state permissions needed for the supported MatrixRTC membership events.

Compare each owner's device signing fingerprint through a trusted channel. Obtain both public keys from the actual device or its signed Matrix device-key record; a room message or display name is insufficient. Use the unpadded base64 Ed25519 and Curve25519 values. The worker prepares its approved encrypted rooms and waits up to 30 seconds for the SDK's crypto store to contain all pinned devices. An uncached HTTP device listing does not establish that storage is ready for verification. The worker matches both configured keys and identities against stored SDK records before marking those devices verified; changed keys and a lost encrypted room fail immediately. Timeout and cancellation grant no trust to an unavailable device. It does not trust every device on an owner's account automatically. SAS enrollment UI remains future work.

Credential file:

```json
{
  "baseUrl": "https://matrix.example.org",
  "userId": "@callbot:example.org",
  "deviceId": "NEW-CALL-DEVICE",
  "accessToken": "REPLACE_WITH_NEW_DEVICE_TOKEN"
}
```

Browser configuration for the supplied Compose file:

```json
{
  "credentialsFile": "/run/secrets/matrix.json",
  "profileDir": "/data/profile",
  "assetDir": "/app/assets",
  "assetPort": 19791,
  "owners": ["@owner:example.org"],
  "rooms": ["!actual-room-id"],
  "focusUrls": ["https://focus.example.org"],
  "sfuUrls": ["wss://sfu.example.org"],
  "devices": [{
    "userId": "@owner:example.org",
    "deviceId": "OWNER-DEVICE",
    "ed25519": "REPLACE_WITH_43_CHARACTER_SIGNING_KEY",
    "curve25519": "REPLACE_WITH_43_CHARACTER_IDENTITY_KEY"
  }]
}
```

Replace every example value. Before initializing crypto, the worker checks the authenticated token's actual user and device with the public Matrix `whoami` API. URLs require HTTPS/WSS. `allowInsecureLoopback: true` permits only loopback HTTP/WS for isolated checks; it does not enable remote plaintext endpoints. Focus and SFU endpoints are explicit trusted configuration; [authorization](focus-authorization.md) never accepts endpoints supplied by a call request.

The persistent profile must be a real directory owned by the worker with mode `0700`. A `0600` manifest binds the homeserver, user, device, stable asset origin, and public keys. Chromium provides exclusive profile locking. Never start two crypto clients against this profile. A new profile cannot enroll a device that already has published keys; restore its entire private profile or issue another new device. Changing the asset port changes the IndexedDB origin and requires an explicit migration, currently unsupported. Keep the port stable when restoring state.

## Running

Build `deployment/browser-worker.Dockerfile` as `matrix-call-browser-worker:0.1.0-alpha.1`. Set absolute host paths in `MATRIX_CALL_BROWSER_CONFIG`, `MATRIX_CALL_MATRIX_CREDENTIALS`, and `MATRIX_CALL_SECRET_FILE`, then use `docker compose -f deployment/browser-compose.yml up -d`. The image runs as UID/GID `1000`, persists `/data`, and mounts configuration and secrets read-only. If using another UID, provide an override and a private bind mount owned by that UID. The integration runner tests the invoking user's UID/GID, including CI's different UID.

The example exposes only the authenticated control API on host loopback. The asset listener stays on container loopback and serves an exact file allowlist with CSP, no caching, and no credentials. Credentials enter the application through the local browser automation pipe. Remote page navigation, scraping, and a public browser debugging port are not part of this worker.

The container uses a read-only root filesystem, dropped capabilities, `no-new-privileges`, a writable private data volume, a bounded temporary filesystem, and the checked-in seccomp policy. Chromium's namespace and Seccomp-BPF sandboxes remain enabled. The host must permit unprivileged user namespaces; incompatible hosts fail to start rather than disabling the sandbox.

The seccomp policy derives from [Moby profiles](https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json), with revision/hash in `deployment/browser-seccomp.source.json` and its license alongside it. The changes permit `clone`, `setns`, `unshare`, and `chroot` for Chromium's user namespace. Linux capabilities remain dropped; allowing a syscall does not grant its host capability. The modern base retains `openat2` and the `clone3` ENOSYS fallback needed by the tested runtime. The image carries dependency license texts and an inventory under `/app/licenses`; Chromium's distributed notices remain with its binaries.

The configured `768 MiB`, one CPU, and 256 process limit are a development starting point. Speech/model resources are additional. Measure the target server before increasing concurrency; the current worker allows one media session.

## Enabling voice

Keep voice disabled by omitting `voiceFile`. To enable it, add `"voiceFile": "/run/config/voice.json"` to the browser configuration and create an external configuration file:

```json
{
  "agentId": "assistant",
  "agent": {
    "baseUrl": "https://agent.example.org/v1/agent",
    "secretFile": "/run/secrets/voice_agent_secret"
  },
  "speech": {
    "baseUrl": "https://speech.example.org/v1/speech",
    "secretFile": "/run/secrets/voice_speech_secret"
  },
  "timeoutMs": 90000,
  "requestTimeoutMs": 30000
}
```

The agent must implement the [signed agent protocol](agent-protocol.md), and the speech bridge must implement the [signed speech protocol](speech-protocol.md). Use separate random 64-character lowercase hexadecimal secrets for control, agent and speech authentication. The worker rejects secret reuse. Both services must authenticate their capabilities before a Matrix client starts. Their model/provider credentials remain inside those services. `agentId` is a configured logical name, and voice does not accept user-selected endpoints or authority claims.

For Compose, set absolute host paths in `MATRIX_CALL_VOICE_CONFIG`, `MATRIX_CALL_VOICE_AGENT_SECRET` and `MATRIX_CALL_VOICE_SPEECH_SECRET`, then run `docker compose -f deployment/browser-compose.yml -f deployment/browser-voice.compose.yml up -d`. The override mounts only the voice configuration and its dedicated secrets. The speech and agent services are supplied separately; the browser image does not contain speech models or an agent runtime. HTTPS is required by default. An explicitly configured `allowInsecureLoopback: true` permits local HTTP only; container loopback refers to that container's network namespace, so separate services need TLS or an explicitly shared local namespace.

The optional [local speech deployment](local-speech-deployment.md) supplies the speech service in its own image and a third Compose override for shared loopback networking. It retains separate credentials, filesystems, process namespaces and resource limits. Real speech engines are checked separately from this document's Matrix protocol-fixture evidence.

Startup logs include `voiceEnabled`. The generic readiness endpoint remains false: configured ports do not establish speech quality or released-client compatibility. See [voice pipeline](voice-pipeline.md) for utterance limits, history, cancellation and retention.

## Lifecycle and evidence

`/v1/media/join`, `/v1/media/status`, and `/v1/media/leave` use the existing [signed protocol](worker-media-control.md). Requests contain a configured room or exact session ID, never device trust, role claims, credentials, or custom endpoints. Programmatic PCM publication is mono Int16 at 8–48 kHz, bounded to ten seconds. It is not exposed as an unauthenticated audio endpoint.

Each call creates a new key provider, admission gate, media room, and local sending keys. Remote audio subscription starts only after authenticated Matrix key admission. Membership changes immediately suspend current playback and recheck subscriptions. One bounded PCM buffer retains its remaining playback offset; it resumes only after fresh listener authorization, device trust and key distribution. A stale ended callback cannot complete the resumed source. Listener authorization and device trust are refreshed before each publication and on a five-second timer; rotations are serialized. A timer tick is skipped during an individual bounded PCM piece. Membership and cryptographic failures stop playback, and cancellation/closure reject paused output and wipe its float buffer. An unauthorized/unverified listener or exhausted 256-index key ring ends the call. Indices are not reused within a call; an idle periodic schedule exhausts the ring in roughly 21 minutes, and extra publications consume additional indices. Starting another call uses new resources and keys. See [ADR 0017](adr/0017-reauthorized-playback-resume.md).

The host detects ended calls and updates the portable controller. A failed browser or cancellation while opening closes the browser and worker; a supervisor can restart the service. Discarded membership snapshots are reauthorized against current listeners within a bounded deadline. Focus grants invalidated by a membership update are requested again with fresh binding checks. Identity, endpoint, trust, and other authorization failures remain fatal. Startup errors identify a fixed stage, and connection logs contain a bounded reason code without credentials or raw SDK errors. Restart preserves device keys and configured trust while restoring no call, session UUID, media key authority, or agent permission.

If delayed state updates temporarily remove the service's own membership while its SDK join intent remains active, output stays suspended and no key is sent. Capture and speaker verification require that membership to be current again. Publication resumes only after fresh listener checks inside the connection/reauthorization deadline. Authorization and device-trust failures remain fatal and have separate fixed diagnostic categories.

`pnpm verify:matrix` now drives the production package with isolated Matrix accounts, explicit device pins, real authorization, actual encrypted PCM publication, participant verification, and persistent-profile restart/rejoin. `pnpm verify:browser-sandbox` checks Chromium's own sandbox diagnostics inside the image. `pnpm verify:browser-container` adds actual Matrix key exchange and restart using the same device profile inside a non-root, read-only container, and checks the renderer's additional PID namespace and seccomp filter. The container check uses host networking solely to reach temporary loopback test infrastructure; the deployment Compose file uses a bridge.

The same checks now drive optional voice capture, signed speech and agent services, real encrypted synthesized output, two-turn history and STT request cancellation. The image also starts with fresh conversation history after restoring its device profile. Speech and agent services are deterministic protocol fixtures; they do not evaluate a real speech or language model.

Synthetic SDK peers provide this evidence. Optional [live-model integration](live-model-integration.md) also passes actual model-backed Korean/English speech and exact host history through the driver and restored image. Released Matrix clients, modern sticky membership, homeserver-mediated focus authorization, legacy VoIP and unrestricted model-response handling remain unverified or unimplemented. See [implementation status](implementation-status.md).
