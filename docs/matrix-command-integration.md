# Actual Matrix command integration

Checked locally: 2026-10-14.

`pnpm verify:matrix-commands` installs the packed calling plugin and the pinned official `@openclaw/matrix` 2026.10.2 messaging plugin in a disposable OpenClaw 2026.10.2 Gateway. Real Matrix messages pass through Synapse 1.162.0, the messaging adapter, the host's command dispatcher, the calling plugin and the signed worker HTTP API. No handler is invoked directly by this check.

## Running the check

Use the pinned Node/pnpm versions and Docker as a non-root user:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify:matrix-commands
```

The helper creates disposable accounts, one private control room, two direct rooms and a private Gateway profile outside the repository. It validates each issued Matrix user/device against `whoami`. The official plugin is copied from the integrity-locked development dependency into ordinary private files and linked there: pnpm's hardlinked package entries fail the host's file-boundary validation. Local-source trust and capabilities are acknowledged only in that disposable profile. The calling plugin is installed from its actual archive.

The Gateway uses explicit sender/room allowlists, disabled introductions, no scheduled work and `dm.sessionScope: per-room`. The test waits for the public channel status to report a configured, running, connected Matrix adapter before sending commands. Matrix credentials and control keys stay inside the temporary profile. The provider fixture counts unexpected requests and never supplies inference.

## Verified behavior

Fifteen Matrix replies passed in the private control room and both direct rooms:

- A real visitor's command is rejected even with the owner's display name and forged sender/owner fields in event content. The Matrix homeserver supplies the actual sender; the calling policy permits only the configured owner.
- Owner status, join and leave work without a model request.
- An unconfigured target room, invalid UUID, wrong current session and overlapping join are rejected. Invalid syntax returns usage without a media operation.
- Exact-session leave completes backend cleanup, and subsequent calls use new owned sessions.
- Gateway shutdown closes the final owned session. Three accepted connections receive three disconnects, and no active session remains.
- The two direct rooms remain separate under the messaging adapter's `per-room` session routing.

The signed worker server and controller in this fifteen-reply check are real. Media connection/disconnection are deterministic fixtures; it performs no RTC handshake or speech inference. Its chat rooms are unencrypted, and participants use HTTP protocol fixtures rather than released applications. The combined check below separately exercises encrypted chat and actual media.

## Encrypted commands with actual speech

`pnpm verify:matrix-chat-media` installs both native plugins and sends literal commands from the SDK peer in the encrypted call room. The peer pins the newly provisioned messaging device against its Matrix device record. Every outgoing command is checked against the actual homeserver event: `m.room.encrypted`, Megolm algorithm, exact Matrix sender and no plaintext body. The peer decrypts the real bot replies and checks their wire encryption too. No handler, model interpretation or media-operation replay substitutes for chat delivery.

On 2026-10-14, six commands/replies passed with the native worker and five with the restored browser image. They cover status, forbidden target, join, duplicate join, wrong-session leave and native exact-session leave. The image's final call is closed by Gateway shutdown. Both modes produce actual Korean/English speech through local CPU engines, installed public SDK agent dispatch and a deterministic provider. The first audible replies took 14.94/9.66 seconds natively and 17.04/9.20 seconds in the image. All observed active output frames were encrypted; two-turn host history and fresh call isolation pass. Command processing adds no provider inference.

The successful local image check enabled the documented capture diagnostics. CI runs the ordinary uninstrumented command. Participants remain SDK peers; this result does not establish released-client interoperability or actual inference through chat entry. Chat session records are permitted alongside the one exact current call record, while call history remains bound to its independent UUID.

An earlier combined attempt returned `[blank_audio]` on the image's second English input. The local Whisper adapter now treats marker-only results as silence without model dispatch. Another attempt failed enrollment because the SDK's uncached HTTP device listing preceded crypto-store registration; enrollment now waits for stored pinned device records. The successful run follows those fixes. Input quality and sustained-call stability remain release gates; one successful run does not close them.

## Supported command placement and observed limits

Send a literal command at the beginning of the Matrix message body, for example `/matrixcall status`. DMs are the simplest operator entry point. A dedicated allowlisted control room can use `requireMention: false`; its sender allowlist and the calling plugin's exact owner policy still apply. Do not change a general conversation room's mention policy solely to enable this control entry. Clients with local slash handling must transmit the literal command as message text.

In the pinned messaging adapter, prefixing the custom command with the bot's visible Matrix mention did not reach the plugin command handler. That attempt made five requests to the deliberately unavailable provider fixture and no worker join. The host control-command detector recognizes built-ins but excludes registered plugin commands, so the Matrix adapter did not preserve the stripped custom-command body. This workflow does not patch the host or treat model interpretation as command execution. Visible mention-prefixed `/matrixcall` is not a supported control form in this tested version.

Sending the command first in a mention-required room also failed admission despite `m.mentions` metadata; the check therefore uses a dedicated control room with an explicit mention policy. Do not infer support for arbitrary client mention formatting from these results.

The initial two-DM attempt used the default shared session and received the host's DM isolation warning. Explicit `per-room` routing passed both direct-room checks. The test's first startup attempt also sent before Matrix sync was connected; the public connection barrier now prevents that setup race. None of these changes relax caller authorization or automatically retry a command.

Released-client interoperability, incoming calls, coordinated worker replacement, sustained input stability and clean operator setup still gate a calling release. See [release readiness](release-readiness.md).
