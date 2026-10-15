# Installed outbound-call candidate

On 2026-10-15, the operator installed the unpublished `0.1.0-alpha.2` candidate from source `94fe5b6f0222ce11623df3fde44eea5143adab42` on the existing Linux Docker deployment. This is distinct from the immutable public alpha.1 release.

The matching native package, browser worker and speech worker were installed together. Configuration, complete Gateway state and the complete calling crypto/browser profile were backed up before replacement. Existing verified device enrollment and the stable browser asset origin were preserved. The deployment retains the existing authorization service 0.4.1 and LiveKit 1.12.0 with explicit `roomAliasFormat: legacy-pipe`.

| Artifact | SHA-256 |
| --- | --- |
| Native package archive | `66b300e9a9a13dd913824de77f218fa9c567ccf6531a710e1146e3b455dad9f9` |
| Paired worker image archive | `201853792ee1527b93b9f1e9377625ebae2fd8e38c3bb6fde8bea2f88b80b1e5` |
| Browser image ID | `1db69bb2dc3bd727c117fba2e05ec8867bdfa438a309076c5cd4e8c89755e1d4` |
| Speech image ID | `0c544635a285aae2b04f7a827c1a900db57306d51fbc0a4d5dcdcb80902604c5` |

After coordinated cold startup, the signed native control reported an available idle worker. Readiness returned HTTP 200, outbound capabilities were present, and the original Matrix messaging account remained configured, running and connected. The host's minimal tool profile explicitly allows `matrix_call`; the plugin independently requires a trusted current Matrix owner invocation. The initial outgoing recipient is the configured owner in a private encrypted two-person room, with the previously compared Linux and iPhone devices pinned.

The candidate passed 1,230 unit tests with 100% statements, branches, functions and lines for every nonempty runtime file. Artifact validation, packed native installation, marketplace dry-run inspection, [owner/visitor model-tool routing](outbound-call-integration.md), real isolated MatrixRTC ringing/answer/encrypted opening, unanswered cleanup, browser sandbox checks and the container voice regression passed. The isolated speech/model used protocol fixtures. These checks do not establish that an installed phone displays an incoming-call UI.

The operator was asked to mention the bot in Matrix and request an immediate call with an opening announcement. Installed iPhone ringing, answer and intelligible opening speech remain awaiting that result. The earlier [heard announcements](installed-client-outbound-audio.md) were sent to an already active call and do not establish bot-initiated phone ringing. Future-time scheduling and separate non-owner recipient authorization are not implemented.

Private installation reports, checksums, backups and readiness evidence are retained outside Git in the operator's deployment records.
