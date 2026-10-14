# Public alpha 0.1.0-alpha.1

Published: 2026-10-15 Asia/Seoul. The first experimental calling alpha is public on ClawHub and as a [GitHub prerelease](https://github.com/hjyoon/openclaw-matrix-call/releases/tag/v0.1.0-alpha.1). This record describes the released source and bytes; later documentation/checker commits do not change that release.

## Install and scope

Use OpenClaw 2026.10.2 and a supported Node version. The exact versioned registry command is:

```sh
openclaw plugins install clawhub:@hjyoon/openclaw-matrix-call@0.1.0-alpha.1 --accept-capabilities
```

Only the `alpha` registry tag is set; no `latest` or stable claim is made. Follow [operator setup](operator-setup.md) to configure private credentials, trusted devices and both workers. Installing the plugin alone does not provision calls. The supported initial route is a native Gateway on the same Linux x86-64 Docker host, using separate browser/speech containers with the explicitly selected host-network overlay.

The tested released client is Element Call 0.28.0 standalone compatibility with per-participant E2EE and one trusted LiveKit 1.13.9/authorization-service 0.8.0 backend. Interfaces target Matrix protocols and replaceable agent/speech/persistence ports. Other clients, backend modes, network routes and platforms require their own evidence. Calls remain owner-authorized, bounded, half-duplex and tool-free. See [scope and known limitations](release-readiness.md).

## Provenance and public files

The plugin and worker images share source commit `6d770a21c273035ffdb5650127633480a5f641d8` and version `0.1.0-alpha.1`. All five [release-source CI jobs](https://github.com/hjyoon/openclaw-matrix-call/actions/runs/38606181593) passed.

| Artifact | SHA-256 |
| --- | --- |
| `hjyoon-openclaw-matrix-call-0.1.0-alpha.1.tgz` | `6cd01c90da42815425a1d4409951d5c6917e449e862be83b3e68951397a77de9` |
| `matrix-call-images-0.1.0-alpha.1-linux-amd64.tar.gz` | `4abf611401d44e115a7a39bac4bb1e47ddc8ed3ccacfc8a06ebeebada2b0808a` |

GitHub assets include both archives, `SHA256SUMS`, `plugin-release-report.json` and `worker-images-release-report.json`. Every uploaded asset's reported byte length/digest matched the local inventory before publication. Download all five into one directory, check the archive checksums and compare both reports' source/version before loading images. Browser image ID is `sha256:ef7ae219c13b34529d2bdd4d75a34b24c79737e3bb6f8df32d2e48437ed3f888`; speech image ID is `sha256:b5d9ce41a85be1180386850fb0ede3897de686a2aa19c3ca121576ecb7108f59`. These are Docker configuration IDs, not registry manifest digests.

The exact CI plugin archive was selected for distribution. Local and CI archives initially differed only in development-dependency key order in packed `package.json`; parsed metadata and all other file bytes were identical. Neither difference affected runtime code. Public registry artifact/file hashes match the selected CI archive, including all seven package files. Worker weights, credentials, profiles and captured media are absent.

ClawHub release ID is `rd7fgqgv4mcy7ch6f4191eqe6h8g9dta`; publish attempt is `zx70ht9bx38rcxhxtqx1j6vsb98g91q7`. The CLI's definitive status was `published`. The selected version reports clean static/content scans with a benign content verdict and source-linked verification. This was a manual community publication under `hjyoon`, not an official package or trusted-publisher attestation. The first package-summary response still said `pending`; the version-specific scans were clean and public installation succeeded. Do not substitute a cached package-summary field for exact-version publication/security evidence.

Candidate reports describe build/inspection operations, so their `published: false` values remain unchanged. They do not report later registry/GitHub publication state.

## Validation and corrections

The release source passes 1,149 tests with 100% statement, branch, function and line coverage per non-empty runtime file. Pinned package inspection reports zero issues/warnings. [Operator evidence](operator-compose-integration.md) covers empty-profile setup, encrypted chat/audio, actual Korean/English model replies, complete longer image output, fresh service audiences, preserved device keys and independent histories after explicit replacement. The final loaded image archive also passes the account-free operator integration and clean shutdown.

After publication, `pnpm verify:registry-install` downloaded the exact version in an anonymous disposable profile, verified package name/version and the ClawHub install origin, loaded the plugin, and passed installed SDK agent-service/worker-control checks. These include bound history, tool-free dispatch, idempotency, caller rejection, cancellation/failure, restart/reload audiences, strict administrator controls and owned-session cleanup. This install check uses deterministic model/media fixtures; real encrypted speech is covered separately by the operator evidence and matching public runtime file hashes.

The initial registry checker incorrectly expected install records inside `openclaw.json`. Installation/loading had succeeded, but the checker stopped before service checks. It now uses public `openclaw plugins inspect matrix-call --json` and completes the entire check. The correction is outside packaged runtime source and does not require republishing this version.

No production service deployment or production Matrix messaging was performed. Private access-only inference snapshots and disposable test profiles were removed. Known intermittent input/enrollment/output faults remain documented; passing scoped runs does not establish sustained-call reliability or arbitrary microphone/speech quality.
