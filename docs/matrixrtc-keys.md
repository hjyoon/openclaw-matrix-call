# MatrixRTC key admission

The browser adapter uses `matrix-js-sdk` 43.0.0 and `livekit-client` 2.22.4. The portable worker does not load these SDKs.

`VerifiedMatrixRtcKeys.receive` accepts the public SDK's `ReceivedToDeviceMessage` object directly. Its `encryptionInfo` must originate from the worker's Rust crypto client, never from a control request, room message, transcript, or SFU metadata. `senderVerified` must be true, the authenticated sender device must be present, and the message's claimed sender and device must match that evidence.

The current key format is the room-scoped `m.call` session with an empty call ID. Other applications, session scopes, and call IDs are rejected. Keys must be canonical 16-byte base64 values, with explicit indices between 0 and 255. Additional protocol fields are tolerated. The message timestamp must be within 30 seconds of the worker's clock; synchronized clocks are an operational requirement.

Membership snapshots must come from the current public MatrixRTC session. Match the authenticated Matrix user, device, and member ID, and take the backend identity from the SDK's computed `rtcBackendIdentity`. Never construct that identity from an HTTP caller claim. Exactly one matching live membership is required. Its identity and creation timestamp bind the imported key to that membership incarnation. A changed identity, changed incarnation, ambiguous membership, expiry, or departure invalidates its proof.

Keys from the session's compatibility callback are not accepted, including callbacks claiming the worker's own user and device. That callback lacks authenticated device provenance and local-generation provenance. Join with `manageMediaKeys: false`; see [ADR 0006](adr/0006-local-outbound-key-provenance.md).

`MatrixMediaKeyProvider` subclasses the public LiveKit `BaseKeyProvider`. It imports non-extractable WebCrypto HKDF material and uses separate participant identities and key indices. It checks membership validity again after asynchronous import, before emitting a key to LiveKit. Concurrent imports for the same participant and index cannot overwrite a newer pending import. Closing the admission gate discards pending work and permanently removes its proofs.

`publishMatrixRtcKey` generates fresh local key bytes, checks a unique live local membership and at most 64 authorized participants, and performs a fresh device-verification lookup for every remote listener. Another device on the local Matrix account is a remote listener and must pass verification. It distributes keys only through the public encrypted to-device API. Membership changes, cancellation, departure, and expiry during asynchronous work prevent local key activation. The caller owns rotation scheduling and must serialize rotations with distinct indices.

The provider binds the local participant identity once per call. Its initial sending index follows only that participant's latest imported key. Receiving a remote participant's rotation cannot change the local sending index. Rebinding to another identity requires new media resources.

A key proof alone does not authorize an agent turn. The transport must also recheck current device verification, active Matrix membership, actual connected SFU participant identity, and encrypted inbound audio. A new call requires new media resources; closed-call key providers are not reused. Assistant publication must stop when a participant is not authorized, because the Matrix SDK distributes outbound media keys to call members.

`MatrixRtcParticipantVerifier` uses public Matrix crypto and LiveKit room interfaces. Every verification performs a fresh device-trust lookup, binds the requested room and slot, requires exactly one Matrix membership and its actual SFU participant, and requires a live subscribed audio track marked encrypted while room E2EE is enabled. It repeats media and membership checks after the asynchronous trust lookup. Core proofs last at most 30 seconds and never extend the membership's expiry. The core applies its owner, room, and agent policy separately.

The current tests cover key admission, real WebCrypto import, public SDK membership parsing, repeated device verification, lifecycle races, and invalid evidence. They do not establish Matrix login, persistent device verification, focus authorization, or encrypted audio interoperability.
