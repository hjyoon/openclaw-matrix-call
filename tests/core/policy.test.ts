import { describe, expect, it } from "vitest";
import { authorizeParticipant, CallError, parsePolicy } from "../../packages/core/src/index.js";
import type { ParticipantReference, VerifiedParticipant } from "../../packages/core/src/index.js";

const config = {
  owners: ["@owner:example.org"],
  rooms: ["!room:example.org"],
  agents: ["assistant"],
};
const reference: ParticipantReference = {
  roomId: "!room:example.org",
  rtcSessionId: "rtc-1",
  participantId: "participant-1",
};
const participant: VerifiedParticipant = {
  ...reference,
  userId: "@owner:example.org",
  deviceId: "DEVICE",
  expiresAtMs: 2_000,
  deviceVerified: true,
  mediaEncrypted: true,
};

describe("caller policy", () => {
  it("accepts and freezes explicit owner, room, and agent policy", () => {
    const policy = parsePolicy(config);
    expect(policy).toEqual(config);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.owners)).toBe(true);
    expect(Object.isFrozen(policy.rooms)).toBe(true);
    expect(Object.isFrozen(policy.agents)).toBe(true);
  });

  it.each([
    null,
    {},
    { ...config, owners: [] },
    { ...config, owners: ["owner"] },
    { ...config, rooms: [] },
    { ...config, rooms: ["#alias:example.org"] },
    { ...config, agents: [] },
    { ...config, agents: ["../admin"] },
    { ...config, allowEveryone: true },
  ])("rejects invalid policy %#", (value) => {
    expect(() => parsePolicy(value)).toThrowError(new CallError("invalid-input"));
  });

  it("authorizes an encrypted, verified, unexpired owner in the bound call", () => {
    const verified = authorizeParticipant(parsePolicy(config), reference, participant, 1_000);
    expect(verified).toEqual(participant);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it.each([
    ["roomId", "!other:example.org"],
    ["rtcSessionId", "rtc-2"],
    ["participantId", "other-participant"],
  ])("rejects a mismatched %s", (field, value) => {
    expect(() => authorizeParticipant(parsePolicy(config), reference, {
      ...participant, [field]: value,
    }, 1_000)).toThrowError(new CallError("identity-mismatch"));
  });

  it("rejects unknown rooms", () => {
    expect(() => authorizeParticipant(parsePolicy({ ...config, rooms: ["!other:example.org"] }),
      reference, participant, 1_000)).toThrowError(new CallError("forbidden"));
  });

  it("rejects non-owner callers", () => {
    expect(() => authorizeParticipant(parsePolicy(config), reference, {
      ...participant, userId: "@visitor:example.org",
    }, 1_000)).toThrowError(new CallError("forbidden"));
  });

  it.each([999, 1_000])("rejects expired membership at %i", (expiresAtMs) => {
    expect(() => authorizeParticipant(parsePolicy(config), reference, {
      ...participant, expiresAtMs,
    }, 1_000)).toThrowError(new CallError("expired-membership"));
  });

  it("rejects unverified devices", () => {
    expect(() => authorizeParticipant(parsePolicy(config), reference, {
      ...participant, deviceVerified: false,
    }, 1_000)).toThrowError(new CallError("unverified-device"));
  });

  it("rejects unencrypted media", () => {
    expect(() => authorizeParticipant(parsePolicy(config), reference, {
      ...participant, mediaEncrypted: false,
    }, 1_000)).toThrowError(new CallError("unencrypted-media"));
  });

  it("validates evidence returned by a verifier", () => {
    expect(() => authorizeParticipant(parsePolicy(config), reference, {
      ...participant, userId: "Owner Display Name",
    }, 1_000)).toThrowError(new CallError("invalid-input"));
  });
});
