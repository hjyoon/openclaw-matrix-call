import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthenticationError, RequestAuthenticator } from "../../packages/core/src/index.js";

const secret = "ab".repeat(32);
const audience = "58c385e3-b601-4a6e-9d9f-9b2156c4f109";
const message = { method: "POST", path: "/v1/agent/turns", body: '{"text":"Hello 🌍"}' };

function setup(options: { windowMs?: number; maxNonces?: number } = {}) {
  let now = 100_000;
  const auth = new RequestAuthenticator({ secret, audience, ...options, now: () => now });
  return { auth, setTime: (time: number) => { now = time; } };
}

describe("dedicated HTTP authentication", () => {
  it("authenticates requests with defaults and a generated unique nonce", () => {
    const auth = new RequestAuthenticator({ secret, audience });
    const headers = auth.sign(message);
    expect(Object.isFrozen(headers)).toBe(true);
    expect(headers["x-matrix-call-time"]).toMatch(/^[0-9]+$/);
    expect(headers["x-matrix-call-signature"]).not.toBe(secret);
    auth.verify(message, headers);
    auth.verify(message, auth.sign(message));
  });

  it.each([
    { secret: "short", audience },
    { secret, audience: "gateway-token" },
    { secret, audience, windowMs: 0 },
    { secret, audience, windowMs: 60_001 },
    { secret, audience, windowMs: 1.5 },
    { secret, audience, maxNonces: 0 },
    { secret, audience, maxNonces: 65_537 },
    { secret, audience, maxNonces: NaN },
  ])("rejects unsafe configuration %#", (options) => {
    expect(() => new RequestAuthenticator(options)).toThrowError(new AuthenticationError("invalid-auth"));
  });

  it.each([
    { ...message, method: "POST\nGET" },
    { ...message, path: "https://example.org/v1" },
    { ...message, path: "/v1#fragment" },
    { ...message, body: "x".repeat(2_000_001) },
  ])("rejects invalid signing messages %#", (value) => {
    expect(() => setup().auth.sign(value)).toThrowError(new AuthenticationError("invalid-auth"));
  });

  it.each([NaN, -1, 1.5])("rejects invalid signing timestamps %s", (time) => {
    const { auth, setTime } = setup();
    setTime(time);
    expect(() => auth.sign(message)).toThrowError(new AuthenticationError("invalid-auth"));
  });

  it.each([
    {},
    { "x-matrix-call-time": "0100000" },
    { "x-matrix-call-time": ["100000", "100000"] },
    { "x-matrix-call-nonce": "not-a-uuid" },
    { "x-matrix-call-signature": "f" },
    { "x-matrix-call-audience": randomUUID() },
  ])("rejects missing, ambiguous, or invalid headers %#", (extra) => {
    const { auth } = setup();
    const headers = extra["x-matrix-call-time"] === undefined && Object.keys(extra).length === 0
      ? {} : { ...auth.sign(message), ...extra };
    expect(() => auth.verify(message, headers)).toThrowError(new AuthenticationError("invalid-auth"));
  });

  it("rejects invalid messages before verification", () => {
    const { auth } = setup();
    expect(() => auth.verify({ ...message, path: "relative" }, auth.sign(message)))
      .toThrowError(new AuthenticationError("invalid-auth"));
  });

  it.each([
    { ...message, method: "GET" },
    { ...message, path: "/v1/other" },
    { ...message, body: "different" },
  ])("binds signatures to method, path, and raw body %#", (value) => {
    const { auth } = setup();
    expect(() => auth.verify(value, auth.sign(message)))
      .toThrowError(new AuthenticationError("invalid-auth"));
  });

  it("rejects requests signed with another dedicated secret", () => {
    const { auth } = setup();
    const wrong = new RequestAuthenticator({ secret: "cd".repeat(32), audience, now: () => 100_000 });
    expect(() => auth.verify(message, wrong.sign(message)))
      .toThrowError(new AuthenticationError("invalid-auth"));
  });

  it.each([69_999, 130_001, NaN])("rejects stale, future, or invalid clock values %s", (time) => {
    const { auth, setTime } = setup();
    const headers = auth.sign(message);
    setTime(time);
    expect(() => auth.verify(message, headers)).toThrowError(new AuthenticationError("stale-request"));
  });

  it("rejects unsafe timestamp integers", () => {
    const { auth } = setup();
    expect(() => auth.verify(message, { ...auth.sign(message), "x-matrix-call-time": "9007199254740992" }))
      .toThrowError(new AuthenticationError("stale-request"));
  });

  it.each([70_000, 130_000])("accepts the configured time boundary %i", (time) => {
    const { auth, setTime } = setup();
    const headers = auth.sign(message);
    setTime(time);
    auth.verify(message, headers);
  });

  it("rejects replay throughout the valid time window", () => {
    const { auth, setTime } = setup();
    const headers = auth.sign(message);
    auth.verify(message, headers);
    setTime(130_000);
    expect(() => auth.verify(message, headers)).toThrowError(new AuthenticationError("replayed-request"));
  });

  it("fails closed at capacity without evicting valid replay protection", () => {
    const { auth, setTime } = setup({ maxNonces: 1 });
    const headers = auth.sign(message);
    auth.verify(message, headers);
    expect(() => auth.verify(message, auth.sign(message)))
      .toThrowError(new AuthenticationError("auth-capacity"));
    expect(() => auth.verify(message, headers)).toThrowError(new AuthenticationError("replayed-request"));
    setTime(130_001);
    auth.verify(message, auth.sign(message));
  });

  it("rejects requests addressed to a previous process incarnation", () => {
    const { auth } = setup();
    const restarted = new RequestAuthenticator({ secret, audience: randomUUID(), now: () => 100_000 });
    expect(() => restarted.verify(message, auth.sign(message)))
      .toThrowError(new AuthenticationError("invalid-auth"));
  });
});
