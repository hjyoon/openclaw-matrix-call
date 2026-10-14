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

The signed worker server and controller are real. Media connection/disconnection are deterministic fixtures; the check performs no RTC handshake or speech inference. Chat rooms are unencrypted, and participants use HTTP protocol fixtures rather than released applications. The separate [native Matrix speech check](native-matrix-integration.md) verifies actual encrypted media, engines and Gateway dispatch through the administrator RPC. Combining chat command entry with that complete media path and encrypted chat remains further work.

## Supported command placement and observed limits

Send a literal command at the beginning of the Matrix message body, for example `/matrixcall status`. DMs are the simplest operator entry point. A dedicated allowlisted control room can use `requireMention: false`; its sender allowlist and the calling plugin's exact owner policy still apply. Do not change a general conversation room's mention policy solely to enable this control entry. Clients with local slash handling must transmit the literal command as message text.

In the pinned messaging adapter, prefixing the custom command with the bot's visible Matrix mention did not reach the plugin command handler. That attempt made five requests to the deliberately unavailable provider fixture and no worker join. The host control-command detector recognizes built-ins but excludes registered plugin commands, so the Matrix adapter did not preserve the stripped custom-command body. This workflow does not patch the host or treat model interpretation as command execution. Visible mention-prefixed `/matrixcall` is not a supported control form in this tested version.

Sending the command first in a mention-required room also failed admission despite `m.mentions` metadata; the check therefore uses a dedicated control room with an explicit mention policy. Do not infer support for arbitrary client mention formatting from these results.

The initial two-DM attempt used the default shared session and received the host's DM isolation warning. Explicit `per-room` routing passed both direct-room checks. The test's first startup attempt also sent before Matrix sync was connected; the public connection barrier now prevents that setup race. None of these changes relax caller authorization or automatically retry a command.

Released-client interoperability, encrypted chat entry, incoming calls, coordinated worker replacement, sustained input stability and clean operator setup still gate a calling release. See [release readiness](release-readiness.md).
