# Browser worker

The optional browser worker connects the portable authenticated media controller to a real Matrix/LiveKit browser runtime. It implements the RTC connection/publication port and participant verification. Speech capture, STT/agent/TTS dispatch, and automatic incoming-call handling are not implemented. Assistant readiness remains `false`.

The control-only [worker image](worker.md) remains SDK-free. The browser image includes pinned Matrix SDK 43.0.0, LiveKit client 2.22.4, Playwright 1.64.0, Chromium 156.0.8078.4, packaged Rust crypto WASM, and the LiveKit E2EE worker. It does not need an OpenClaw installation, hosted model account, SFU signing secret, or Gateway operator token.

## Configuration and enrollment

Issue a new Matrix device access token for the service account. The existing account can be reused with a separate device. Keep its credential file and the control secret outside the repository. Join the configured encrypted rooms and grant only the room-state permissions needed for the supported MatrixRTC membership events.

Compare each owner's device signing fingerprint through a trusted channel. Obtain both public keys from the actual device or its signed Matrix device-key record; a room message or display name is insufficient. Use the unpadded base64 Ed25519 and Curve25519 values. The worker downloads the device record, matches both configured keys and identities, and only then marks that device verified through the public SDK. It does not trust every device on an owner's account automatically. SAS enrollment UI remains future work.

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

## Lifecycle and evidence

`/v1/media/join`, `/v1/media/status`, and `/v1/media/leave` use the existing [signed protocol](worker-media-control.md). Requests contain a configured room or exact session ID, never device trust, role claims, credentials, or custom endpoints. Programmatic PCM publication is mono Int16 at 8–48 kHz, bounded to ten seconds. It is not exposed as an unauthenticated audio endpoint.

Each call creates a new key provider, admission gate, media room, and local sending keys. Remote audio subscription starts only after authenticated Matrix key admission. Membership changes immediately suspend current playback and recheck subscriptions. Listener authorization and device trust are refreshed before each publication and every five seconds; rotations are serialized. An unauthorized/unverified listener, cryptographic failure, or exhausted 256-index key ring ends the call. Indices are not reused within a call, so the periodic schedule bounds a call to roughly 21 minutes, less when publications trigger extra rotations. Starting another call uses new resources and keys.

The host detects ended calls and updates the portable controller. A failed browser or cancellation while opening closes the browser and worker; a supervisor can restart the service. Discarded membership snapshots are reauthorized against current listeners within a bounded deadline. Focus grants invalidated by a membership update are requested again with fresh binding checks. Identity, endpoint, trust, and other authorization failures remain fatal. Startup errors identify a fixed stage, and connection logs contain a bounded reason code without credentials or raw SDK errors. Restart preserves device keys and configured trust while restoring no call, session UUID, media key authority, or agent permission.

`pnpm verify:matrix` now drives the production package with isolated Matrix accounts, explicit device pins, real authorization, actual encrypted PCM publication, participant verification, and persistent-profile restart/rejoin. `pnpm verify:browser-sandbox` checks Chromium's own sandbox diagnostics inside the image. `pnpm verify:browser-container` adds actual Matrix key exchange and restart using the same device profile inside a non-root, read-only container, and checks the renderer's additional PID namespace and seccomp filter. The container check uses host networking solely to reach temporary loopback test infrastructure; the deployment Compose file uses a bridge.

Synthetic SDK peers provide this evidence. Released Matrix clients, modern sticky membership, homeserver-mediated focus authorization, legacy VoIP, and complete agent conversations remain unverified or unimplemented. See [implementation status](implementation-status.md).
