import { describe, expect, it } from "vitest";
import { decodePcm, encodePcm, speechCapabilitiesSchema, synthesisRequestSchema, transcriptionRequestSchema, transcriptionResponseSchema } from "../../packages/speech-http/src/index.js";

const requestId = "ac02d9dc-7bcd-4dfc-b738-8281d83778bb";
const audio = { samples: new Int16Array([-32768, -1, 0, 1, 32767]), sampleRate: 16_000, channels: 1 as const };

describe("portable speech protocol", () => {
  it("uses canonical little endian signed mono PCM without machine-endian assumptions", () => {
    const wire = encodePcm(audio);
    expect(Buffer.from(wire.data, "base64")).toEqual(Buffer.from([0, 128, 255, 255, 0, 0, 1, 0, 255, 127]));
    const decoded = decodePcm(wire);
    expect(decoded).toEqual(audio);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(transcriptionRequestSchema.parse({ protocolVersion: 1, requestId, audio: wire })).toMatchObject({ requestId });
  });

  it.each([
    "", "AA=", "====", "AAF=", "AA==", "AAA=\n", "AA__", "AAAA",
  ])("rejects malformed, noncanonical, empty or odd-length PCM %s", (data) => {
    expect(() => decodePcm({ ...encodePcm(audio), data })).toThrow();
  });

  it("bounds PCM to ten seconds and rejects missing, extra and invalid format fields", () => {
    const wire = encodePcm({ ...audio, sampleRate: 8000, samples: new Int16Array(80_000) });
    expect(decodePcm(wire).samples).toHaveLength(80_000);
    expect(() => decodePcm({ ...wire, data: Buffer.alloc(160_002).toString("base64") })).toThrow();
    expect(() => decodePcm({ ...wire, data: "A".repeat(1_280_004) })).toThrow();
    for (const value of [null, { ...wire, channels: 2 }, { ...wire, sampleRate: 48001 }, { ...wire, encoding: "float32" }, { ...wire, token: "secret" }]) {
      expect(() => decodePcm(value)).toThrow();
    }
    expect(() => encodePcm({ ...audio, samples: new Int16Array() })).toThrow("Invalid PCM audio");
  });

  it("permits empty recognition results but requires bounded nonempty synthesis text", () => {
    const envelope = { protocolVersion: 1, requestId };
    expect(transcriptionResponseSchema.parse({ ...envelope, text: "  " }).text).toBe("");
    expect(synthesisRequestSchema.parse({ ...envelope, text: " Hello " }).text).toBe("Hello");
    expect(() => synthesisRequestSchema.parse({ ...envelope, text: " " })).toThrow();
    expect(() => transcriptionResponseSchema.parse({ ...envelope, text: "x".repeat(16001) })).toThrow();
    expect(() => synthesisRequestSchema.parse({ ...envelope, role: "owner", text: "Hello" })).toThrow();
  });

  it("advertises both speech ports and pins the protocol and encoding", () => {
    const capabilities = { protocolVersion: 1, audience: requestId, recognition: true, synthesis: true, encoding: "pcm-s16le" };
    expect(speechCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(speechCapabilitiesSchema.safeParse({ ...capabilities, recognition: false }).success).toBe(false);
    expect(speechCapabilitiesSchema.safeParse({ ...capabilities, audience: "old" }).success).toBe(false);
  });
});
