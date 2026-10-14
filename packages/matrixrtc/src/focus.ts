import type { MatrixClient } from "matrix-js-sdk";
import { z } from "zod";
import type { RtcMembership } from "./verified-keys.js";

export class FocusAuthorizationError extends Error {
  constructor(readonly code: "invalid-config" | "untrusted-focus" | "untrusted-sfu" | "unsupported-call" | "membership-changed" | "http-error" | "invalid-response" | "response-too-large" | "identity-mismatch") {
    super(code);
    this.name = "FocusAuthorizationError";
  }
}

export type FocusAuthorizationSource = Readonly<{
  roomId: string;
  slotId: string;
  focus: () => unknown;
  membership: () => RtcMembership | undefined;
  client: Pick<MatrixClient, "getUserId" | "getDeviceId" | "getOpenIdToken">;
}>;

export type FocusGrant = Readonly<{ url: string; jwt: string; identity: string; expiresAtMs: number }>;

export interface FocusAuthorizationPort {
  authorize(source: FocusAuthorizationSource, signal: AbortSignal): Promise<FocusGrant>;
}

export type OpenIdFocusOptions = Readonly<{
  focusUrls: readonly string[];
  sfuUrls: readonly string[];
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
}>;

const focusSchema = z.object({ type: z.literal("livekit"), livekit_service_url: z.string(), livekit_alias: z.string().optional() });
const openIdSchema = z.object({ access_token: z.string().min(1).max(16_384), token_type: z.literal("Bearer"), matrix_server_name: z.string(), expires_in: z.number().int().positive().max(86_400) });
const responseSchema = z.object({ url: z.string().max(4096), jwt: z.string().max(32_768).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/) });
const claimsSchema = z.object({
  sub: z.string(),
  exp: z.number().int().nonnegative().max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
  nbf: z.number().int().nonnegative().optional(),
  video: z.object({ room: z.string(), roomJoin: z.literal(true), canPublish: z.literal(true), canSubscribe: z.literal(true),
    roomAdmin: z.literal(false).optional(), roomCreate: z.literal(false).optional(), roomList: z.literal(false).optional(), ingressAdmin: z.literal(false).optional() }),
});

function endpoint(value: string, media: boolean, insecure: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new FocusAuthorizationError("invalid-config"); }
  const protocol = media ? "wss:" : "https:";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || value.length > 4096 ||
      (url.protocol !== protocol && !(insecure && local && url.protocol === (media ? "ws:" : "http:")))) {
    throw new FocusAuthorizationError("invalid-config");
  }
  return url.href.replace(/\/$/, "");
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new FocusAuthorizationError("invalid-response"); }
}

function decodeClaims(jwt: string): unknown {
  try {
    const segment = jwt.split(".")[1]!;
    const bytes = Uint8Array.from(atob(segment.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
    return parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new FocusAuthorizationError("invalid-response"); }
}

async function readResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new FocusAuthorizationError("invalid-response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await cancellable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65_536) throw new FocusAuthorizationError("response-too-large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export class OpenIdFocusAuthorizer implements FocusAuthorizationPort {
  readonly #focuses: ReadonlySet<string>;
  readonly #sfus: ReadonlySet<string>;
  readonly #insecure: boolean;
  readonly #timeout: number;
  readonly #now: () => number;
  readonly #fetch: typeof globalThis.fetch;

  constructor({ focusUrls, sfuUrls, allowInsecureLoopback = false, timeoutMs = 30_000, now = Date.now, fetch: fetcher = globalThis.fetch.bind(globalThis) }: OpenIdFocusOptions) {
    if (focusUrls.length < 1 || focusUrls.length > 32 || sfuUrls.length < 1 || sfuUrls.length > 32 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new FocusAuthorizationError("invalid-config");
    }
    this.#focuses = new Set(focusUrls.map((url) => endpoint(url, false, allowInsecureLoopback)));
    this.#sfus = new Set(sfuUrls.map((url) => endpoint(url, true, allowInsecureLoopback)));
    this.#insecure = allowInsecureLoopback;
    this.#timeout = timeoutMs;
    this.#now = now;
    this.#fetch = fetcher;
  }

  async authorize(source: FocusAuthorizationSource, signal: AbortSignal): Promise<FocusGrant> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.#timeout)]);
    bounded.throwIfAborted();
    const member = source.membership();
    if (!member) throw new FocusAuthorizationError("membership-changed");
    if (source.slotId !== "m.call#ROOM" || member.userId !== source.client.getUserId() || member.deviceId !== source.client.getDeviceId() ||
        member.participantId !== `${member.userId}:${member.deviceId}`) throw new FocusAuthorizationError("unsupported-call");
    const advertised = source.focus();
    if (advertised === undefined) throw new FocusAuthorizationError("membership-changed");
    const focus = focusSchema.safeParse(advertised);
    if (!focus.success || (focus.data.livekit_alias !== undefined && focus.data.livekit_alias !== source.roomId)) throw new FocusAuthorizationError("unsupported-call");
    const focusUrl = endpoint(focus.data.livekit_service_url, false, this.#insecure);
    if (!this.#focuses.has(focusUrl)) throw new FocusAuthorizationError("untrusted-focus");
    const snapshot = JSON.stringify(member);
    const current = () => {
      const now = this.#now();
      return Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(member.createdAtMs) && member.createdAtMs >= 0 && member.createdAtMs <= now &&
        (member.expiresAtMs === undefined || (Number.isSafeInteger(member.expiresAtMs) && member.expiresAtMs > now)) && JSON.stringify(source.membership()) === snapshot;
    };
    if (!current()) throw new FocusAuthorizationError("membership-changed");
    try {
      const digest = await cancellable(crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([source.roomId, source.slotId]))), bounded);
      const roomAlias = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/=+$/, "");
      const token = openIdSchema.safeParse(await cancellable(source.client.getOpenIdToken(), bounded));
      if (!token.success || token.data.matrix_server_name !== member.userId.slice(member.userId.indexOf(":") + 1)) throw new FocusAuthorizationError("invalid-response");
      bounded.throwIfAborted();
      if (!current()) throw new FocusAuthorizationError("membership-changed");
      const response = await this.#fetch(`${focusUrl}/sfu/get`, {
        method: "POST", redirect: "error", signal: bounded, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: source.roomId, device_id: member.deviceId, openid_token: token.data }),
      });
      if (response.status !== 200) throw new FocusAuthorizationError("http-error");
      const result = responseSchema.safeParse(parseJson(await readResponse(response, bounded)));
      if (!result.success) throw new FocusAuthorizationError("invalid-response");
      const url = endpoint(result.data.url, true, this.#insecure);
      if (!this.#sfus.has(url)) throw new FocusAuthorizationError("untrusted-sfu");
      const claims = claimsSchema.safeParse(decodeClaims(result.data.jwt));
      const now = this.#now();
      if (!claims.success || claims.data.exp * 1000 <= now || claims.data.exp * 1000 - now > 86_400_000 || (claims.data.nbf !== undefined && claims.data.nbf * 1000 > now + 5000)) {
        throw new FocusAuthorizationError("invalid-response");
      }
      if (claims.data.sub !== member.participantId || claims.data.video.room !== roomAlias) throw new FocusAuthorizationError("identity-mismatch");
      bounded.throwIfAborted();
      if (!current()) throw new FocusAuthorizationError("membership-changed");
      return Object.freeze({ url, jwt: result.data.jwt, identity: member.participantId, expiresAtMs: claims.data.exp * 1000 });
    } catch (error) {
      bounded.throwIfAborted();
      if (error instanceof FocusAuthorizationError) throw error;
      throw new FocusAuthorizationError("http-error");
    }
  }
}
