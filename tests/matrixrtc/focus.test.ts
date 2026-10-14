import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FocusAuthorizationError, OpenIdFocusAuthorizer, type FocusAuthorizationSource } from "../../packages/matrixrtc/src/focus.js";
import type { RtcMembership } from "../../packages/matrixrtc/src/verified-keys.js";

const member: RtcMembership = { userId: "@bot:example.org", deviceId: "BOT", memberId: "local", participantId: "@bot:example.org:BOT", createdAtMs: 90_000, expiresAtMs: 200_000 };
const openId = { access_token: "private-openid-token", token_type: "Bearer", matrix_server_name: "example.org", expires_in: 3600 };
const roomAlias = createHash("sha256").update(JSON.stringify(["!room", "m.call#ROOM"])).digest("base64").replace(/=+$/, "");
const claims = { sub: member.participantId, exp: 200, nbf: 100, video: { room: roomAlias, roomJoin: true, canPublish: true, canSubscribe: true } };

function jwt(value: unknown = claims): string {
  return `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
}

function response(value: unknown = { url: "wss://sfu.example.org", jwt: jwt() }): Response {
  return Response.json(value);
}

function fixture() {
  let current: RtcMembership | undefined = member;
  let focus: unknown = { type: "livekit", livekit_service_url: "https://focus.example.org/rtc/", livekit_alias: "!room" };
  const getOpenIdToken = vi.fn(async () => ({ ...openId }));
  const source = {
    roomId: "!room", slotId: "m.call#ROOM", focus: () => focus, membership: () => current,
    client: { getUserId: () => member.userId, getDeviceId: () => member.deviceId, getOpenIdToken },
  } satisfies FocusAuthorizationSource;
  const fetcher = vi.fn(async () => response());
  const now = vi.fn(() => 100_000);
  const options = { focusUrls: ["https://focus.example.org/rtc"], sfuUrls: ["wss://sfu.example.org"], now, fetch: fetcher };
  const authorizer = new OpenIdFocusAuthorizer(options);
  return { source, options, authorizer, fetcher, now, getOpenIdToken, setMember: (value: RtcMembership | undefined) => { current = value; }, setFocus: (value: unknown) => { focus = value; }, signal: new AbortController().signal };
}

describe("OpenIdFocusAuthorizer", () => {
  it("binds the native browser fetch to its global receiver", async () => {
    const f = fixture();
    const { fetch: _fetch, ...options } = f.options;
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(response());
    });
    vi.stubGlobal("fetch", browserFetch);
    try {
      const authorizer = new OpenIdFocusAuthorizer(options);
      expect((await authorizer.authorize(f.source, f.signal)).identity).toBe(member.participantId);
      expect(browserFetch).toHaveBeenCalledOnce();
      expect(() => browserFetch.call({})).toThrow("Illegal invocation");
    } finally { vi.unstubAllGlobals(); }
  });

  it("exchanges only the local OpenID token with a configured focus and binds the returned grant", async () => {
    const { source, authorizer, fetcher, signal } = fixture();
    const grant = await authorizer.authorize(source, signal);
    expect(grant).toEqual({ url: "wss://sfu.example.org", jwt: jwt(), identity: member.participantId, expiresAtMs: 200_000 });
    expect(Object.isFrozen(grant)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("https://focus.example.org/rtc/sfu/get", expect.objectContaining({
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: "!room", device_id: "BOT", openid_token: openId }),
    }));
  });

  it("uses real loopback HTTP without an SFU signing key or a Gateway credential", async () => {
    let received: unknown;
    const now = Date.now();
    const local = { ...member, createdAtMs: now - 1000, expiresAtMs: now + 60_000 };
    const server = createServer(async (request, reply) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.url).toBe("/sfu/get");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString());
      reply.setHeader("Content-Type", "application/json");
      reply.end(JSON.stringify({ url: "ws://127.0.0.1:7880", jwt: jwt({ ...claims, exp: Math.floor(now / 1000) + 3600, nbf: Math.floor(now / 1000) }) }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const source: FocusAuthorizationSource = { roomId: "!room", slotId: "m.call#ROOM", focus: () => ({ type: "livekit", livekit_service_url: url, livekit_alias: "!room" }), membership: () => local,
        client: { getUserId: () => local.userId, getDeviceId: () => local.deviceId, getOpenIdToken: async () => openId } };
      const authorizer = new OpenIdFocusAuthorizer({ focusUrls: [url], sfuUrls: ["ws://127.0.0.1:7880"], allowInsecureLoopback: true });
      expect((await authorizer.authorize(source, new AbortController().signal)).identity).toBe(local.participantId);
      expect(received).toEqual({ room: "!room", device_id: "BOT", openid_token: openId });
    } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
  });

  it("accepts modern transport configuration while binding the grant to the actual room", async () => {
    const f = fixture();
    f.setFocus({ type: "livekit", livekit_service_url: "https://focus.example.org/rtc" });
    expect((await f.authorizer.authorize(f.source, f.signal)).identity).toBe(member.participantId);
    f.fetcher.mockResolvedValue(response({ url: "wss://sfu.example.org", jwt: jwt({ ...claims, video: { ...claims.video, room: "different-room" } }) }));
    await expect(f.authorizer.authorize(f.source, f.signal)).rejects.toThrow("identity-mismatch");
  });

  it("rejects unconfigured modern transport endpoints before exposing OpenID", async () => {
    const f = fixture(); f.setFocus({ type: "livekit", livekit_service_url: "https://attacker.example.org" });
    await expect(f.authorizer.authorize(f.source, f.signal)).rejects.toThrow("untrusted-focus");
    expect(f.getOpenIdToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { focusUrls: [] }, { sfuUrls: [] }, { focusUrls: Array(33).fill("https://focus.example.org") }, { sfuUrls: Array(33).fill("wss://sfu.example.org") },
    { timeoutMs: 0 }, { timeoutMs: 300_001 }, { timeoutMs: 0.5 },
    { focusUrls: ["invalid"] }, { focusUrls: ["https://user:secret@focus.example.org"] },
    { focusUrls: ["https://focus.example.org?secret=1"] }, { focusUrls: ["https://focus.example.org#secret"] },
    { focusUrls: [`https://focus.example.org/${"a".repeat(4096)}`] },
    { focusUrls: ["http://focus.example.org"] }, { sfuUrls: ["ws://sfu.example.org"] },
    { allowInsecureLoopback: true, focusUrls: ["http://focus.example.org"] },
    { allowInsecureLoopback: true, focusUrls: ["ftp://localhost"] },
  ])("rejects invalid configuration and unapproved plaintext endpoints", (change) => {
    const { options } = fixture();
    expect(() => new OpenIdFocusAuthorizer({ ...options, ...change })).toThrow(new FocusAuthorizationError("invalid-config"));
  });

  it("accepts explicitly enabled IPv6 and localhost test endpoints", () => {
    expect(() => new OpenIdFocusAuthorizer({ focusUrls: ["http://[::1]:8000"], sfuUrls: ["ws://localhost:7880"], allowInsecureLoopback: true })).not.toThrow();
  });

  it.each([
    { ...member, userId: "@other:example.org" }, { ...member, deviceId: "OTHER" }, { ...member, participantId: "hashed-modern-identity" },
  ])("rejects unbound local membership before obtaining credentials", async (value) => {
    const { source, authorizer, setMember, getOpenIdToken, signal } = fixture();
    setMember(value);
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("unsupported-call");
    expect(getOpenIdToken).not.toHaveBeenCalled();
  });

  it.each(["membership", "focus"])("requests fresh state when %s is temporarily unavailable", async (missing) => {
    const f = fixture();
    if (missing === "membership") f.setMember(undefined); else f.setFocus(undefined);
    await expect(f.authorizer.authorize(f.source, f.signal)).rejects.toThrow("membership-changed");
    expect(f.getOpenIdToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("rejects an unsupported slot", async () => {
    const { source, authorizer, signal } = fixture();
    source.slotId = "m.call#other";
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("unsupported-call");
  });

  it.each([null, {}, { type: "other" }, { type: "livekit", livekit_service_url: "https://focus.example.org", livekit_alias: "!other" }])("rejects missing, unsupported, or differently scoped focus metadata", async (value) => {
    const { source, authorizer, setFocus, signal } = fixture();
    setFocus(value);
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("unsupported-call");
  });

  it("rejects an untrusted advertised focus before exposing OpenID", async () => {
    const { source, authorizer, setFocus, getOpenIdToken, fetcher, signal } = fixture();
    setFocus({ type: "livekit", livekit_service_url: "https://attacker.example.org", livekit_alias: "!room" });
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("untrusted-focus");
    expect(getOpenIdToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([NaN, -1, 0.5, 80_000, 200_000])("rejects invalid clocks and inactive membership: %s", async (now) => {
    const { source, authorizer, now: clock, signal } = fixture();
    clock.mockReturnValue(now);
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("membership-changed");
  });

  it("accepts a current nonexpiring membership representation", async () => {
    const { source, authorizer, setMember, signal } = fixture();
    setMember({ ...member, expiresAtMs: undefined });
    expect((await authorizer.authorize(source, signal)).identity).toBe(member.participantId);
  });

  it.each([{ createdAtMs: NaN }, { createdAtMs: -1 }, { expiresAtMs: NaN }])("rejects invalid membership timestamps", async (change) => {
    const { source, authorizer, setMember, signal } = fixture();
    setMember({ ...member, ...change });
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("membership-changed");
  });

  it.each([
    { access_token: "" }, { token_type: "other" }, { matrix_server_name: "other.org" }, { expires_in: 0 },
  ])("rejects invalid OpenID tokens and mismatched issuers", async (change) => {
    const { source, authorizer, getOpenIdToken, fetcher, signal } = fixture();
    getOpenIdToken.mockResolvedValue({ ...openId, ...change });
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("invalid-response");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects membership changes while obtaining OpenID", async () => {
    const { source, authorizer, getOpenIdToken, fetcher, setMember, signal } = fixture();
    getOpenIdToken.mockImplementation(async () => { setMember(undefined); return openId; });
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("membership-changed");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 302, 500])("never falls back after HTTP %s", async (status) => {
    const { source, authorizer, fetcher, signal } = fixture();
    fetcher.mockResolvedValue(new Response("private response", { status }));
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("http-error");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, {}, { url: "wss://sfu.example.org", jwt: "bad" },
    { url: "wss://sfu.example.org", jwt: "header.A.signature" },
    { url: "wss://sfu.example.org", jwt: jwt(null) },
    { url: "wss://sfu.example.org", jwt: `header.${Buffer.from("not-json").toString("base64url")}.signature` },
    { url: "wss://sfu.example.org", jwt: `header.${Buffer.from([0xff]).toString("base64url")}.signature` },
  ])("rejects malformed responses and token payloads", async (value) => {
    const { source, authorizer, fetcher, signal } = fixture();
    fetcher.mockResolvedValue(response(value));
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("invalid-response");
  });

  it.each([
    { exp: 100 }, { exp: 100_000 }, { nbf: 106 }, { video: { ...claims.video, roomAdmin: true } },
    { video: { ...claims.video, canSubscribe: false } },
  ])("rejects expired, premature, excessive, or overprivileged grants", async (change) => {
    const { source, authorizer, fetcher, signal } = fixture();
    fetcher.mockResolvedValue(response({ url: "wss://sfu.example.org", jwt: jwt({ ...claims, ...change }) }));
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("invalid-response");
  });

  it("accepts grants without an optional nbf", async () => {
    const { source, authorizer, fetcher, signal } = fixture();
    const { nbf: _nbf, ...withoutNbf } = claims;
    fetcher.mockResolvedValue(response({ url: "wss://sfu.example.org", jwt: jwt(withoutNbf) }));
    expect((await authorizer.authorize(source, signal)).identity).toBe(member.participantId);
  });

  it.each([{ sub: "other" }, { video: { ...claims.video, room: "!other" } }])("binds the token to the exact participant and room", async (change) => {
    const { source, authorizer, fetcher, signal } = fixture();
    fetcher.mockResolvedValue(response({ url: "wss://sfu.example.org", jwt: jwt({ ...claims, ...change }) }));
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("identity-mismatch");
  });

  it("rejects a focus-provided SFU outside configuration", async () => {
    const { source, authorizer, fetcher, signal } = fixture();
    fetcher.mockResolvedValue(response({ url: "wss://attacker.example.org", jwt: jwt() }));
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("untrusted-sfu");
  });

  it("reads multiple chunks and rejects oversized, missing, and malformed bodies", async () => {
    const { source, authorizer, fetcher, signal } = fixture();
    const bytes = new TextEncoder().encode(JSON.stringify({ url: "wss://sfu.example.org", jwt: jwt() }));
    fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 10)); controller.enqueue(bytes.slice(10)); controller.close(); } })));
    expect((await authorizer.authorize(source, signal)).identity).toBe(member.participantId);
    fetcher.mockResolvedValue(new Response(new Uint8Array(65_537)));
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("response-too-large");
    fetcher.mockResolvedValue(new Response(null));
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("invalid-response");
    fetcher.mockResolvedValue(new Response("not-json"));
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("invalid-response");
  });

  it("rejects changed membership after receiving the token", async () => {
    const { source, authorizer, fetcher, setMember, signal } = fixture();
    fetcher.mockImplementation(async () => { setMember({ ...member, createdAtMs: 95_000 }); return response(); });
    await expect(authorizer.authorize(source, signal)).rejects.toThrow("membership-changed");
  });

  it("redacts upstream errors from both credential and HTTP requests", async () => {
    const { source, authorizer, getOpenIdToken, fetcher, signal } = fixture();
    getOpenIdToken.mockRejectedValueOnce(new Error("private credential"));
    await expect(authorizer.authorize(source, signal)).rejects.toThrow(new FocusAuthorizationError("http-error"));
    fetcher.mockRejectedValueOnce(new Error("private HTTP body"));
    await expect(authorizer.authorize(source, signal)).rejects.toThrow(new FocusAuthorizationError("http-error"));
  });

  it("cancels a pending SDK credential request without sending it to the focus", async () => {
    const { source, authorizer, getOpenIdToken, fetcher } = fixture();
    let finish!: (value: typeof openId) => void;
    getOpenIdToken.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = authorizer.authorize(source, controller.signal);
    await vi.waitFor(() => expect(getOpenIdToken).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    finish(openId);
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(authorizer.authorize(source, controller.signal)).rejects.toThrow("cancelled");
  });

  it("times out the credential step and cancels HTTP requests", async () => {
    const { source, options, getOpenIdToken, fetcher } = fixture();
    getOpenIdToken.mockImplementation(() => new Promise(() => {}));
    const timed = new OpenIdFocusAuthorizer({ ...options, timeoutMs: 10 });
    await expect(timed.authorize(source, new AbortController().signal)).rejects.toThrow();
    getOpenIdToken.mockResolvedValue(openId);
    const controller = new AbortController();
    fetcher.mockImplementation(async () => { controller.abort(new Error("cancelled HTTP")); return response(); });
    await expect(new OpenIdFocusAuthorizer(options).authorize(source, controller.signal)).rejects.toThrow("cancelled HTTP");
  });

  it("cancels a stalled response stream and releases its reader", async () => {
    const { source, options, fetcher } = fixture();
    const cancel = vi.fn();
    let reading!: () => void;
    const entered = new Promise<void>((resolve) => { reading = resolve; });
    fetcher.mockResolvedValue(new Response(new ReadableStream({ pull: reading, cancel }, { highWaterMark: 0 })));
    const authorizer = new OpenIdFocusAuthorizer(options);
    const controller = new AbortController();
    const pending = authorizer.authorize(source, controller.signal);
    await entered;
    controller.abort(new Error("cancelled stream"));
    await expect(pending).rejects.toThrow("cancelled stream");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
