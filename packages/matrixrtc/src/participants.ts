import { ConnectionState, Track, type Room } from "livekit-client";
import type { MatrixClient } from "matrix-js-sdk";
import type { CallMembership, MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/index.js";
import type { ParticipantReference, ParticipantVerifier, VerifiedParticipant } from "@matrix-call/core";
import type { RtcMembership, VerifiedMatrixRtcKeys } from "./verified-keys.js";

export function membershipSnapshot(member: CallMembership): RtcMembership {
  return Object.freeze({
    userId: member.userId,
    deviceId: member.deviceId,
    memberId: member.memberId,
    participantId: member.rtcBackendIdentity,
    createdAtMs: member.createdTs(),
    expiresAtMs: member.getAbsoluteExpiry(),
  });
}

export type MatrixParticipantSource = Readonly<{
  roomId: string;
  client: Pick<MatrixClient, "getCrypto">;
  session: Pick<MatrixRTCSession, "slotId" | "memberships">;
  media: Pick<Room, "state" | "isE2EEEnabled" | "remoteParticipants">;
  keys: Pick<VerifiedMatrixRtcKeys, "hasCurrentKey">;
  now: () => number;
}>;

export class MatrixRtcParticipantVerifier implements ParticipantVerifier {
  readonly #source: MatrixParticipantSource;

  constructor(source: MatrixParticipantSource) {
    this.#source = source;
  }

  async verify(reference: ParticipantReference, signal: AbortSignal): Promise<VerifiedParticipant> {
    signal.throwIfAborted();
    const first = this.#member(reference);
    const status = await this.#source.client.getCrypto()?.getDeviceVerificationStatus(first.userId, first.deviceId);
    signal.throwIfAborted();
    if (!status?.isVerified()) throw new Error("MatrixRTC device is not verified");
    const current = this.#member(reference);
    if (JSON.stringify(first) !== JSON.stringify(current)) throw new Error("MatrixRTC membership changed during verification");
    const now = this.#source.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 30_000) throw new Error("Invalid MatrixRTC clock");
    return Object.freeze({
      ...reference,
      userId: current.userId,
      deviceId: current.deviceId,
      expiresAtMs: Math.min(current.expiresAtMs ?? now + 30_000, now + 30_000),
      deviceVerified: true,
      mediaEncrypted: true,
    });
  }

  #member(reference: ParticipantReference): RtcMembership {
    const { session, media } = this.#source;
    if (reference.roomId !== this.#source.roomId || reference.rtcSessionId !== session.slotId || session.slotId !== "m.call#ROOM") {
      throw new Error("MatrixRTC session does not match");
    }
    if (media.state !== ConnectionState.Connected || !media.isE2EEEnabled || !this.#source.keys.hasCurrentKey(reference.participantId)) {
      throw new Error("MatrixRTC encrypted media is unavailable");
    }
    const members = session.memberships.filter((member) => member.rtcBackendIdentity === reference.participantId);
    if (members.length !== 1) throw new Error("MatrixRTC membership is unavailable");
    const participant = media.remoteParticipants.get(reference.participantId);
    if (participant?.identity !== reference.participantId || ![...participant.trackPublications.values()].some((publication) =>
      publication.kind === Track.Kind.Audio && publication.isEncrypted && publication.isSubscribed && publication.track?.mediaStreamTrack.readyState === "live",
    )) {
      throw new Error("MatrixRTC encrypted audio is unavailable");
    }
    return membershipSnapshot(members[0]!);
  }
}
