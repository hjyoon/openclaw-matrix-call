import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { matrixRoomIdSchema } from "@matrix-call/core";
import type { BrowserPolicy, MatrixCredentials } from "./types.js";

const mxid = z.string().max(255).regex(/^@[^:\s]+:[^\s]+$/);
const deviceId = z.string().min(1).max(255).regex(/^\S+$/);
const key = z.string().regex(/^[A-Za-z0-9+/]{43}$/);
const endpoints = z.array(z.string().url().max(4096)).min(1).max(32);
const absolutePath = z.string().refine(isAbsolute);

const credentialsSchema = z.object({
  baseUrl: z.string().url().max(4096),
  userId: mxid,
  deviceId,
  accessToken: z.string().min(1).max(16_384).regex(/^\S+$/),
}).strict();

const configSchema = z.object({
  credentialsFile: absolutePath,
  profileDir: absolutePath,
  assetDir: absolutePath,
  assetPort: z.number().int().min(1024).max(65_535).default(19791),
  owners: z.array(mxid).min(1).max(256),
  rooms: z.array(matrixRoomIdSchema).min(1).max(256),
  focusUrls: endpoints,
  sfuUrls: endpoints,
  devices: z.array(z.object({ userId: mxid, deviceId, ed25519: key, curve25519: key }).strict()).min(1).max(256),
  allowInsecureLoopback: z.boolean().default(false),
}).strict();

function endpoint(value: string, protocols: readonly string[], allowLoopback: boolean): string {
  const url = new URL(value);
  const secure = protocols.includes(url.protocol);
  const local = allowLoopback && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.protocol === (protocols.includes("https:") ? "http:" : "ws:");
  if ((!secure && !local) || url.username || url.password || url.search || url.hash) throw new Error("Invalid browser worker endpoint");
  return url.toString().replace(/\/$/, "");
}

export function parseBrowserConfig(value: unknown, credentials: unknown) {
  const config = configSchema.parse(value);
  const identity = credentialsSchema.parse(credentials);
  const owners = [...new Set(config.owners)];
  const rooms = [...new Set(config.rooms)];
  const devices = config.devices;
  if (devices.some((pin) => !owners.includes(pin.userId)) ||
      new Set(devices.map((pin) => JSON.stringify([pin.userId, pin.deviceId]))).size !== devices.length) {
    throw new Error("Invalid browser worker device pins");
  }
  const policy: BrowserPolicy = Object.freeze({
    owners: Object.freeze(owners), rooms: Object.freeze(rooms),
    focusUrls: Object.freeze(config.focusUrls.map((url) => endpoint(url, ["https:"], config.allowInsecureLoopback))),
    sfuUrls: Object.freeze(config.sfuUrls.map((url) => endpoint(url, ["wss:"], config.allowInsecureLoopback))),
    devices: Object.freeze(devices.map((pin) => Object.freeze(pin))),
    allowInsecureLoopback: config.allowInsecureLoopback,
  });
  const matrix: MatrixCredentials = Object.freeze({ ...identity, baseUrl: endpoint(identity.baseUrl, ["https:"], config.allowInsecureLoopback) });
  return Object.freeze({
    credentialsFile: config.credentialsFile, profileDir: config.profileDir,
    assetDir: config.assetDir, assetPort: config.assetPort, credentials: matrix, policy,
  });
}

export async function readBrowserConfig(file: string) {
  if (!isAbsolute(file)) throw new Error("Browser worker config path must be absolute");
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    const config = configSchema.parse(value);
    const credentials: unknown = JSON.parse(await readFile(config.credentialsFile, "utf8"));
    return parseBrowserConfig(value, credentials);
  } catch {
    throw new Error("Invalid browser worker configuration or credential file");
  }
}
