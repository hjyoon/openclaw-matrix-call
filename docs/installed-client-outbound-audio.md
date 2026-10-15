# Installed-client outbound audio check

Checked: 2026-10-15. An operator heard both Korean and English synthesized announcements in an actual MatrixRTC call using Element X on an iPhone 13 mini. This is an outbound audio check, separate from the complete [released-client speech loop](released-client-integration.md).

| Component | Observed configuration |
| --- | --- |
| Client | Element X on iPhone 13 mini; exact app version not collected |
| Gateway | OpenClaw 2026.10.2 in an existing Linux x86-64 Docker deployment |
| Plugin | Public `@hjyoon/openclaw-matrix-call@0.1.0-alpha.1` |
| Browser | Custom source `5984e099730ff3837c562dbaa2cd6d87904557e9`, distinct image tag |
| Authorization / SFU | Existing authorization service 0.4.1 / LiveKit 1.12.0 |
| Calling mode | MatrixRTC state membership, slot `m.call#ROOM`, explicit `legacy-pipe` room encoding |
| Enrollment | Fresh bot device/profile; owner device ID and signing fingerprint compared through a trusted channel |
| Speech | Actual local eSpeak synthesis, Korean about 3.83 s and English about 2.73 s |
| Result | Connected owned session; both announcements audibly confirmed; exact-session leave succeeded |

The browser and speech worker used the existing Gateway's network namespace with separate restricted containers and no host-published calling ports. Messaging connectivity and signed readiness/control were checked independently. The operator added only explicitly compared devices; a different device was not automatically admitted.

The owner could not speak during this test. Announcements therefore used fixed operator-authored text through the real signed speech adapter and the current driver's guarded publication path. Publication retained current listener, device-trust and encrypted-key checks. A temporary operator diagnostic attachment was closed after each attempt and its container files were removed. No permanent announcement endpoint or public `say` command was added. The owner requested repeated playback and confirmed both languages after the third attempt.

No inference was dispatched for these announcements. Microphone capture, recognition, the model-backed reply loop, response latency, interruption handling and Linux-client audio remain unverified for this installed-client/backend combination. The result does not establish Matrix 2.0, legacy VoIP, arbitrary client versions or general-user approval. The original public alpha.1 image archive remains immutable and does not contain the older-backend room-encoding option.

The private deployment record retains the image/archive identity, session cleanup and operator confirmation without committing credentials, device pins, room IDs, recordings or personal transcripts.
