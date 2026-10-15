# Calls requested by ordinary Matrix users

The unpublished alpha.4 candidate supports self-calls and explicitly enabled calls to another Matrix recipient. Any user admitted by the messaging adapter can ask the assistant to call an enrolled recipient, ring their client and speak after a verified answer. Control owners remain administrators. See [ADR 0026](adr/0026-authenticated-self-calls.md) and [ADR 0027](adr/0027-third-party-call-requesters-and-recipients.md).

## Configuration

Merge these settings into the native Gateway configuration:

```json
{
  "channels": {
    "matrix-call": {
      "selfCalls": true,
      "thirdPartyCalls": true
    }
  }
}
```

The browser worker must also have `selfCalls: true` and advertise signed outbound/self-call capabilities. Its existing alpha.3 protocol is compatible with the alpha.4 native adapter. The legacy `selfCall` wire flag selects dynamic verified private-room admission; the adapter separately authorizes recipient selection. Browser and speech runtime changes are unnecessary for this extension.

`thirdPartyCalls` defaults to false and requires `selfCalls: true`. With third-party calls disabled, ordinary requests remain limited to the authenticated sender. Keep native `policy.owners` and browser `owners` lists restricted to the existing administrator/ordinary-join policy. Neither callers nor recipients need to be added as administrators.

Existing tool-profile opt-in through `tools.alsoAllow: ["matrix_call"]` still applies. An operator wanting public mentions and DMs must separately configure the Matrix messaging adapter's sender access. Literal commands remain subject to the host command authorization policy.

## Request examples

- "Call me now and say good morning."
- "Call @alex:example.org now and say the meeting starts in five minutes."
- "Call @sam:another.example and say please check the message I sent."
- "Cancel the call I requested."

The model uses `matrix_call` with `operation: "dial"`, an exact `recipientId` and `message`. Omitting `recipientId` means the authenticated requester. Display names are not identity evidence. An unresolved name needs clarification rather than a guessed Matrix ID. Opening text does not establish sender identity or administrator authority.

When host command authorization permits it, `/matrixcall call-to @alex:example.org Good morning.` provides a direct entry without model inference. `/matrixcall call Good morning.` calls the requester.

## Recipient setup

The recipient and bot need an existing joined encrypted two-person room and a device verified by the calling browser's Matrix crypto state. The requester may address the bot elsewhere; the worker discovers the recipient's private room. A preferred room is only a hint and must pass actual membership checks. Discovery does not create rooms or invite contacts. It scans at most 256 synced rooms within one deadline.

For a new recipient, compare their device ID, Ed25519 signing fingerprint and Curve25519 identity key through a trusted enrollment process, then add the compared device to the browser configuration's `devices` list and perform a coordinated restart. Existing verified devices can be used. Non-owner device pins never grant administrator privileges. Missing recipient setup fails before ringing with `private-room-required` or `verification-required`.

An answer requires the exact recipient, current membership, authenticated media keys and encrypted live audio. Opening speech does not require microphone input. The requester does not need a verified calling device merely to ask the bot to call someone else.

## Authority and limits

The SDK's trusted current Matrix sender and live V2 invocation guard establish requester identity. Tool arguments cannot override that identity or supply an owner role. General-user status and exact-session leave are limited to calls initiated by that requester. Another user, including the callee, cannot use this model tool to inspect or cancel someone else's request. The callee can hang up in their client. Administrator RPC and owner commands retain management authority.

The active call grants an ephemeral voice participant policy only to the recipient and their private room. The requester receives no voice authority in the callee's room. Voice replies remain delegated with `senderIsOwner: false`, `toolsAllow: []` and no model override. Failure, explicit leave and service closure revoke the scope. Global administrator lists stay unchanged.

The worker handles one call at a time. Other attempts receive `busy`. Scheduling, automatic device enrollment and concurrent calls are not implemented. Real-client outgoing ringing and intelligible opening speech remain separate from already-established-call announcement tests.

## Verification

The runtime suite passes 1,293 tests with 100% per-file statements, branches, functions and lines. Tests cover ordinary third-party requests, distinct requester/callee authority, unrelated-user status/leave rejection, self-only default behavior and missing recipient setup before dialing.

`MATRIX_CALL_SELF_CALLS=1 MATRIX_CALL_THIRD_PARTY_CALLS=1 pnpm verify:matrix-commands` checks an actual installed Gateway receiving ordinary-user Matrix requests, calling a third enrolled recipient's private room and allowing the requester to cancel through a model tool. Its chat, media and model fixtures do not prove real-client audio. The independent `pnpm verify:matrix-self-calls` check covers real MatrixRTC ringing, encrypted opening audio, subsequent non-owner voice input/reply, recipient hangup and unanswered cleanup against isolated infrastructure and authenticated speech/model fixtures.

The [installed alpha.4 deployment](installed-third-party-calls.md) records exact artifacts, preserved policy, successful readiness and remaining phone-test limits.
