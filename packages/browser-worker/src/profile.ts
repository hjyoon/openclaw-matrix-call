import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MatrixCredentials, DeviceKeys } from "./types.js";

const keysSchema = z.object({ ed25519: z.string().regex(/^[A-Za-z0-9+/]{43}$/), curve25519: z.string().regex(/^[A-Za-z0-9+/]{43}$/) }).strict();
const manifestSchema = z.object({ version: z.literal(1), baseUrl: z.string(), userId: z.string(), deviceId: z.string(), origin: z.string(), keys: keysSchema }).strict();

export async function openDeviceProfile(directory: string, credentials: MatrixCredentials, origin: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error("Matrix profile must be a private directory owned by the worker");
  const file = path.join(directory, "matrix-call-device.json");
  let expectedKeys: DeviceKeys | undefined;
  try {
    const manifest = manifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (manifest.baseUrl !== credentials.baseUrl || manifest.userId !== credentials.userId ||
        manifest.deviceId !== credentials.deviceId || manifest.origin !== origin) throw new Error("Matrix profile identity changed");
    expectedKeys = Object.freeze(manifest.keys);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Matrix profile binding is invalid or belongs to another identity");
  }
  return Object.freeze({
    expectedKeys,
    async persist(value: DeviceKeys): Promise<void> {
      const keys = keysSchema.parse(value);
      if (expectedKeys) {
        if (keys.ed25519 !== expectedKeys.ed25519 || keys.curve25519 !== expectedKeys.curve25519) throw new Error("Matrix profile keys changed");
        return;
      }
      await writeFile(file, JSON.stringify({ version: 1, baseUrl: credentials.baseUrl, userId: credentials.userId, deviceId: credentials.deviceId, origin, keys }), { mode: 0o600, flag: "wx" });
      expectedKeys = Object.freeze(keys);
    },
  });
}
