import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
assert(process.argv.slice(2).every((argument) => argument === "--preview"));
assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
const preview = process.argv.includes("--preview");
const metadata = JSON.parse(await readFile(path.join(root, "packages/openclaw-plugin/package.json"), "utf8"));
assert.match(metadata.version, /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/);
const sourceCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(); assert.match(sourceCommit, /^[a-f0-9]{40}$/);
const sourceDirty = Boolean((await exec("git", ["status", "--porcelain=v1"], { cwd: root })).stdout.trim());
assert(preview || !sourceDirty, "Distribution archives require a clean checkout; --preview is for local checks only");
const revision = sourceCommit + (sourceDirty ? "-dirty" : "");
const directory = path.join(root, ".cache/release-images"); await mkdir(directory, { recursive: true, mode: 0o700 });
await rm(path.join(directory, "SHA256SUMS"), { force: true }); await rm(path.join(directory, "release-report.json"), { force: true });
const images = [];
for (const role of ["browser", "speech"]) {
  const tag = `matrix-call-${role}-worker:${metadata.version}`;
  await exec("docker", ["build", "--platform", "linux/amd64", "--file", `deployment/${role}-worker.Dockerfile`, "--tag", tag,
    "--label", "org.opencontainers.image.source=https://github.com/hjyoon/openclaw-matrix-call",
    "--label", `org.opencontainers.image.revision=${revision}`, "--label", `org.opencontainers.image.version=${metadata.version}`, "."],
  { cwd: root, timeout: 1200000, maxBuffer: 4_000_000 });
  const [image] = JSON.parse((await exec("docker", ["image", "inspect", tag], { cwd: root })).stdout);
  assert.equal(image.Os, "linux"); assert.equal(image.Architecture, "amd64"); assert.equal(image.Config.User, "node");
  assert.deepEqual(image.Config.Cmd, ["node", "/app/worker.mjs"]);
  assert.equal(image.Config.Labels["org.opencontainers.image.revision"], revision);
  assert.equal(image.Config.Labels["org.opencontainers.image.version"], metadata.version);
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  images.push({ role, tag, imageId: image.Id, size: image.Size });
}
const archive = `matrix-call-images-${metadata.version}-linux-amd64.tar.gz`;
const unpacked = path.join(directory, "images.tar"); const filename = path.join(directory, archive);
try {
  await exec("docker", ["image", "save", "--output", unpacked, ...images.map((image) => image.tag)], { cwd: root, timeout: 180000 });
  await pipeline(createReadStream(unpacked), createGzip({ level: 6 }), createWriteStream(filename, { mode: 0o600 }));
} finally { await rm(unpacked, { force: true }); }
const manifest = JSON.parse((await exec("tar", ["--extract", "--to-stdout", "--gzip", "--file", filename, "manifest.json"], { maxBuffer: 1_048_576 })).stdout);
assert.equal(manifest.length, images.length);
for (const image of images) {
  const entries = manifest.filter((entry) => entry.RepoTags?.includes(image.tag)); assert.equal(entries.length, 1);
  const config = entries[0].Config; assert.match(config, /^(?:blobs\/sha256\/)?[a-f0-9]{64}(?:\.json)?$/);
  const bytes = (await exec("tar", ["--extract", "--to-stdout", "--gzip", "--file", filename, config], { encoding: "buffer", maxBuffer: 1_048_576 })).stdout;
  assert.equal("sha256:" + createHash("sha256").update(bytes).digest("hex"), image.imageId);
}
const hash = createHash("sha256"); for await (const chunk of createReadStream(filename)) hash.update(chunk);
const sha256 = hash.digest("hex");
if (!preview) {
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), sourceCommit, "Source commit changed during the build");
  assert.equal((await exec("git", ["status", "--porcelain=v1"], { cwd: root })).stdout.trim(), "", "Source tree changed during the build");
}
const report = { version: metadata.version, sourceCommit, sourceDirty, preview, platform: "linux/amd64", archive, sha256,
  bytes: (await stat(filename)).size, images, uploaded: false, published: false, callingReleaseReady: false };
await writeFile(path.join(directory, "SHA256SUMS"), `${sha256}  ${archive}\n`);
await writeFile(path.join(directory, "release-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ event: "release-images-built", ...report }));
