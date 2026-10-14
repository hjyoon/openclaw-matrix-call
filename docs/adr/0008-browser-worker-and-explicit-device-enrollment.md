# 0008: Browser worker and explicit device enrollment

Status: Accepted. Runtime readiness completed by [ADR 0022](0022-authenticated-pipeline-readiness.md).

Date: 2026-10-13

## Context

The encrypted media checks currently inject test browser peers into the portable worker. A usable transport needs a reusable runtime, persistent Rust crypto storage, lifecycle control, packaged browser assets, and explicit device enrollment. Reusing an existing verified device ID with new private keys would break its identity.

## Decision

Add an optional browser-worker package and image. Keep the portable worker and core independent of browser and Matrix SDK dependencies. Load only packaged local application assets in sandboxed, non-root Chromium. Use a dedicated persistent profile and a stable loopback asset origin. Acquire the browser's exclusive profile lock; bind its persisted device-key manifest to the homeserver, user, device, and origin. Reject enrollment of an already published device when the local binding is absent.

Provision a separate Matrix credential file for a newly issued device. Enroll owner devices by explicitly comparing and configuring their Ed25519 and Curve25519 public keys through a trusted channel. Match both keys from the actual Matrix SDK before marking a device verified; do not derive trust from an owner name or room membership. SAS enrollment is a separate future UI capability. Device pins are administrative configuration, never call request fields.

Create fresh media resources and key admission for each call. Suspend sending on membership changes, serialize local key rotations, and close the call if a listener fails authorization or verification. The actual service device is allowed without adding its account to the owner list; its other devices are remote listeners. Do not resume calls or media key authority across process restart.

The image requires user namespaces and a reviewed seccomp profile for Chromium's sandbox. Do not fall back to disabling the sandbox, running as root, or granting `SYS_ADMIN`. Browser runtime health does not imply STT/agent/TTS readiness.

## Alternatives considered

- Expanding the control-only image would force browser dependencies on SDK-free installations.
- Trusting every owner device automatically would erase device verification as an independent security boundary.
- Reusing a shared browser profile would mix credentials and allow concurrent crypto clients.
- Disabling the browser sandbox would weaken isolation for a network-facing media parser.

## Consequences

The browser image uses more memory and needs a persistent, private profile volume. Operators must issue a new device and compare owner fingerprints. Calls remain a development capability until speech, agent integration, and released-client interoperability are checked. Container and browser sandbox compatibility must be demonstrated on the target kernel; documentation alone does not establish that compatibility.
