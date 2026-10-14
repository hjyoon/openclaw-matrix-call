# Architecture decision records

ADRs preserve decisions, context, alternatives, and consequences. `AGENTS.md` contains only current development rules, and `CLAUDE.md` points to those rules. Operational documentation describes current behavior. Implementation status records evidence and unfinished work.

Number records in order. An accepted ADR is a historical record, not a second instruction file. To change a decision, add a new ADR and update the old record's status with a link to its successor. Update current instructions and operational documentation in the same change.

## Index

| Record | Status | Decision |
| --- | --- | --- |
| [0001](0001-portable-agent-and-call-boundaries.md) | Accepted | Portable core and replaceable agent/runtime boundaries |
| [0002](0002-matrix-protocol-compatibility.md) | Accepted | Matrix protocol capabilities instead of an Element-only target |
| [0003](0003-development-instructions-and-decision-history.md) | Accepted | Current instructions separated from decision history |
| [0004](0004-delegated-openclaw-ingress.md) | Accepted | Delegated, tool-free OpenClaw ingress until supported owner admission exists |
| [0005](0005-browser-matrixrtc-media.md) | Accepted | Browser MatrixRTC media with authenticated per-device keys |
| [0006](0006-local-outbound-key-provenance.md) | Accepted | Locally generated outbound keys instead of ambiguous SDK callbacks |
| [0007](0007-explicit-focus-authorization.md) | Accepted | Explicit trusted OpenID focus authorization without administrative signing keys |
| [0008](0008-browser-worker-and-explicit-device-enrollment.md) | Accepted | Optional sandboxed browser worker with persistent device binding and explicit fingerprint enrollment |
| [0009](0009-bounded-portable-voice-turns.md) | Accepted | Portable half-duplex voice turns with bounded input, fresh authority checks and cancellation |
| [0010](0010-optional-local-speech-service.md) | Accepted | Optional bounded local speech service with pinned models and replaceable subprocess engines |
| [0011](0011-plugin-owned-agent-service.md) | Accepted | Plugin-owned portable signed agent service with bound sessions and cancellation-safe replacement |
| [0012](0012-owned-worker-control-sessions.md) | Accepted | Authenticated portable worker control with caller-selected session IDs and exact ownership cleanup |
| [0013](0013-native-owner-media-control.md) | Accepted | Public native owner/admin call entry with bounded admission and exact owned-session disposal |
| [0014](0014-bounded-initial-worker-discovery.md) | Accepted | One bounded initial capability-discovery budget for refused worker connections |
| [0015](0015-optional-live-model-evidence.md) | Accepted | Optional access-only operator login snapshots for actual model evidence |
| [0016](0016-bounded-segmented-speech.md) | Accepted | Sequential bounded speech with authenticated length subdivision and per-piece revocation |
| [0017](0017-reauthorized-playback-resume.md) | Accepted | Paused bounded PCM resumes only after fresh membership and key authorization |
| [0018](0018-modern-livekit-transport-config.md) | Accepted | Modern service configuration with optional legacy alias and unchanged authenticated token scope |
| [0019](0019-offline-worker-image-candidates.md) | Accepted | Source-labelled offline worker image candidates separate from the plugin and private runtime inputs |
| [0020](0020-capture-continuity-on-membership-renewal.md) | Accepted | Preserve bounded capture only across unchanged active membership bindings and nondecreasing lifetimes |
| [0021](0021-local-gateway-worker-networking.md) | Accepted | Optional explicit host-loopback route for a native Linux Gateway and separately restricted Docker workers |
| [0022](0022-authenticated-pipeline-readiness.md) | Accepted | Bounded fresh readiness checks with existing service audiences and separate configuration/caller authority |

## Record format

Use a descriptive filename and the following sections: status, date, context, decision, alternatives considered, and consequences. State implementation limits explicitly. A decision to support a capability does not establish that the capability is implemented or tested.
