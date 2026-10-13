# ADR 0006: Generate outbound keys inside the adapter

Status: Accepted

Date: 2026-10-13

## Context

The real Synapse/Chromium check confirmed authenticated MatrixRTC to-device key delivery and persisted device fingerprints and trust. Further inspection of `matrix-js-sdk` 43.0.0 found that its `EncryptionKeyChanged` callback does not distinguish locally generated keys from received keys. `RTCEncryptionManager.onNewKeyReceived` accepts the compatibility transport's claimed device and forwards it through the same callback. Another device using the worker's Matrix account could claim the worker's device ID, so checking only the callback's user/device pair is insufficient local-key provenance.

## Decision

Supersede ADR 0005's local-callback key admission rule. Join through the public MatrixRTC session API with `manageMediaKeys: false`. Generate outbound random key bytes inside this adapter and distribute them through the public `MatrixClient.encryptAndSendToDevice` API. Use the authenticated `ReceivedToDeviceMessage` path for all inbound keys. Never import keys from `EncryptionKeyChanged`, including callbacks claiming to describe the local device.

Before distributing or activating an outbound key, require a unique current local membership, authorized room participants, current verified remote devices, and unchanged membership throughout asynchronous work. Suspend assistant publication before processing membership changes. Rotate keys when the participant set changes; resume only after the complete authorized set has passed verification. A new call creates a fresh provider and key distribution state.

## Alternatives considered

- Matching a callback's user and device IDs: received compatibility events can carry the same pair.
- Filtering or mutating the SDK's event emitter or private key transport: unsupported interfaces with fragile security ordering.
- Reading the session key ring after a callback: the same ring contains received and generated keys.

## Consequences

The adapter owns outbound key rotation and distribution scheduling. It remains compatible with the MatrixRTC key format and uses public APIs, without patching Matrix or LiveKit. The integration harness must exercise the adapter's generated keys rather than treating SDK callbacks as local provenance. Membership, device trust, and media tests remain distinct release evidence.

## Evidence

The published 43.0.0 package's `src/matrixrtc/RTCEncryptionManager.ts`, methods `onNewKeyReceived`, `addKeyToParticipantWithBackendIdentity`, and outbound generation, use the same `onEncryptionKeysChanged` callback. Its `ToDeviceKeyTransport` reads the claimed device ID from the compatibility event. These paths are audit evidence; the adapter does not import those private classes.
