# Installed-client silent opening repair

## Observed failure

On 2026-10-15, the operator reported that the bot's outgoing call rang and was answered on the enrolled iPhone, but no opening speech was heard. The native dial started at `04:33:35Z` with a 60-second ringing budget. The server recorded the recipient joining around `04:33:53Z`, including an encrypted audio publication. The native result at `04:34:35Z` was `backend-failed`. Services remained healthy and the call was eventually cleaned up.

The old answer gate waited for an authenticated incoming recipient key and a subscribed live encrypted audio track before synthesizing the opening. The previous peer test provided both, even though it emitted no utterance. It did not test a receive-only answer. Existing production logs did not distinguish the pending incoming key/subscription condition, so the exact lower-level cause was not captured.

## Repair and validation

Source `d3e45e7` introduces a separate MatrixRTC recipient verifier for opening speech. It checks current membership, exact SFU identity, enabled encryption, fresh device trust, bounded lifetime and call continuity. The publication guard still checks listeners and sends outgoing keys only to verified devices. The returned recipient proof deliberately omits the incoming `mediaEncrypted` assertion. Voice input retains the previous authenticated-key, encrypted live-track and participant-verification requirements.

The suite passes 1,334 tests with 100% per-file runtime coverage across 56 non-empty files. The native browser and restricted Docker image pass a real encrypted Matrix/SFU regression in which the recipient publishes no microphone track or media key until after receiving the opening. Subsequent non-owner voice input/reply, recipient hangup, unanswered cleanup, device persistence and restart/rejoin also pass. Speech and agent services are authenticated protocol fixtures. Browser namespace/seccomp sandbox checks pass.

Fixed outbound stage logs identify connection, answer waiting, synthesis, publication, completion and the failed stage. They include no speech text, credentials, device keys or raw backend errors.

## Deployment identity

The private repair image is `matrix-call-browser-worker:0.1.0-alpha.4-receive-only-d3e45e7`, with server ID `sha256:86f5e55fb87bdeee9198b5d99e4a780e695e90e28d7a54d760f534598a350c45`. It layers the reviewed worker bundle and browser assets over verified alpha.3 base `sha256:76664b11de96ae4b8024b4692a982ac80fc454ea6f4c7b9548942128369aef28`. The transferred build context SHA-256 is `c04e8fe05e51eb70c45c35dbcc938ff1c522b0192c9b60a0c0be6f5503e75102`. Local and server IDs differ because their builders generate different image metadata; the bundle/asset hashes are compared explicitly.

The native alpha.4 package, speech image, administrator/requester/recipient policy, Matrix messaging admission, model authentication and device enrollment are unchanged. Gateway state and the persistent calling profile were backed up before coordinated replacement. Private records are `records/pre-receive-only-backup.json`, `records/receive-only-candidate.json` and `releases/0.1.0-alpha.4/receive-only-browser-d3e45e7.json`.

Installed-client ringing is now observed, but opening audibility after this repair requires a new operator result. No unrelated recipient was called during validation.
