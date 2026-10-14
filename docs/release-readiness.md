# Public release readiness

Updated: 2026-10-15. The experimental manual calling alpha now has empty-profile setup, encrypted speech and explicit service-replacement evidence for the declared local Linux deployment. Final artifact/CI checks, paired public assets and terminal registry publication still gate distribution. Installing only the plugin does not provision the workers or enroll devices.

## First public alpha

The initial calling scope is an explicitly configured owner and room, encrypted MatrixRTC conference audio, bounded half-duplex Korean/English speech, and delegated, tool-free OpenClaw inference. The supported deployment is a native OpenClaw 2026.10.2 Gateway on a Linux x86-64 Docker host with separate browser/speech containers through the optional local host-network overlay. Workers keep separate filesystems and PID namespaces; host networking permits host loopback services. Speech and agent services remain replaceable. The local CPU speech implementation needs no hosted speech account.

The tested released client is Element Call 0.28.0 standalone compatibility, per-participant E2EE, one trusted LiveKit 1.13.9/authorization-service 0.8.0 backend and explicit OpenID `/sfu/get`. Matrix protocol interfaces remain independent of the client brand; another client or backend mode needs its own encrypted interoperability evidence. Other Gateway network namespaces, HTTPS proxy routes and platforms are outside this initial support claim.

Administrator tool execution and general-user approval require a supported host authorization path; see [ADR 0004](adr/0004-delegated-openclaw-ingress.md). Legacy Matrix VoIP, interruption and other unimplemented capabilities must remain explicitly unavailable. Future capabilities do not become supported merely because a package installs.

## Evidence and gaps

| Requirement | Current evidence | Remaining distribution gate or scope limit |
| --- | --- | --- |
| Native package installation | Packed archive installs and runs its signed agent service in a disposable OpenClaw 2026.10.2 Gateway; operator Compose starts from an empty profile | Recheck final package and install the actually published version by its registry name |
| Gateway-to-worker integration | Installed control and public SDK dispatch pass real encrypted media/speech; operator replacement changes service audiences, rejects old signed requests and preserves device keys | Automated replacement supervision and other deployment routes remain future work |
| Model-backed voice response | Actual Korean/English turns pass identity, engines, SDK dispatch, ordered history and encryption; longer operator image replies pass complete bounded synthesis/playback across replacement | Broader provider/network failures remain outside the alpha evidence |
| Real speech in encrypted calls | Korean/English turns pass real local engines through the production driver and restored browser image; leave cancels recognition | Broader input quality, sustained-call stability and target-server latency/resource measurements |
| Device and service setup | Strict private configuration/pins and persistent profiles; the public local-Gateway Compose route passes [empty-profile setup and coordinated recovery](operator-compose-integration.md) | Setup remains manual; SAS enrollment UI, unrelated network namespaces and HTTPS proxy routes are unsupported by this evidence |
| Call entry | Administrator RPC drives encrypted speech; fifteen actual Matrix chat replies verify owner controls, isolated DMs, spoof rejection and owned-session cleanup with fixture media; eleven encrypted commands/replies pass with actual speech in both worker modes; ten commands/replies also pass with a released application and actual inference | Keep the visible mention-prefix limitation explicit; incoming calls remain unsupported |
| Released Matrix clients | Element Call 0.28.0 compatibility passes encrypted commands and actual model speech in the native worker and operator browser image, persistent devices and independent histories | Additional clients, Matrix 2.0, multi-backend modes and legacy VoIP are outside the initial claim |
| Distribution | Pinned inspection/dry-run, exact plugin inventory and paired source/version reports; worker archives verify image IDs, labels, checksums and loading | Require final-source CI success, publish matching GitHub assets, wait for terminal ClawHub checks and verify public-name installation |

Runtime coverage is 100% per non-empty source file with 1,149 passing tests. That checks exercised paths; it does not replace interoperability or operator usability evidence. [Runtime readiness](readiness.md) has a bounded authenticated driver/media/voice-service contract with tests and actual Compose transitions from 200 to 503 after backend replacement and back to 200 after explicit recovery. It does not invoke inference or attest model-account validity. Ordinary CI needs no hosted account.

## Final publication sequence

1. Review the passed concise/long actual-model operator evidence and preserve the observed input/enrollment stability limits.
2. Commit the final source, require all CI jobs to pass, and build/inspect clean matching plugin/image archives.
3. Upload and verify paired GitHub prerelease assets and checksums; wait for terminal ClawHub publication rather than treating an upload as success.
4. Install the exact public package into a fresh disposable profile, check its registry origin/version and run installed SDK service/control checks. Record public links and provenance.

An earlier no-replacement operator run timed out on second-call output and stopped its browser with exit 143. A later instrumented run passed without a production-code change; its success does not identify or resolve the initial fault. Other enrollment/input failures are recorded in the integration documents. Sustained calls, arbitrary speech, physical microphones, human pronunciation quality, interruptions and target-host latency/resources are not established. The alpha must retain these limitations rather than present a stable or turnkey service.

The [implementation status](implementation-status.md) records completed behavior. The [architecture requirements](architecture.md#release-requirements) and [Matrix compatibility](matrix-compatibility.md) describe the boundaries a release must retain. No production deployment or marketplace publication has been performed at this checkpoint.
