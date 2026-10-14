# Public release readiness

Updated: 2026-10-14. This repository is public source under development. It is not yet an installable calling release. The native package registers a channel descriptor, optional signed agent service, owner-only Matrix status/join/leave commands and administrator Gateway media controls. A separately provisioned worker, coordinated setup and complete client/model validation remain required.

## First public alpha

The initial calling scope is an explicitly configured owner and room, encrypted MatrixRTC conference audio, bounded half-duplex speech, and delegated, tool-free OpenClaw inference. Speech and agent services remain replaceable. The local CPU speech implementation needs no hosted speech account.

Administrator tool execution and general-user approval require a supported host authorization path; see [ADR 0004](adr/0004-delegated-openclaw-ingress.md). Legacy Matrix VoIP, interruption and other unimplemented capabilities must remain explicitly unavailable. Future capabilities do not become supported merely because a package installs.

## Evidence and gaps

| Requirement | Current evidence | Work before a calling alpha |
| --- | --- | --- |
| Native package installation | Packed archive installs and runs its signed agent service in a disposable OpenClaw 2026.10.2 Gateway | Recheck the final calling package and complete operator setup from an empty environment |
| Gateway-to-worker integration | Installed Gateway control and public SDK agent dispatch pass together through real encrypted Matrix media and local speech; restart/reload and strict admission also have dedicated checks | Validate coordinated replacement and complete operator setup |
| Model-backed voice response | Actual Korean/English turns pass identity, engines, SDK dispatch, ordered history and encryption in the driver/image; longer native replies and actual host cancellation/authentication failures also pass | Test longer restored-image replies, broader provider failure/reconnect behavior and supported operator configurations |
| Real speech in encrypted calls | Korean/English turns pass real local engines through the production driver and restored browser image; leave cancels recognition | Broader input quality, sustained-call stability and target-server latency/resource measurements |
| Device and service setup | Strict external configuration, persistent private profiles, explicit fingerprint pins, optional local speech Compose | Provide a reproducible enrollment/setup flow with useful configuration diagnostics and preserved device state |
| Call entry | Administrator RPC drives encrypted speech; fifteen actual Matrix chat replies verify owner controls, isolated DMs, spoof rejection and owned-session cleanup with fixture media | Combine chat entry with actual media and encrypted chat; address the visible mention-prefix limitation and incoming-call requirements |
| Released Matrix clients | SDK peers pass encrypted audio and restart/rejoin | Record supported application versions, protocol/encryption mode and complete spoken turns with at least one actual client; test compatible non-Element clients where available |
| Distribution | Development bundles, image recipes, pinned dependencies and third-party notices | Produce versioned plugin archives and worker images, inspect publication contents, validate the selected marketplace requirements, and publish install instructions |

Runtime coverage is 100% per non-empty source file. That checks exercised code paths; it does not replace client interoperability or clean-host usability evidence. `/readyz` continues to report unavailable until assistant readiness has its own completed contract and checks. The [combined native Matrix check](native-matrix-integration.md) and optional [live model check](live-model-integration.md) record native/media and actual inference evidence. Ordinary CI needs no hosted account.

## Next implementation order

1. Combine supported Matrix chat command entry with actual encrypted media; check encrypted chat, longer restored-image replies and broader provider failure/reconnect behavior.
2. Test released compatible Matrix clients and coordinated replacement; investigate intermittent recognition, enrollment and later-input failures.
3. Add setup/enrollment diagnostics and validate the complete instructions from an empty operator environment.
4. Build and inspect release artifacts, finish marketplace validation and publish a version with its exact supported scope.

The [implementation status](implementation-status.md) records completed behavior. The [architecture requirements](architecture.md#release-requirements) and [Matrix compatibility](matrix-compatibility.md) describe the boundaries a release must retain. No production deployment or marketplace publication has been performed.
