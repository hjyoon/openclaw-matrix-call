import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import path from "node:path";
import { readSecretFileSync } from "openclaw/plugin-sdk/secret-file";

export function readLiveModel(filename) {
  try {
    assert(path.isAbsolute(filename));
    const file = lstatSync(filename); const directory = lstatSync(path.dirname(filename));
    assert(file.isFile() && directory.isDirectory());
    assert.equal(file.mode & 0o077, 0); assert.equal(directory.mode & 0o077, 0);
    assert.equal(file.uid, process.getuid()); assert.equal(directory.uid, process.getuid());
    const value = JSON.parse(readSecretFileSync(filename, "Private live-model settings", { maxBytes: 65_536, rejectSymlink: true }));
    assert.deepEqual(Object.keys(value).sort(), ["credential", "model", "schemaVersion", "settings", "thinking"]);
    assert.equal(value.schemaVersion, 1);
    assert.match(value.model, /^[a-z0-9-]+\/[a-zA-Z0-9._-]+$/);
    assert(["off", "minimal", "low", "medium", "high", "xhigh"].includes(value.thinking));
    assert(value.settings && typeof value.settings === "object" && !Array.isArray(value.settings));
    const credential = value.credential;
    assert(Object.keys(credential).every((key) => ["type", "provider", "access", "refresh", "expires", "accountId", "chatgptPlanType"].includes(key)));
    assert.equal(credential.type, "oauth"); assert.equal(credential.provider, value.model.split("/")[0]);
    assert.equal(typeof credential.access, "string"); assert(credential.access.length > 0);
    assert.equal(credential.refresh, "");
    assert(Number.isSafeInteger(credential.expires) && credential.expires > Date.now() + 600_000);
    for (const field of ["accountId", "chatgptPlanType"]) assert(credential[field] === undefined || typeof credential[field] === "string");
    return Object.freeze({ ...value, profileId: `${credential.provider}:matrix-call-test` });
  } catch { throw new Error("Private live-model configuration is invalid or expired"); }
}
