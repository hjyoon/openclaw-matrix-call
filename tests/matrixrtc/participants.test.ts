import { describe, expect, it, vi } from "vitest";
import { ConnectionState, Track, type RemoteParticipant, type RemoteTrackPublication } from "livekit-client";
import { EventType, MatrixEvent } from "matrix-js-sdk";
import { CallMembership } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { DeviceVerificationStatus, type CryptoApi } from "matrix-js-sdk/lib/crypto-api/index.js";
import { MatrixRtcParticipantVerifier, membershipSnapshot, type MatrixParticipantSource } from "../../packages/matrixrtc/src/participants.js";
import { MatrixRtcRecipientVerifier } from "../../packages/matrixrtc/src/recipients.js";

const reference = { roomId: "!room", rtcSessionId: "m.call#ROOM", participantId: "@alice:example.org:ALICE" };

async function member(modern = false): Promise<CallMembership> {
  return CallMembership.parseFromEvent(new MatrixEvent({
    event_id: "$member", sender: "@alice:example.org", origin_server_ts: 90_000,
    type: modern ? EventType.RTCMembership : EventType.GroupCallMemberPrefix,
    content: modern ? {
      slot_id: "m.call#ROOM", msc4354_sticky_key: "m.call#ROOM", member: { user_id: "@alice:example.org", device_id: "ALICE", id: "incarnation-a" },
      application: { type: "m.call" }, transports: { published: [], can_subscribe: [] }, versions: ["1"],
    } : {
      device_id: "ALICE", application: "m.call", call_id: "", scope: "m.room", expires: 110_000,
      focus_active: { type: "livekit", focus_selection: "oldest_membership" }, foci_preferred: [],
    },
  }));
}

async function fixture() {
  const publication = {
    kind: Track.Kind.Audio, isEncrypted: true, isSubscribed: true,
    track: { mediaStreamTrack: { readyState: "live" } },
  };
  const participant = { identity: reference.participantId, trackPublications: new Map([["audio", publication as RemoteTrackPublication]]) };
  const getDeviceVerificationStatus = vi.fn(async () => new DeviceVerificationStatus({ localVerified: true }));
  const crypto = { getDeviceVerificationStatus };
  const source = {
    roomId: "!room", client: { getCrypto: () => crypto as unknown as CryptoApi },
    session: { slotId: "m.call#ROOM", memberships: [await member()] },
    media: { state: ConnectionState.Connected as ConnectionState, isE2EEEnabled: true as boolean, remoteParticipants: new Map([[reference.participantId, participant as unknown as RemoteParticipant]]) },
    keys: { hasCurrentKey: vi.fn(() => true) }, now: vi.fn(() => 100_000),
  } satisfies MatrixParticipantSource;
  return { source, publication, participant, getDeviceVerificationStatus, verifier: new MatrixRtcParticipantVerifier(source), signal: new AbortController().signal };
}

describe("MatrixRtcParticipantVerifier", () => {
  it("uses the public SDK's parsed user, device, member, expiry, and backend identities", async () => {
    const old = membershipSnapshot(await member());
    expect((await member()).slotId).toBe("m.call#ROOM");
    expect(old).toEqual({ userId: "@alice:example.org", deviceId: "ALICE", memberId: reference.participantId, participantId: reference.participantId, createdAtMs: 90_000, expiresAtMs: 200_000 });
    expect(Object.isFrozen(old)).toBe(true);
    const modern = await member(true);
    const snapshot = membershipSnapshot(modern);
    expect(snapshot.memberId).toBe("incarnation-a");
    expect(snapshot.participantId).toBe(modern.rtcBackendIdentity);
    expect(snapshot.participantId).not.toBe(reference.participantId);
    expect(snapshot.expiresAtMs).toBeUndefined();
  });

  it("rechecks actual device trust and gives a bounded immutable core proof", async () => {
    const { verifier, signal, getDeviceVerificationStatus } = await fixture();
    const verified = await verifier.verify(reference, signal);
    expect(verified).toEqual({ ...reference, userId: "@alice:example.org", deviceId: "ALICE", expiresAtMs: 130_000, deviceVerified: true, mediaEncrypted: true });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(getDeviceVerificationStatus).toHaveBeenCalledWith("@alice:example.org", "ALICE");
    await verifier.verify(reference, signal);
    expect(getDeviceVerificationStatus).toHaveBeenCalledTimes(2);
  });

  it("never extends a membership expiry and bounds modern sticky proofs", async () => {
    const { source, verifier, signal } = await fixture();
    source.now.mockReturnValue(190_000);
    expect((await verifier.verify(reference, signal)).expiresAtMs).toBe(200_000);
    const modern = await member(true);
    source.session.memberships = [modern];
    const participant = source.media.remoteParticipants.get(reference.participantId)!;
    source.media.remoteParticipants.set(modern.rtcBackendIdentity, { ...participant, identity: modern.rtcBackendIdentity } as RemoteParticipant);
    expect((await verifier.verify({ ...reference, participantId: modern.rtcBackendIdentity }, signal)).expiresAtMs).toBe(220_000);
  });

  it.each([
    { roomId: "!other" }, { rtcSessionId: "m.call#other" },
  ])("rejects an unbound reference", async (change) => {
    const { verifier, signal } = await fixture();
    await expect(verifier.verify({ ...reference, ...change }, signal)).rejects.toThrow("session does not match");
  });

  it("rejects unsupported sessions even when the reference matches", async () => {
    const { source, verifier, signal } = await fixture();
    source.session.slotId = "other#";
    await expect(verifier.verify({ ...reference, rtcSessionId: "other#" }, signal)).rejects.toThrow("session does not match");
  });

  it.each(["disconnected", "plaintext", "no-key", "no-member", "ambiguous", "no-participant", "identity", "no-audio", "video", "unencrypted", "unsubscribed", "no-track", "ended"])("fails closed with %s media evidence", async (change) => {
    const { source, publication, participant, verifier, signal } = await fixture();
    switch (change) {
      case "disconnected": source.media.state = ConnectionState.Disconnected; break;
      case "plaintext": source.media.isE2EEEnabled = false; break;
      case "no-key": source.keys.hasCurrentKey.mockReturnValue(false); break;
      case "no-member": source.session.memberships = []; break;
      case "ambiguous": source.session.memberships.push(source.session.memberships[0]!); break;
      case "no-participant": source.media.remoteParticipants.clear(); break;
      case "identity": participant.identity = "different"; break;
      case "no-audio": participant.trackPublications.clear(); break;
      case "video": publication.kind = Track.Kind.Video; break;
      case "unencrypted": publication.isEncrypted = false; break;
      case "unsubscribed": publication.isSubscribed = false; break;
      case "no-track": delete (publication as { track?: unknown }).track; break;
      case "ended": publication.track.mediaStreamTrack.readyState = "ended"; break;
    }
    await expect(verifier.verify(reference, signal)).rejects.toThrow("MatrixRTC");
  });

  it.each([null, new DeviceVerificationStatus({ localVerified: false })])("rejects unknown or revoked devices", async (status) => {
    const { source, verifier, signal } = await fixture();
    source.client.getCrypto = () => ({ getDeviceVerificationStatus: async () => status }) as unknown as CryptoApi;
    await expect(verifier.verify(reference, signal)).rejects.toThrow("device is not verified");
  });

  it("requires initialized Rust crypto", async () => {
    const { source, verifier, signal } = await fixture();
    source.client.getCrypto = () => undefined as unknown as CryptoApi;
    await expect(verifier.verify(reference, signal)).rejects.toThrow("device is not verified");
  });

  it("checks cancellation before and after the asynchronous trust lookup", async () => {
    const { source, verifier } = await fixture();
    const aborted = AbortSignal.abort(new Error("cancelled"));
    await expect(verifier.verify(reference, aborted)).rejects.toThrow("cancelled");
    const controller = new AbortController();
    source.client.getCrypto = () => ({ getDeviceVerificationStatus: async () => {
      controller.abort(new Error("cancelled during lookup"));
      return new DeviceVerificationStatus({ localVerified: true });
    } }) as unknown as CryptoApi;
    await expect(verifier.verify(reference, controller.signal)).rejects.toThrow("cancelled during lookup");
  });

  it("rejects changes during device verification", async () => {
    const { source, verifier, signal } = await fixture();
    source.client.getCrypto = () => ({ getDeviceVerificationStatus: async () => {
      source.session.memberships = [await CallMembership.parseFromEvent(new MatrixEvent({
        event_id: "$new", sender: "@alice:example.org", origin_server_ts: 95_000, type: EventType.GroupCallMemberPrefix,
        content: { device_id: "ALICE", application: "m.call", call_id: "", focus_active: { type: "livekit" }, foci_preferred: [] },
      }))];
      return new DeviceVerificationStatus({ localVerified: true });
    } }) as unknown as CryptoApi;
    await expect(verifier.verify(reference, signal)).rejects.toThrow("membership changed during verification");
  });

  it.each([NaN, -1, Number.MAX_SAFE_INTEGER])("rejects invalid lease clocks: %s", async (now) => {
    const { source, verifier, signal } = await fixture();
    source.now.mockReturnValue(now);
    await expect(verifier.verify(reference, signal)).rejects.toThrow("Invalid MatrixRTC clock");
  });
});

describe("MatrixRtcRecipientVerifier", () => {
  it("authorizes an enrolled listener without an incoming key or microphone track and keeps input verification strict", async () => {
    const f = await fixture();
    f.source.keys.hasCurrentKey.mockReturnValue(false);
    f.participant.trackPublications.clear();
    const verifier = new MatrixRtcRecipientVerifier(f.source);
    const proof = await verifier.verify(reference, f.signal);
    expect(proof).toEqual({ ...reference, userId: "@alice:example.org", deviceId: "ALICE", expiresAtMs: 130_000, deviceVerified: true });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(proof).not.toHaveProperty("mediaEncrypted");
    expect(f.source.keys.hasCurrentKey).not.toHaveBeenCalled();
    await expect(f.verifier.verify(reference, f.signal)).rejects.toThrow("encrypted media");
    f.source.keys.hasCurrentKey.mockReturnValue(true);
    await expect(f.verifier.verify(reference, f.signal)).rejects.toThrow("encrypted audio");
    await verifier.verify(reference, f.signal);
    expect(f.getDeviceVerificationStatus).toHaveBeenCalledTimes(2);
  });

  it("never extends expiry and bounds an expiry-free membership", async () => {
    const f = await fixture(); const verifier = new MatrixRtcRecipientVerifier(f.source);
    f.source.now.mockReturnValue(190_000);
    expect((await verifier.verify(reference, f.signal)).expiresAtMs).toBe(200_000);
    const modern = await member(true);
    f.source.session.memberships = [modern];
    f.source.media.remoteParticipants.set(modern.rtcBackendIdentity, { ...f.participant, identity: modern.rtcBackendIdentity } as unknown as RemoteParticipant);
    expect((await verifier.verify({ ...reference, participantId: modern.rtcBackendIdentity }, f.signal)).expiresAtMs).toBe(220_000);
  });

  it.each(["room", "slot", "unsupported", "disconnected", "plaintext", "missing-member", "ambiguous", "missing-sfu", "identity", "crypto", "unknown", "unverified"])("rejects an unauthorized listener with %s evidence", async (kind) => {
    const f = await fixture(); const ref = { ...reference };
    if (kind === "room") ref.roomId = "!other";
    if (kind === "slot") ref.rtcSessionId = "m.call#other";
    if (kind === "unsupported") { f.source.session.slotId = "m.call#other"; ref.rtcSessionId = "m.call#other"; }
    if (kind === "disconnected") f.source.media.state = ConnectionState.Disconnected;
    if (kind === "plaintext") f.source.media.isE2EEEnabled = false;
    if (kind === "missing-member") f.source.session.memberships = [];
    if (kind === "ambiguous") f.source.session.memberships.push(f.source.session.memberships[0]!);
    if (kind === "missing-sfu") f.source.media.remoteParticipants.clear();
    if (kind === "identity") f.participant.identity = "other";
    if (kind === "crypto") f.source.client.getCrypto = () => undefined as unknown as CryptoApi;
    if (kind === "unknown") f.source.client.getCrypto = () => ({ getDeviceVerificationStatus: async () => null }) as unknown as CryptoApi;
    if (kind === "unverified") f.getDeviceVerificationStatus.mockResolvedValue(new DeviceVerificationStatus({ localVerified: false }));
    await expect(new MatrixRtcRecipientVerifier(f.source).verify(ref, f.signal)).rejects.toThrow("MatrixRTC");
  });

  it.each(["clock-fraction", "clock-negative", "clock-overflow", "created-fraction", "created-negative", "created-future", "expiry-fraction", "expired"])("rejects invalid listener lifetime: %s", async (kind) => {
    const f = await fixture(); const current = f.source.session.memberships[0]!;
    if (kind === "clock-fraction") f.source.now.mockReturnValue(100000.5);
    if (kind === "clock-negative") f.source.now.mockReturnValue(-1);
    if (kind === "clock-overflow") f.source.now.mockReturnValue(Number.MAX_SAFE_INTEGER);
    if (kind === "created-fraction") vi.spyOn(current, "createdTs").mockReturnValue(90000.5);
    if (kind === "created-negative") vi.spyOn(current, "createdTs").mockReturnValue(-1);
    if (kind === "created-future") vi.spyOn(current, "createdTs").mockReturnValue(100001);
    if (kind === "expiry-fraction") vi.spyOn(current, "getAbsoluteExpiry").mockReturnValue(200000.5);
    if (kind === "expired") vi.spyOn(current, "getAbsoluteExpiry").mockReturnValue(100000);
    await expect(new MatrixRtcRecipientVerifier(f.source).verify(reference, f.signal)).rejects.toThrow("MatrixRTC");
  });

  it.each(["before", "after", "changed", "expired"])("fences listener verification that is %s", async (kind) => {
    const f = await fixture(); const controller = new AbortController();
    if (kind === "before") controller.abort(new Error("cancelled"));
    f.getDeviceVerificationStatus.mockImplementationOnce(async () => {
      if (kind === "after") controller.abort(new Error("cancelled"));
      if (kind === "changed") vi.spyOn(f.source.session.memberships[0]!, "createdTs").mockReturnValue(90001);
      if (kind === "expired") f.source.now.mockReturnValue(200000);
      return new DeviceVerificationStatus({ localVerified: true });
    });
    await expect(new MatrixRtcRecipientVerifier(f.source).verify(reference, controller.signal)).rejects.toThrow();
  });
});
