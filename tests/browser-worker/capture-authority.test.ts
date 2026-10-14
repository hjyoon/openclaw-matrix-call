import { describe, expect, it } from "vitest";
import { retainCapture } from "../../packages/browser-worker/src/capture-authority.js";
import type { RtcMembership } from "../../packages/matrixrtc/src/verified-keys.js";

const first: RtcMembership = { userId: "@a:example.org", deviceId: "A", memberId: "a", participantId: "a:A", createdAtMs: 0, expiresAtMs: 1000 };
const second: RtcMembership = { userId: "@b:example.org", deviceId: "B", memberId: "b", participantId: "b:B", createdAtMs: 10, expiresAtMs: 2000 };

describe("capture continuity authority", () => {
  it("retains the same active participants across ordering and lifetime extensions", () => {
    expect(retainCapture([first, second], [second, { ...first, expiresAtMs: 3000 }], 100)).toBe(true);
    expect(retainCapture([first], [first], 100)).toBe(true);
    const unbounded = { ...first, expiresAtMs: undefined };
    expect(retainCapture([unbounded], [unbounded], 100)).toBe(true);
    expect(retainCapture([first], [first], 0)).toBe(true);
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid clock %s", (now) => {
    expect(retainCapture([first], [first], now)).toBe(false);
  });

  it.each(["userId", "deviceId", "memberId", "participantId", "createdAtMs"] as const)("clears capture when %s changes", (field) => {
    expect(retainCapture([first], [{ ...first, [field]: field === "createdAtMs" ? 1 : "changed" }], 100)).toBe(false);
  });

  it("rejects empty, added, removed and duplicate participant sets", () => {
    expect(retainCapture([], [], 100)).toBe(false);
    expect(retainCapture([first], [first, second], 100)).toBe(false);
    expect(retainCapture([first, second], [first], 100)).toBe(false);
    expect(retainCapture([first, first], [first, second], 100)).toBe(false);
    expect(retainCapture([first, second], [first, first], 100)).toBe(false);
  });

  it.each(["previous", "current"])("rejects inactive or malformed %s membership", (side) => {
    const invalid = [
      { ...first, createdAtMs: NaN }, { ...first, createdAtMs: -1 }, { ...first, createdAtMs: 101 },
      { ...first, expiresAtMs: NaN }, { ...first, expiresAtMs: Infinity }, { ...first, expiresAtMs: 100 },
      { ...first, expiresAtMs: 99 },
    ];
    for (const member of invalid) expect(retainCapture(side === "previous" ? [member] : [first], side === "current" ? [member] : [first], 100)).toBe(false);
  });

  it("clears input across shortened or changed lifetime representation", () => {
    expect(retainCapture([first], [{ ...first, expiresAtMs: 999 }], 100)).toBe(false);
    expect(retainCapture([first], [{ ...first, expiresAtMs: undefined }], 100)).toBe(false);
    expect(retainCapture([{ ...first, expiresAtMs: undefined }], [first], 100)).toBe(false);
  });
});
