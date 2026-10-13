import { describe, expect, it, vi } from "vitest";
import { EventType, type ReceivedToDeviceMessage } from "matrix-js-sdk";
import { MatrixMediaKeyProvider } from "../../packages/matrixrtc/src/key-provider.js";
import { VerifiedMatrixRtcKeys, type RtcMembership, type ParticipantKeySink } from "../../packages/matrixrtc/src/verified-keys.js";

const baseMember: RtcMembership = { userId: "@alice:example.org", deviceId: "ALICE", memberId: "member-a", participantId: "sfu-a", createdAtMs: 90_000, expiresAtMs: 200_000 };

function payload(): ReceivedToDeviceMessage {
  return {
    message: { type: EventType.CallEncryptionKeysPrefix, sender: baseMember.userId, content: {
      room_id: "!room", member: { id: "member-a", claimed_device_id: "ALICE" },
      session: { application: "m.call", call_id: "", scope: "m.room" },
      keys: { key: btoa(String.fromCharCode(...new Uint8Array(16).fill(7))).replace(/=+$/, ""), index: 0 }, sent_ts: 100_000,
    } },
    encryptionInfo: { sender: baseMember.userId, senderDevice: "ALICE", senderVerified: true, senderCurve25519KeyBase64: "authenticated-by-rust-crypto" },
  };
}

function fixture(sink: ParticipantKeySink = new MatrixMediaKeyProvider()) {
  let members: readonly RtcMembership[] = [baseMember];
  let now = 100_000;
  const gate = new VerifiedMatrixRtcKeys({ roomId: "!room", owners: [baseMember.userId], memberships: () => members, now: () => now }, sink);
  return { gate, sink, setMembers: (value: readonly RtcMembership[]) => { members = value; }, setNow: (value: number) => { now = value; } };
}

describe("VerifiedMatrixRtcKeys", () => {
  it("imports authenticated per-device keys through the real SDK provider", async () => {
    const { gate, sink } = fixture();
    expect(gate.hasCurrentKey("sfu-a")).toBe(false);
    expect(await gate.receive(payload())).toBe(true);
    expect(gate.hasCurrentKey("sfu-a")).toBe(true);
    expect((sink as MatrixMediaKeyProvider).getKeys()[0]).toMatchObject({ participantIdentity: "sfu-a", keyIndex: 0 });
    const padded = payload();
    padded.message.content.keys.key += "==";
    padded.message.content.keys.index = 255;
    expect(await gate.receive(padded)).toBe(true);
  });

  it.each([
    (p: ReceivedToDeviceMessage) => { p.message.type = "m.room.message"; },
    (p: ReceivedToDeviceMessage) => { p.encryptionInfo = null; },
    (p: ReceivedToDeviceMessage) => { p.encryptionInfo!.senderVerified = false; },
    (p: ReceivedToDeviceMessage) => { delete p.encryptionInfo!.senderDevice; },
    (p: ReceivedToDeviceMessage) => { p.message.sender = "@mallory:example.org"; },
    (p: ReceivedToDeviceMessage) => { p.message.sender = p.encryptionInfo!.sender = "@mallory:example.org"; },
    (p: ReceivedToDeviceMessage) => { p.message.content = {}; },
    (p: ReceivedToDeviceMessage) => { p.message.content.room_id = "!elsewhere"; },
    (p: ReceivedToDeviceMessage) => { p.message.content.member.claimed_device_id = "OTHER"; },
    (p: ReceivedToDeviceMessage) => { p.message.content.member.id = "not-current"; },
    (p: ReceivedToDeviceMessage) => { p.message.content.session.call_id = "other-call"; },
    (p: ReceivedToDeviceMessage) => { p.message.content.session.scope = "other-scope"; },
    (p: ReceivedToDeviceMessage) => { p.message.content.session.application = "other-app"; },
    (p: ReceivedToDeviceMessage) => { p.message.content.keys.key = "plaintext"; },
    (p: ReceivedToDeviceMessage) => { p.message.content.keys.key = "A".repeat(21) + "B"; },
    (p: ReceivedToDeviceMessage) => { p.message.content.keys.index = 256; },
    (p: ReceivedToDeviceMessage) => { p.message.content.sent_ts = 69_999; },
    (p: ReceivedToDeviceMessage) => { p.message.content.sent_ts = 130_001; },
  ])("rejects invalid identity, scope, timing, or key evidence", async (mutate) => {
    const sink = { install: vi.fn() };
    const { gate } = fixture(sink);
    const p = payload();
    mutate(p);
    expect(await gate.receive(p)).toBe(false);
    expect(gate.hasCurrentKey("sfu-a")).toBe(false);
    expect(sink.install).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [baseMember, baseMember],
    [{ ...baseMember, userId: "@other:example.org" }],
    [{ ...baseMember, deviceId: "OTHER" }],
    [{ ...baseMember, createdAtMs: NaN }],
    [{ ...baseMember, createdAtMs: -1 }],
    [{ ...baseMember, createdAtMs: 100_001 }],
    [{ ...baseMember, expiresAtMs: NaN }],
    [{ ...baseMember, expiresAtMs: 100_000 }],
  ].map((members) => ({ members })))("requires exactly one live matching membership", async ({ members }) => {
    const { gate, setMembers } = fixture();
    setMembers(members);
    expect(await gate.receive(payload())).toBe(false);
  });

  it("accepts the exact clock-skew boundary for a current membership", async () => {
    const { gate } = fixture();
    const p = payload();
    p.message.content.sent_ts = 70_000;
    expect(await gate.receive(p)).toBe(true);
    p.message.content.sent_ts = 130_000;
    expect(await gate.receive(p)).toBe(true);
  });

  it("supports sticky membership without granting an infinite proof to a departed member", async () => {
    const { gate, setMembers } = fixture();
    setMembers([{ ...baseMember, expiresAtMs: undefined }]);
    expect(await gate.receive(payload())).toBe(true);
    expect(gate.hasCurrentKey("sfu-a")).toBe(true);
    setMembers([]);
    expect(gate.hasCurrentKey("sfu-a")).toBe(false);
  });

  it.each([
    [], [baseMember, baseMember], [{ ...baseMember, memberId: "rejoined" }], [{ ...baseMember, createdAtMs: 95_000 }],
  ].map((members) => ({ members })))("invalidates proof after departure, ambiguity, or rejoin", async ({ members }) => {
    const { gate, setMembers } = fixture();
    expect(await gate.receive(payload())).toBe(true);
    setMembers(members);
    expect(gate.hasCurrentKey("sfu-a")).toBe(false);
  });

  it("invalidates proof on expiry and rejects broken clocks", async () => {
    const { gate, setNow } = fixture();
    expect(await gate.receive(payload())).toBe(true);
    setNow(200_000);
    expect(gate.hasCurrentKey("sfu-a")).toBe(false);
    for (const now of [NaN, -1, 0.5]) {
      setNow(now);
      await expect(gate.receive(payload())).rejects.toThrow("Invalid MatrixRTC clock");
    }
  });

  it("discards a completed import if membership changes", async () => {
    let finish!: (value: boolean) => void;
    const sink = { install: vi.fn((_id, _bytes, _index, current) => {
      expect(current()).toBe(true);
      return new Promise<boolean>((resolve) => { finish = resolve; });
    }) } satisfies ParticipantKeySink;
    const { gate, setMembers } = fixture(sink);
    const pending = gate.receive(payload());
    setMembers([]);
    finish(true);
    expect(await pending).toBe(false);
    expect(gate.hasCurrentKey("sfu-a")).toBe(false);
  });

  it("discards superseded concurrent imports for the same key index", async () => {
    const finishes: ((value: boolean) => void)[] = [];
    const sink: ParticipantKeySink = { install: () => new Promise((resolve) => { finishes.push(resolve); }) };
    const { gate } = fixture(sink);
    const first = gate.receive(payload());
    const second = gate.receive(payload());
    finishes[0]!(true);
    expect(await first).toBe(false);
    finishes[1]!(true);
    expect(await second).toBe(true);
  });

  it("does not claim an uninstalled key and propagates import errors without retaining authority", async () => {
    const sink = { install: vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("crypto unavailable")) };
    const { gate } = fixture(sink);
    expect(await gate.receive(payload())).toBe(false);
    await expect(gate.receive(payload())).rejects.toThrow("crypto unavailable");
    expect(gate.hasCurrentKey("sfu-a")).toBe(false);
  });

  it("closes permanently and rejects late imports and future messages", async () => {
    const { gate } = fixture();
    expect(await gate.receive(payload())).toBe(true);
    const pending = gate.receive(payload());
    gate.close();
    expect(await pending).toBe(false);
    expect(gate.hasCurrentKey("sfu-a")).toBe(false);
    expect(await gate.receive(payload())).toBe(false);
    gate.close();
  });
});
