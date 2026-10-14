# Marketplace distribution checks

Checked: 2026-10-15. Package validation and archive generation pass. Publication remains gated by [release readiness](release-readiness.md); these checks do not publish or upload a package.

## Reproducible candidate

Use the repository's Node/pnpm versions, install the locked development dependencies, and run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify:marketplace
```

The exact development dependency `clawhub@0.23.3` runs Plugin Inspector against OpenClaw 2026.10.2, including isolated runtime capture. The check requires a passing result with zero issues, breakages and warnings. It then runs `package publish --dry-run`, verifies package name/version and exact checkout commit, and packs the actual package. This path needs no publisher token and performs no upload.

The [official publishing requirements](https://docs.openclaw.ai/clawhub/publishing) require manifest compatibility/build metadata, source provenance, validation and a publication preview. The plugin already includes `openclaw.plugin.json`, exact SDK compatibility and build metadata. Public availability after real publication depends on the registry's automated checks; a local inspector pass does not establish registry approval.

Generated candidate files live under the ignored `.cache/release/` directory:

- `hjyoon-openclaw-matrix-call-0.1.0-alpha.1.tgz`.
- `SHA256SUMS` for the exact packed bytes.
- `release-report.json` with source commit, artifact hash, inventory and validation summary.
- Local inspector diagnostics under `inspection/`, excluded from candidate uploads.

The packed inventory is restricted to seven files: package/manifest metadata, entry bundle and source map, README, MIT license and third-party notices. Worker credentials, profiles, models, transcripts, test reports and development dependencies are absent. The portable core and worker do not acquire a ClawHub runtime dependency.

## Publication boundary

Candidate reports record `published: false`, `uploaded: false` and `readinessAssessment: "manual"`. These fields describe the local build/inspection operation, not a subsequent public release. The tools do not automatically certify calling readiness. [Worker image candidates](worker-image-distribution.md) are separate compressed Docker archives with their own source/version labels, manifest checks, immutable image IDs and checksum/report. CI produces both artifacts without a registry publication; compare their source commits and versions before release. Review the declared client/protocol/deployment scope and its actual integration results, preserve known stability limits, and require the final source's CI to pass before publishing an experimental alpha.

After those gates pass, a publisher with access to the `hjyoon` namespace can perform a manual authenticated first publication. Initial publication establishes the package before trusted GitHub publishing can be configured. Future registry publication should require its terminal public result, not treat a staged upload as success. No registry login, token creation or real publication is performed by CI or these development checks.

## Public-name installation check

After the exact version is public, run `pnpm verify:registry-install`. It uses `clawhub:@hjyoon/openclaw-matrix-call@0.1.0-alpha.1` in a fresh disposable supported profile, checks loaded package name/version and the recorded `clawhub` origin, and runs the same installed agent-service/worker-control checks as archive installation. It does not fall back to the local archive or another version. Failed registry security or install policy is terminal; this check does not bypass it. The default `pnpm check` continues to use local archives without registry availability or publisher credentials.

Verify public registry file hashes/source metadata against the inspected candidate as a separate distribution check. Model profiles, Matrix credentials and worker data are never part of the registry package. Worker image/checksum/report assets remain paired GitHub downloads rather than a plugin dependency fetched at runtime.
