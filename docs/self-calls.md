# Calls requested by ordinary Matrix users

The unpublished alpha.3 candidate adds opt-in self-calling for every user admitted by the Matrix messaging adapter. Control owners remain administrators. A user can mention the assistant and request, "Call me now and say good morning." The model receives the same `matrix_call` tool, bound to that authenticated sender rather than a tool-supplied identity. See [ADR 0026](adr/0026-authenticated-self-calls.md).

## Configuration

Merge `selfCalls: true` into `channels.matrix-call` in the Gateway configuration and into the browser worker's existing JSON configuration. Keep the native `policy.owners` and browser `owners` lists limited to the existing control/ordinary-join policy. Both matching alpha.3 components must be installed together. The worker advertises signed `selfCalls` capability; older or disabled workers reject discovery before dialing.

Existing tool-profile opt-in through `tools.alsoAllow: ["matrix_call"]` still applies. This setting does not independently change the Matrix messaging adapter's sender access. An operator who wants public bot mentions and DMs must separately configure the adapter's group and DM access, retaining group mention requirements and private administrative rooms as appropriate. Literal slash commands remain subject to the host's command authorization policy.

## First use

The caller and bot need an existing joined encrypted two-person room. A bot DM is sufficient. If a request arrives in a group, the worker discovers an appropriate private room instead of ringing the group. Discovery prefers a trusted current private room and otherwise sorts eligible rooms deterministically. It does not create rooms or invite contacts automatically. The scan is bounded to 256 synced rooms and one deadline.

A recipient device must already be verified by the calling browser's Matrix crypto state. Existing verified devices can be used. For a new user, compare their device ID, Ed25519 signing fingerprint and Curve25519 identity key through a trusted enrollment process, then add the compared device to the browser configuration's `devices` list and perform a coordinated restart. With self-calling enabled, a pin can belong to a non-owner; this never grants administrator privileges. The worker requests fresh device records and refuses changed enrollment evidence.

Missing setup fails before ringing with `private-room-required` or `verification-required`. Public access does not automatically mark arbitrary devices trusted. Answering still requires the exact recipient, current membership, authenticated media keys and encrypted live audio. Opening speech does not require microphone input.

## Authority and limits

The SDK's current Matrix sender and live V2 invocation guard establish self-call authority. Tool arguments cannot select another recipient or supply an owner role. General-user model status hides another caller's session, and leave requires the exact requester's session. Administrator RPC and owner commands retain explicit management authority.

An admitted self-call establishes a scoped voice participant policy for its recipient and private room. The browser's voice assistant, signed agent service and native adapter use that scope. Normal voice replies remain delegated with `senderIsOwner: false`, `toolsAllow: []` and no model override. Call failure, explicit leave and service closure revoke this scope. The global control-owner policy is preserved.

The worker still handles one call at a time. Other callers receive `busy`; they cannot terminate the existing call. Scheduling, automatic device enrollment and third-party dialing are not implemented.

## Verification

The change passes 1,283 tests with 100% per-file runtime statements, branches, functions and lines. `pnpm verify:matrix-self-calls` passes an actual non-owner call in an encrypted private room outside the configured owner room list, opening audio without an utterance, subsequent non-owner voice input/reply and unanswered cleanup. Speech and model services in this check are authenticated protocol fixtures.

`MATRIX_CALL_SELF_CALLS=1 pnpm verify:matrix-commands` passes actual Matrix chat through the installed native Gateway with an ordinary sender, private-room discovery and a model tool invocation. A forged administrator role and a third-party recipient do not cause a dial. The run records 18 chat replies, two outgoing dials, three ordinary joins and five completed disconnects. Its media/model are fixtures and its chat is unencrypted. Installed-client ringing and real speech require separate evidence.
