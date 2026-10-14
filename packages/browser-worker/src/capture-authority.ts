import type { RtcMembership } from "../../matrixrtc/src/verified-keys.js";

function binding(member: RtcMembership): string {
  return JSON.stringify([member.userId, member.deviceId, member.memberId, member.participantId, member.createdAtMs]);
}

function active(member: RtcMembership, now: number): boolean {
  return Number.isSafeInteger(member.createdAtMs) && member.createdAtMs >= 0 && member.createdAtMs <= now &&
    (member.expiresAtMs === undefined || (Number.isSafeInteger(member.expiresAtMs) && member.expiresAtMs > now));
}

export function retainCapture(previous: readonly RtcMembership[], current: readonly RtcMembership[], now: number): boolean {
  if (!Number.isSafeInteger(now) || now < 0 || !previous.length || previous.length !== current.length) return false;
  const known = new Map(previous.map((member) => [member.participantId, member]));
  if (known.size !== previous.length) return false;
  const seen = new Set<string>();
  return current.every((member) => {
    const old = known.get(member.participantId);
    if (!old || seen.has(member.participantId)) return false;
    seen.add(member.participantId);
    if (!active(old, now) || !active(member, now) || binding(old) !== binding(member)) return false;
    return old.expiresAtMs === undefined ? member.expiresAtMs === undefined
      : member.expiresAtMs !== undefined && member.expiresAtMs >= old.expiresAtMs;
  });
}
