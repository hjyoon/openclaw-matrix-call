import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDeviceProfile } from "../../packages/browser-worker/src/profile.js";
import { credentials } from "../fixtures/browser.js";

const origin = "http://127.0.0.1:19791";
const keys = { ed25519: "A".repeat(43), curve25519: "B".repeat(43) };

describe("persistent Matrix device binding", () => {
  it("creates private state and restores the same origin and public keys without credentials", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "matrix-call-profile-"));
    try {
      const profile = await openDeviceProfile(dir, credentials, origin);
      expect(profile.expectedKeys).toBeUndefined();
      await profile.persist(keys); await profile.persist(keys);
      const manifest = path.join(dir, "matrix-call-device.json");
      const text = await readFile(manifest, "utf8");
      expect(text).not.toContain(credentials.accessToken);
      expect((await lstat(manifest)).mode & 0o077).toBe(0);
      const restored = await openDeviceProfile(dir, credentials, origin);
      expect(restored.expectedKeys).toEqual(keys);
      await restored.persist(keys);
      await expect(restored.persist({ ...keys, ed25519: "C".repeat(43) })).rejects.toThrow("keys changed");
      await expect(restored.persist({ ...keys, curve25519: "C".repeat(43) })).rejects.toThrow("keys changed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(["baseUrl", "userId", "deviceId", "origin", "corrupt"])("rejects changed profile bindings: %s", async (change) => {
    const dir = await mkdtemp(path.join(tmpdir(), "matrix-call-profile-"));
    try {
      await (await openDeviceProfile(dir, credentials, origin)).persist(keys);
      if (change === "corrupt") await writeFile(path.join(dir, "matrix-call-device.json"), "invalid private content");
      const identity = change === "origin" || change === "corrupt" ? credentials : { ...credentials, [change]: "changed" };
      await expect(openDeviceProfile(dir, identity, change === "origin" ? "http://127.0.0.1:19792" : origin)).rejects.toThrow("binding is invalid");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects shared directories, symlinks, and another owner", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "matrix-call-profile-"));
    const link = `${dir}-link`;
    try {
      await chmod(dir, 0o755);
      await expect(openDeviceProfile(dir, credentials, origin)).rejects.toThrow("private directory");
      await chmod(dir, 0o700);
      await symlink(dir, link);
      await expect(openDeviceProfile(link, credentials, origin)).rejects.toThrow("private directory");
      const uid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
      try { await expect(openDeviceProfile(dir, credentials, origin)).rejects.toThrow("private directory"); }
      finally { uid.mockRestore(); }
    } finally { await rm(link, { force: true }); await rm(dir, { recursive: true, force: true }); }
  });
});
