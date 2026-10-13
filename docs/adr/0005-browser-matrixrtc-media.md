# ADR 0005: Browser MatrixRTC media adapter

Status: Accepted

Date: 2026-10-13

## Context

MatrixRTC distributes independent media keys for participant devices. A shared conference key is not an interchangeable encryption mode. The published `@livekit/rtc-node` 1.1.0 exposes `setKey(participantIdentity, keyIndex)` without a key-material argument, and its room encryption manager does not expose a public provider accessor. Its shared-key API cannot implement MatrixRTC per-member key distribution through the tested public interface.

The published `livekit-client` 2.22.4 exports `BaseKeyProvider`, including the protected `onSetEncryptionKey` extension point. WebCrypto HKDF key material, participant identities, and explicit indices can be passed through this interface. The published `matrix-js-sdk` 43.0.0 exposes MatrixRTC sessions and Rust crypto with browser IndexedDB persistence.

The MatrixRTC session's remote key callback alone is insufficient identity evidence. In this version, the internal to-device transport reads a claimed device ID. The public `ClientEvent.ReceivedToDeviceMessage` event additionally provides Rust crypto's authenticated sender, sender device, and verification status. The compatibility key callback is emitted before that authenticated event.

## Decision

Implement an optional browser media adapter using these pinned public SDKs. Run the browser in an isolated worker with a dedicated persistent profile, separate from the Gateway and from any interactive browser. Keep the portable control worker independent of browser and Matrix dependencies.

Import local keys from the local MatrixRTC session callback only when the callback belongs to the worker's own device. Import remote keys from authenticated, encrypted to-device messages only. Match the authenticated sender and device to the current MatrixRTC membership, member ID, room, session, and SFU identity. Reject unverified senders, plaintext messages, mismatched device claims, stale messages, malformed keys, and departed memberships. Recheck device trust and live encrypted media before admitting each agent turn.

Use per-participant LiveKit encryption without a plaintext or shared-key fallback. Recreate media resources when a call ends. Persistent Matrix device state must survive worker restarts; active calls and authorization must not. Encrypted audio must remain unavailable when membership or verification evidence is missing.

The initial owner-only implementation must suspend assistant audio when an unauthorized member joins. The SDK distributes outbound keys to call members; checking only the speaker would otherwise expose assistant audio to unauthorized listeners.

No Element UI, widget, hosted service, or specific client user agent is required. MatrixRTC and legacy VoIP remain separate adapters. Browser process containment and resource requirements must be tested before providing a production image.

## Alternatives considered

- The published Node RTC SDK: insufficient public per-member key import support in the audited version.
- Private LiveKit FFI or Matrix encryption-manager imports: bypasses supported interfaces and makes upgrades fragile.
- One shared room key or transport encryption alone: changes the security protocol and cannot establish MatrixRTC media interoperability.
- Patching an Element client: introduces an unnecessary client dependency.

## Consequences

Chromium adds memory and lifecycle requirements. The existing 256 MB control-worker image is not a tested browser-worker deployment. Browser startup, persistent crypto, key rotation, leave/rejoin, and real encrypted audio require separate integration evidence. SDK selection and unit coverage do not establish client compatibility.

## Evidence

- [LiveKit Node key provider source](https://github.com/livekit/node-sdks/blob/main/packages/livekit-rtc/src/e2ee.ts), checked against the published 1.1.0 package.
- [LiveKit browser key provider extension](https://github.com/livekit/client-sdk-js/blob/main/src/e2ee/KeyProvider.ts), checked against the published 2.22.4 package.
- [Matrix SDK authenticated to-device messages](https://matrix-org.github.io/matrix-js-sdk/interfaces/matrix.ReceivedToDeviceMessage.html), checked against the published 43.0.0 package, including `crypto-api.OlmEncryptionInfo`.
- [LiveKit media encryption](https://docs.livekit.io/transport/encryption/).
