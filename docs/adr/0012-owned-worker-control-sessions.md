# ADR 0012: Owned worker control sessions

Status: Accepted

Date: 2026-10-14

## Context

Native call entry needs an authenticated connection to the portable worker. A media join can succeed while its HTTP reply is lost or the calling plugin is stopped. Cleaning up whichever session is currently visible could disconnect work started by another controller.

## Decision

Authenticate signed worker capabilities before control operations. Let a trusted controller supply a fresh session UUID before join and preserve that exact ID through the response and cleanup. Never substitute a later status session for the known ownership target. Bind requests and replies to the worker incarnation with the existing dedicated HMAC protocol.

Retain accepted session IDs within a bounded incarnation ledger. Reject reuse and capacity exhaustion rather than recycling IDs. Continue to generate IDs for older clients that omit one. Normalize UUID case consistently. Do not automatically retry mutations or reconnect a stale client to clean up a replacement worker.

Keep the HTTP client and schemas in the portable worker package. OpenClaw remains an optional native wrapper; model credentials, operator tokens and claimed caller roles do not enter the worker control body.

## Alternatives considered

- Selecting the current status session for shutdown cleanup can target another controller's call.
- Generating the ID only after join makes a lost response impossible to identify safely.
- Reusing IDs after cleanup allows a stale leave request to affect later work.
- Importing the OpenClaw SDK into the worker would couple media control to one agent host.

## Consequences

The protocol supports exact cleanup after an uncertain join outcome while keeping media authorization inside the transport. A native wrapper still needs caller authorization, service lifecycle, current-authority checks and ownership cleanup. Media control does not establish real model inference, assistant readiness or Matrix client interoperability.
