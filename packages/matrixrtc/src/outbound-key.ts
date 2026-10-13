import { EventType, type MatrixClient } from "matrix-js-sdk";
import type { ParticipantKeySink, RtcMembership } from "./verified-keys.js";

export type OutboundKeySource = Readonly<{
  roomId: string;
  owners: readonly string[];
  client: Pick<MatrixClient, "getUserId" | "getDeviceId" | "getCrypto" | "encryptAndSendToDevice">;
  memberships: () => readonly RtcMembership[];
  isJoined: () => boolean;
  now: () => number;
  sink: ParticipantKeySink & { bindLocalIdentity(identity: string): void };
}>;

export async function publishMatrixRtcKey(source: OutboundKeySource, index: number, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error("Invalid MatrixRTC key index");
  const userId = source.client.getUserId();
  const deviceId = source.client.getDeviceId();
  const members = source.memberships();
  const own = members.filter((member) => member.userId === userId && member.deviceId === deviceId);
  const now = source.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid MatrixRTC clock");
  if (!source.isJoined() || own.length !== 1 || members.length > 64 ||
      new Set(members.map((member) => member.participantId)).size !== members.length) {
    throw new Error("MatrixRTC local membership is unavailable");
  }
  for (const member of members) {
    if (!source.owners.includes(member.userId) || !Number.isSafeInteger(member.createdAtMs) || member.createdAtMs < 0 || member.createdAtMs > now ||
        (member.expiresAtMs !== undefined && (!Number.isSafeInteger(member.expiresAtMs) || member.expiresAtMs <= now))) {
      throw new Error("MatrixRTC listener is not authorized");
    }
  }
  const local = own[0]!;
  const targets = members.filter((member) => member !== local);
  const snapshot = JSON.stringify(members);
  const cryptoApi = source.client.getCrypto();
  if (!cryptoApi) throw new Error("MatrixRTC crypto is unavailable");
  for (const member of targets) {
    const status = await cryptoApi.getDeviceVerificationStatus(member.userId, member.deviceId);
    signal.throwIfAborted();
    if (!status?.isVerified()) throw new Error("MatrixRTC listener device is not verified");
  }
  const current = () => {
    const currentNow = source.now();
    return !signal.aborted && source.isJoined() && JSON.stringify(source.memberships()) === snapshot &&
      Number.isSafeInteger(currentNow) && currentNow >= 0 && members.every((member) =>
        member.createdAtMs <= currentNow && (member.expiresAtMs === undefined || member.expiresAtMs > currentNow),
      );
  };
  if (!current()) return false;
  source.sink.bindLocalIdentity(local.participantId);
  const key = crypto.getRandomValues(new Uint8Array(16));
  const content = {
    room_id: source.roomId,
    member: { id: local.memberId, claimed_device_id: local.deviceId },
    session: { application: "m.call", call_id: "", scope: "m.room" },
    keys: { index, key: btoa(String.fromCharCode(...key)).replace(/=+$/, "") },
    sent_ts: now,
  };
  if (targets.length > 0) {
    await source.client.encryptAndSendToDevice(EventType.CallEncryptionKeysPrefix, targets.map((member) => ({ userId: member.userId, deviceId: member.deviceId })), content);
  }
  signal.throwIfAborted();
  if (!current()) return false;
  return source.sink.install(local.participantId, key, index, current);
}
