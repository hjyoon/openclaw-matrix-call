# ADR 0019: Offline worker image candidates

## Status

Accepted.

## Date

2026-10-14.

## Context

The native plugin package cannot carry the independent browser and speech services. Source recipes are available, but compiling speech engines and installing a browser on every target host complicates distribution. A public release needs an identifiable worker build matching its plugin source and version without requiring a particular model provider or image registry account.

## Decision

Build Linux x86-64 browser/speech image candidates from a clean checkout, label their source/version and export them together as a compressed Docker archive. Check the architecture, non-root command, archive manifest, embedded configuration hashes and compressed checksum. Record immutable Docker configuration IDs in a separate report. CI tests these same tagged candidates before uploading its review artifact.

Keep credentials, profiles, model weights and operator configuration outside the images. Preview builds may inspect uncommitted changes but must carry explicit preview/dirty metadata and cannot become release assets. A release must distribute corresponding plugin and worker assets with matching version/source reports. This path does not publish a registry image or establish assistant readiness.

## Alternatives considered

Requiring every operator to build remains possible through the existing source recipes. Requiring a single hosted image registry would make that account/service part of installation availability. Including worker runtime state inside the plugin archive would violate process and credential boundaries. Registry digests may complement offline assets later when independently verified publication is implemented.

## Consequences

Docker loading can avoid target-host compilation. Images and the verified speech model still need separate configuration and enrollment. Archive and plugin checks remain distinct from clean operator setup, calling interoperability and coordinated replacement. Existing portable ports and runtime alternatives remain independent of this optional Docker distribution.
