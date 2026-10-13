import { EventType, type ReceivedToDeviceMessage } from "matrix-js-sdk";
import { z } from "zod";

export type RtcMembership = Readonly<{
  userId: string;
  deviceId: string;
  memberId: string;
  participantId: string;
  createdAtMs: number;
  expiresAtMs: number | undefined;
}>;

export interface ParticipantKeySink {
  install(identity: string, bytes: Uint8Array<ArrayBuffer>, index: number, isCurrent: () => boolean): Promise<boolean>;
}

export type VerifiedKeySource = Readonly<{
  roomId: string;
  owners: readonly string[];
  memberships: () => readonly RtcMembership[];
  now: () => number;
}>;

const keyEvent = z.object({
  room_id: z.string(),
  member: z.object({ id: z.string().min(1).max(1024), claimed_device_id: z.string().min(1).max(255) }),
  session: z.object({ application: z.literal("m.call"), call_id: z.literal(""), scope: z.literal("m.room") }),
  keys: z.object({
    index: z.number().int().min(0).max(255),
    key: z.string().regex(/^[A-Za-z0-9+/]{22}(==)?$/).pipe(z.string().refine((value) => btoa(atob(value)).replace(/=+$/, "") === value.replace(/=+$/, ""))),
  }),
  sent_ts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

function binding(member: RtcMembership): string {
  return JSON.stringify([member.userId, member.deviceId, member.memberId, member.participantId, member.createdAtMs]);
}

export class VerifiedMatrixRtcKeys {
  readonly #source: VerifiedKeySource;
  readonly #sink: ParticipantKeySink;
  readonly #proofs = new Map<string, string>();
  readonly #pending = new Map<string, symbol>();
  #closed = false;

  constructor(source: VerifiedKeySource, sink: ParticipantKeySink) {
    this.#source = source;
    this.#sink = sink;
  }

  async receive(payload: ReceivedToDeviceMessage): Promise<boolean> {
    if (this.#closed || payload.message.type !== EventType.CallEncryptionKeysPrefix) return false;
    const authenticated = payload.encryptionInfo;
    if (!authenticated?.senderVerified || !authenticated.senderDevice) return false;
    if (payload.message.sender !== authenticated.sender || !this.#source.owners.includes(authenticated.sender)) return false;
    const parsed = keyEvent.safeParse(payload.message.content);
    if (!parsed.success) return false;
    const data = parsed.data;
    if (data.room_id !== this.#source.roomId || data.member.claimed_device_id !== authenticated.senderDevice) return false;
    const now = this.#now();
    if (Math.abs(now - data.sent_ts) > 30_000) return false;
    const matches = this.#source.memberships().filter((member) =>
      member.userId === authenticated.sender && member.deviceId === authenticated.senderDevice && member.memberId === data.member.id,
    );
    if (matches.length !== 1) return false;
    const member = matches[0]!;
    if (!this.#active(member, now)) return false;
    const snapshot = binding(member);
    const pendingId = JSON.stringify([member.participantId, data.keys.index]);
    const token = Symbol();
    this.#pending.set(pendingId, token);
    const current = () => !this.#closed && this.#pending.get(pendingId) === token && this.#matches(member.participantId, snapshot);
    const bytes = Uint8Array.from(atob(data.keys.key), (character) => character.charCodeAt(0));
    try {
      const installed = await this.#sink.install(member.participantId, bytes, data.keys.index, current);
      if (!installed || !current()) return false;
      this.#proofs.set(member.participantId, snapshot);
      return true;
    } finally {
      if (this.#pending.get(pendingId) === token) this.#pending.delete(pendingId);
    }
  }

  hasCurrentKey(participantId: string): boolean {
    const snapshot = this.#proofs.get(participantId);
    return !this.#closed && snapshot !== undefined && this.#matches(participantId, snapshot);
  }

  close(): void {
    this.#closed = true;
    this.#proofs.clear();
    this.#pending.clear();
  }

  #matches(participantId: string, snapshot: string): boolean {
    const matches = this.#source.memberships().filter((member) => member.participantId === participantId);
    return matches.length === 1 && binding(matches[0]!) === snapshot && this.#active(matches[0]!, this.#now());
  }

  #active(member: RtcMembership, now: number): boolean {
    return Number.isSafeInteger(member.createdAtMs) && member.createdAtMs >= 0 && member.createdAtMs <= now &&
      (member.expiresAtMs === undefined || (Number.isSafeInteger(member.expiresAtMs) && member.expiresAtMs > now));
  }

  #now(): number {
    const now = this.#source.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid MatrixRTC clock");
    return now;
  }
}
