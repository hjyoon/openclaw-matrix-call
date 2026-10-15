# Installed self-call policy

This records the alpha.3 installation. The current [alpha.4 deployment](installed-third-party-calls.md) additionally permits explicitly selected third-party recipients and retains the workers described here.

On 2026-10-15, the operator enabled self-calling for ordinary Matrix users on the existing Docker deployment. This uses an unpublished alpha.3 native package and speech image from `016265033f5721b445f9596505449e44932df4bd`, plus browser runtime bundles from `8c31337695727fddcaadbe89f34c63f08859edaf` to release the shared call slot when the answered recipient leaves.

The native channel and browser both have `selfCalls: true`. Matrix DMs are open with per-room sessions. Group sender admission is open, with mentions required in ordinary rooms and bot threads. The private administrative room retains its owner-only sender rule. Control owners, command owners, existing owner device pins and model authentication were preserved. The requested scope is calls to the authenticated requester, not calls to arbitrary third parties.

Each caller needs an existing joined encrypted two-person room with the bot and a device verified by the calling browser. A new user's compared device can be enrolled without adding that user to any administrator list. Public message admission does not automatically verify device fingerprints. Missing setup fails before ringing. See [self-call setup](self-calls.md).

Before replacement, the operator backed up configuration, complete Gateway state and the complete calling browser/crypto profile with services stopped. The installation retained the existing authorization service 0.4.1 and LiveKit 1.12.0 through explicit `legacy-pipe` room encoding.

The browser image is `matrix-call-browser-worker:0.1.0-alpha.3-hangup-8c31337`, with actual server image ID `sha256:0f00d938b74036db4cca1f648fd84955280dc05ce342d268c5f1a00168d1778d`. Its reviewed worker bundle and browser assets were layered over verified alpha.3 base image `sha256:76664b11de96ae4b8024b4692a982ac80fc454ea6f4c7b9548942128369aef28`. The build context was transferred with a SHA-256 check, and every running bundle/asset was compared against its source build hash. Local and server image IDs differ because the local legacy Docker builder and server BuildKit generated different image metadata. The native archive SHA-256 is `c4a75ea9d6fdfba90ca57c94e3d44beac27509aa9867c9da2b321bde555c96fe`.

After coordinated cold startup, readiness returned HTTP 200, signed worker control was available and idle, and outbound/self-call capabilities were present. The original Matrix messaging account was configured, running and connected. The deployment's private records contain exact image/package reports, build-file hashes, backup locations and service evidence.

Validation passed 1,284 tests with 100% per-file runtime statements, branches, functions and lines. Actual isolated Matrix checks covered normal-user model invocation, rejection of a third-party recipient and forged administrator fields, private room discovery, encrypted non-owner opening audio, subsequent voice input/reply, recipient hangup cleanup and unanswered cleanup. Browser sandbox and container regression checks passed for the reviewed bundles. Model and speech services in these integration checks were protocol fixtures. The owner-only default configuration also passed the actual Matrix command regression.

Installed iPhone ringing and intelligible speech for this outgoing workflow remain unverified. Earlier heard announcements were sent to an already active call. Scheduling, automatic device enrollment, arbitrary third-party calling and concurrent calls are not implemented.
