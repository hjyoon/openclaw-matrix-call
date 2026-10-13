import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const uuid = z.uuid();
const requestSchema = z.strictObject({
  method: z.string().regex(/^[A-Z_0-9]+$/).max(32),
  path: z.string().startsWith("/").max(2_048).regex(/^[^\r\n#]+$/),
  body: z.string().max(2_000_000),
});
const headerSchema = z.strictObject({
  time: z.string().regex(/^(0|[1-9][0-9]{0,15})$/),
  nonce: uuid,
  audience: uuid,
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});

export type HttpMessage = Readonly<{ method: string; path: string; body: string }>;
export type AuthHeaders = Readonly<Record<string, string | string[] | undefined>>;

export class AuthenticationError extends Error {
  constructor(readonly code: "invalid-auth" | "stale-request" | "replayed-request" | "auth-capacity") {
    super(code);
    this.name = "AuthenticationError";
  }
}

export class RequestAuthenticator {
  readonly #key: Buffer;
  readonly #audience: string;
  readonly #windowMs: number;
  readonly #maxNonces: number;
  readonly #now: () => number;
  readonly #seen = new Map<string, number>();

  constructor(options: {
    secret: string;
    audience: string;
    windowMs?: number;
    maxNonces?: number;
    now?: () => number;
  }) {
    const { secret, audience, windowMs = 30_000, maxNonces = 4_096, now = Date.now } = options;
    if (!/^[0-9a-f]{64}$/.test(secret) || !uuid.safeParse(audience).success) {
      throw new AuthenticationError("invalid-auth");
    }
    if (!Number.isInteger(windowMs) || windowMs < 1 || windowMs > 60_000) {
      throw new AuthenticationError("invalid-auth");
    }
    if (!Number.isInteger(maxNonces) || maxNonces < 1 || maxNonces > 65_536) {
      throw new AuthenticationError("invalid-auth");
    }
    this.#key = Buffer.from(secret, "hex");
    this.#audience = audience;
    this.#windowMs = windowMs;
    this.#maxNonces = maxNonces;
    this.#now = now;
  }

  sign(message: HttpMessage): Readonly<Record<string, string>> {
    const parsed = requestSchema.safeParse(message);
    const time = this.#now();
    if (!parsed.success || !Number.isSafeInteger(time) || time < 0) {
      throw new AuthenticationError("invalid-auth");
    }
    const nonce = randomUUID();
    const timestamp = String(time);
    return Object.freeze({
      "x-matrix-call-time": timestamp,
      "x-matrix-call-nonce": nonce,
      "x-matrix-call-audience": this.#audience,
      "x-matrix-call-signature": this.#signature(parsed.data, timestamp, nonce),
    });
  }

  verify(message: HttpMessage, headers: AuthHeaders): void {
    const parsed = requestSchema.safeParse(message);
    const auth = headerSchema.safeParse({
      time: headers["x-matrix-call-time"],
      nonce: headers["x-matrix-call-nonce"],
      audience: headers["x-matrix-call-audience"],
      signature: headers["x-matrix-call-signature"],
    });
    if (!parsed.success || !auth.success || auth.data.audience !== this.#audience) {
      throw new AuthenticationError("invalid-auth");
    }
    const now = this.#now();
    const timestamp = Number(auth.data.time);
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(timestamp) ||
      Math.abs(now - timestamp) > this.#windowMs) {
      throw new AuthenticationError("stale-request");
    }
    const expected = Buffer.from(this.#signature(parsed.data, auth.data.time, auth.data.nonce), "hex");
    if (!timingSafeEqual(expected, Buffer.from(auth.data.signature, "hex"))) {
      throw new AuthenticationError("invalid-auth");
    }
    for (const [nonce, expiry] of this.#seen) {
      if (expiry < now) this.#seen.delete(nonce);
    }
    if (this.#seen.has(auth.data.nonce)) throw new AuthenticationError("replayed-request");
    if (this.#seen.size >= this.#maxNonces) throw new AuthenticationError("auth-capacity");
    this.#seen.set(auth.data.nonce, timestamp + this.#windowMs);
  }

  #signature(message: HttpMessage, time: string, nonce: string): string {
    const hash = createHash("sha256").update(message.body, "utf8").digest("hex");
    return createHmac("sha256", this.#key).update(JSON.stringify([
      "matrix-call/1", this.#audience, message.method, message.path, time, nonce, hash,
    ])).digest("hex");
  }
}
