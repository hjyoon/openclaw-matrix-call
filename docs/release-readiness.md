# Public release readiness

Updated: 2026-10-14. This repository is public source under development. It is not yet an installable calling release. The native package registers a channel descriptor, optional signed agent service, owner-only Matrix status/join/leave commands and administrator Gateway media controls. A separately provisioned worker, coordinated setup and complete client/model validation remain required.

## First public alpha

The initial calling scope is an explicitly configured owner and room, encrypted MatrixRTC conference audio, bounded half-duplex speech, and delegated, tool-free OpenClaw inference. Speech and agent services remain replaceable. The local CPU speech implementation needs no hosted speech account.

Administrator tool execution and general-user approval require a supported host authorization path; see [ADR 0004](adr/0004-delegated-openclaw-ingress.md). Legacy Matrix VoIP, interruption and other unimplemented capabilities must remain explicitly unavailable. Future capabilities do not become supported merely because a package installs.

## Evidence and gaps

| Requirement | Current evidence | Work before a calling alpha |
| --- | --- | --- |
| Native package installation | Packed archive installs and runs its signed agent service in a disposable OpenClaw 2026.10.2 Gateway | Recheck the final calling package and complete operator setup from an empty environment |
| Gateway-to-worker integration | Gateway-owned signed agent service plus native signed worker control; installed Gateway checks dispatch, strict admission, history, cancellation, restart/reload and exact owned-session cleanup using deterministic fixtures | Connect both to real encrypted voice and validate coordinated replacement |
| Model-backed voice response | Real installed SDK dispatch reaches a deterministic model-provider HTTP fixture; encrypted Matrix speech checks use a separate agent fixture | Connect an operator-configured real model to the spoken path and test reply, history, abort and failure |
| Real speech in encrypted calls | Korean/English turns pass real local engines through the production driver and restored browser image; leave cancels recognition | Broader input quality, sustained-call stability and target-server latency/resource measurements |
| Device and service setup | Strict external configuration, persistent private profiles, explicit fingerprint pins, optional local speech Compose | Provide a reproducible enrollment/setup flow with useful configuration diagnostics and preserved device state |
| Call entry | Documented owner-only Matrix command and administrator RPC; real installed RPC controls a signed fixture worker, while command identity is checked with SDK contexts | Check actual Matrix chat command dispatch and complete spoken turns; automatic incoming-call handling is unavailable |
| Released Matrix clients | SDK peers pass encrypted audio and restart/rejoin | Record supported application versions, protocol/encryption mode and complete spoken turns with at least one actual client; test compatible non-Element clients where available |
| Distribution | Development bundles, image recipes, pinned dependencies and third-party notices | Produce versioned plugin archives and worker images, inspect publication contents, validate the selected marketplace requirements, and publish install instructions |

Runtime coverage is 100% per non-empty source file. That checks exercised code paths; it does not replace client interoperability, native model dispatch or clean-host usability evidence. `/readyz` continues to report unavailable until assistant readiness has its own completed contract and checks.

## Next implementation order

1. Exercise native control and the signed agent service together through real encrypted media, including actual Matrix command entry and coordinated lifecycle behavior.
2. Verify real model-backed spoken turns through that service and a released compatible Matrix client; investigate intermittent enrollment and later-input failures.
3. Add setup/enrollment diagnostics and validate the complete instructions from an empty operator environment.
4. Build and inspect release artifacts, finish marketplace validation and publish a version with its exact supported scope.

The [implementation status](implementation-status.md) records completed behavior. The [architecture requirements](architecture.md#release-requirements) and [Matrix compatibility](matrix-compatibility.md) describe the boundaries a release must retain. No production deployment or marketplace publication has been performed.
