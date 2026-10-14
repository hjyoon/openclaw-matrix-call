# Worker image candidates

The plugin archive does not contain its browser or local speech services. `pnpm release:images` builds both Linux x86-64 images from a clean checkout, adds source/version labels, verifies their architecture, non-root user and command, and saves them into one compressed Docker archive. It publishes nothing to a container registry. Calling release readiness remains separate.

Use the pinned Node/pnpm versions on a Linux x86-64 Docker host:

```sh
pnpm install --frozen-lockfile
pnpm release:images
```

Files are written to the ignored `.cache/release-images/` directory:

- `matrix-call-images-0.1.0-alpha.1-linux-amd64.tar.gz` contains both images.
- `SHA256SUMS` binds the compressed archive bytes.
- `release-report.json` records the clean source commit, version, platform and immutable Docker image IDs.

The packer checks the archive's actual manifest and hashes both embedded configuration objects against the inspected image IDs. These are Docker configuration IDs, not registry manifest digests. Model weights, operator configuration, Matrix credentials, HMAC keys and runtime profiles stay outside these recipes and the archive.

`--preview` permits local verification of an uncommitted checkout. A dirty preview records `sourceDirty: true` and uses a revision label ending in `-dirty`. Preview output must never become a release asset. The ordinary command refuses an uncommitted source tree.

## CI and loading

The speech CI job builds these images before exercising speech and encrypted Matrix calls, verifies and reloads the exact archive, and runs the [released application against the restored browser image](released-client-integration.md#browser-image). It uploads `inspected-worker-image-candidate` only after every check passes. The plugin candidate is a separate artifact. Compare both reports' version and source commit before preparing a release. CI artifacts support review; they do not establish a public registry package, an approved calling release or a supported operator deployment.

On the intended Linux x86-64 Docker host, put the reviewed archive, checksum and report in one directory and run:

```sh
sha256sum --check SHA256SUMS
docker image load --input matrix-call-images-0.1.0-alpha.1-linux-amd64.tar.gz
docker image inspect matrix-call-browser-worker:0.1.0-alpha.1 matrix-call-speech-worker:0.1.0-alpha.1
```

Compare image IDs and source/version labels with the report before starting services. Use the [operator setup](operator-setup.md) and existing Compose files with `up --no-build -d`; provide all private inputs and the independently verified speech model. Never build silently when an intended release image is missing.

An actual publication must expose the archive and report with the matching plugin version and source commit, or supply independently verified registry digests. No public image registry push or GitHub release is performed by this build path. The repository's source recipes remain available for operators who prefer their own image builds.
