import { ConnectionState } from "livekit-client";
import type { ParticipantReference, VerifiedParticipant } from "@matrix-call/core";
import { membershipSnapshot, type MatrixParticipantSource } from "./participants.js";

export type VerifiedMatrixRecipient = Readonly<Omit<VerifiedParticipant, "mediaEncrypted">>;
export type MatrixRecipientSource = Omit<MatrixParticipantSource, "keys">;

export class MatrixRtcRecipientVerifier {
  readonly #source: MatrixRecipientSource;

  constructor(source: MatrixRecipientSource) { this.#source = source; }

  async verify(reference: ParticipantReference, signal: AbortSignal): Promise<VerifiedMatrixRecipient> {
    signal.throwIfAborted();
    const first = this.#member(reference);
    const trust = await this.#source.client.getCrypto()?.getDeviceVerificationStatus(first.member.userId, first.member.deviceId);
    signal.throwIfAborted();
    if (!trust?.isVerified()) throw new Error("MatrixRTC recipient device is not verified");
    const current = this.#member(reference);
    if (JSON.stringify(first.member) !== JSON.stringify(current.member)) throw new Error("MatrixRTC recipient membership changed during verification");
    return Object.freeze({ ...reference, userId: current.member.userId, deviceId: current.member.deviceId,
      expiresAtMs: Math.min(current.member.expiresAtMs ?? Number.MAX_SAFE_INTEGER, current.now + 30_000), deviceVerified: true });
  }

  #member(reference: ParticipantReference) {
    const { session, media } = this.#source;
    if (reference.roomId !== this.#source.roomId || reference.rtcSessionId !== session.slotId || session.slotId !== "m.call#ROOM") throw new Error("MatrixRTC recipient session does not match");
    if (media.state !== ConnectionState.Connected || !media.isE2EEEnabled) throw new Error("MatrixRTC recipient encrypted connection is unavailable");
    const members = session.memberships.filter((member) => member.rtcBackendIdentity === reference.participantId);
    if (members.length !== 1 || media.remoteParticipants.get(reference.participantId)?.identity !== reference.participantId) throw new Error("MatrixRTC recipient membership is unavailable");
    const member = membershipSnapshot(members[0]!);
    const now = this.#source.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 30_000) throw new Error("Invalid MatrixRTC clock");
    if (!Number.isSafeInteger(member.createdAtMs) || member.createdAtMs < 0 || member.createdAtMs > now ||
        (member.expiresAtMs !== undefined && (!Number.isSafeInteger(member.expiresAtMs) || member.expiresAtMs <= now))) throw new Error("MatrixRTC recipient membership is expired or invalid");
    return { member, now };
  }
}
