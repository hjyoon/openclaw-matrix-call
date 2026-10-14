import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".cache/release");
const packageDir = path.join(root, "packages/openclaw-plugin");
const metadata = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
const cli = path.join(root, "node_modules/.bin/clawhub");
await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true });
const validation = await exec(cli, ["package", "validate", packageDir, "--openclaw-version", "2026.10.2", "--runtime", "--allow-execute", "--out", path.join(directory, "inspection"), "--json"], { cwd: root, timeout: 120000, maxBuffer: 4_000_000 });
const inspected = JSON.parse(validation.stdout);
assert.equal(inspected.status, "pass"); assert.equal(inspected.summary.breakageCount, 0); assert.equal(inspected.summary.issueCount, 0); assert.equal(inspected.summary.warningCount, 0);
const preview = await exec(cli, ["package", "publish", packageDir, "--dry-run", "--owner", "hjyoon", "--tags", "alpha", "--source-repo", "hjyoon/openclaw-matrix-call", "--source-path", "packages/openclaw-plugin", "--json"], { cwd: root, timeout: 120000 });
const publication = JSON.parse(preview.stdout); assert.equal(publication.name, metadata.name); assert.equal(publication.version, metadata.version);
const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(); assert.equal(publication.commit, commit);
await exec("pnpm", ["--dir", packageDir, "pack", "--pack-destination", directory], { cwd: root, timeout: 30000 });
const archive = (await readdir(directory)).find((file) => file.endsWith(".tgz")); assert(archive);
const contents = (await exec("tar", ["--list", "--gzip", "--file", path.join(directory, archive)])).stdout.trim().split("\n").sort();
assert.deepEqual(contents, ["package/LICENSE", "package/README.md", "package/THIRD_PARTY_NOTICES.md", "package/dist/index.js", "package/dist/index.js.map", "package/openclaw.plugin.json", "package/package.json"]);
const packedMetadata = JSON.parse((await exec("tar", ["--extract", "--to-stdout", "--gzip", "--file", path.join(directory, archive), "package/package.json"])).stdout);
assert.equal(packedMetadata.version, metadata.version); assert.equal(packedMetadata.name, metadata.name);
assert.equal(packedMetadata.openclaw.compat.pluginApi, "=2026.10.2"); assert.equal(packedMetadata.peerDependencies.openclaw, "2026.10.2");
const sha256 = createHash("sha256").update(await readFile(path.join(directory, archive))).digest("hex");
await writeFile(path.join(directory, "SHA256SUMS"), `${sha256}  ${archive}\n`);
const report = { package: metadata.name, version: metadata.version, sourceCommit: commit, archive, sha256, files: contents,
  inspector: "clawhub@0.23.3", targetOpenClaw: "2026.10.2", validation: inspected.status, summary: inspected.summary,
  dryRun: true, uploaded: false, published: false, readinessAssessment: "manual" };
await writeFile(path.join(directory, "release-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ event: "marketplace-package-verified", ...report }));
