# Public release readiness

Updated: 2026-10-14. This repository is public source under development. It is not yet an installable calling release. The native package registers a channel descriptor, `/matrixcall` status command and optional signed agent service. Worker control and native call entry remain unfinished.

## First public alpha

The initial calling scope is an explicitly configured owner and room, encrypted MatrixRTC conference audio, bounded half-duplex speech, and delegated, tool-free OpenClaw inference. Speech and agent services remain replaceable. The local CPU speech implementation needs no hosted speech account.

Administrator tool execution and general-user approval require a supported host authorization path; see [ADR 0004](adr/0004-delegated-openclaw-ingress.md). Legacy Matrix VoIP, interruption and other unimplemented capabilities must remain explicitly unavailable. Future capabilities do not become supported merely because a package installs.

## Evidence and gaps

| Requirement | Current evidence | Work before a calling alpha |
| --- | --- | --- |
| Native package installation | Packed archive installs and runs its signed agent service in a disposable OpenClaw 2026.10.2 Gateway | Recheck the final calling package and complete operator setup from an empty environment |
| Gateway-to-worker integration | Gateway-owned signed agent service with real public SDK dispatch, bound history, idempotency, provider cancellation/failure, restart/reload audiences and active-turn shutdown | Connect worker control and finish native call entry |
| Model-backed voice response | Real installed SDK dispatch reaches a deterministic model-provider HTTP fixture; encrypted Matrix speech checks use a separate agent fixture | Connect an operator-configured real model to the spoken path and test reply, history, abort and failure |
| Real speech in encrypted calls | Korean/English turns pass real local engines through the production driver and restored browser image; leave cancels recognition | Broader input quality, sustained-call stability and target-server latency/resource measurements |
| Device and service setup | Strict external configuration, persistent private profiles, explicit fingerprint pins, optional local speech Compose | Provide a reproducible enrollment/setup flow with useful configuration diagnostics and preserved device state |
| Call entry | Signed room-specific media join/leave works in the isolated harness | Provide and test a documented user entry point; automatic incoming-call handling is unavailable |
| Released Matrix clients | SDK peers pass encrypted audio and restart/rejoin | Record supported application versions, protocol/encryption mode and complete spoken turns with at least one actual client; test compatible non-Element clients where available |
| Distribution | Development bundles, image recipes, pinned dependencies and third-party notices | Produce versioned plugin archives and worker images, inspect publication contents, validate the selected marketplace requirements, and publish install instructions |

Runtime coverage is 100% per non-empty source file. That checks exercised code paths; it does not replace client interoperability, native model dispatch or clean-host usability evidence. `/readyz` continues to report unavailable until assistant readiness has its own completed contract and checks.

## Next implementation order

1. Connect native worker control and a documented call entry point to the verified signed agent service.
2. Verify real model-backed spoken turns through that service and a released compatible Matrix client; investigate intermittent enrollment and later-input failures.
3. Add setup/enrollment diagnostics and validate the complete instructions from an empty operator environment.
4. Build and inspect release artifacts, finish marketplace validation and publish a version with its exact supported scope.

The [implementation status](implementation-status.md) records completed behavior. The [architecture requirements](architecture.md#release-requirements) and [Matrix compatibility](matrix-compatibility.md) describe the boundaries a release must retain. No production deployment or marketplace publication has been performed.
