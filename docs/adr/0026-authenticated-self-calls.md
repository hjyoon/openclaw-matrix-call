# ADR 0026: Authenticated self-calls without administrator roles

Status: Accepted

Date: 2026-10-15

Partially supersedes [ADR 0025](0025-outbound-call-and-opening-speech.md): the initial owner-only caller and recipient restriction.

## Context

All users who can address the assistant must be able to request a call to themselves. Enrolling a call participant as a control owner would also grant administrative operations. A caller may address the bot in a group, while ringing and spoken output require a private encrypted two-person room.

## Decision

Add explicit `selfCalls` opt-in in the native channel and browser policy. When enabled, the V2 model tool accepts a current trusted Matrix sender without requiring the host owner bit. Bind the recipient to `requesterSenderId`; supplied roles, display names and another recipient ID never grant authority. Existing Matrix messaging access policy remains the host admission boundary.

Discover an existing joined encrypted two-person room containing exactly the bot and the requester. A trusted current private room can be preferred; model input is only a preference, never proof of membership. Room discovery is authenticated through the portable worker API and is bounded. Return explicit setup errors when no private room or verified recipient device exists. Preserve device verification, current media keys, exact membership and encrypted audio checks. Supporting all callers does not silently trust new device fingerprints.

Scope model status and leave to the requester's owned session. Preserve explicit administrator RPC and owner command controls. An active self-call issues an ephemeral voice participant policy for only that user and room; the browser voice assistant, signed agent HTTP service and native agent adapter use that scope. Voice remains delegated and tool-free. Revoke the scope on failure, leave or service closure. Do not modify persistent control-owner lists.

Default this policy to disabled for existing deployments. Installation alone does not open the messaging adapter's DM or group access. An operator can explicitly enable public mention/DM admission separately. Callers still need an existing encrypted private room and a verified device; one-time enrollment is separate from administrator authorization.

## Alternatives considered

- Adding all users to the owner list: grants unrelated administrative controls.
- Trusting a tool-supplied recipient or role: permits impersonation and unsolicited third-party calls.
- Ringing a shared group room: exposes notifications and speech beyond the intended recipient.
- Automatically marking every new device verified: weakens the established cryptographic enrollment policy.
- Exposing shared status or leave to every caller: leaks or interrupts another person's call.

## Consequences

Any admitted Matrix requester can use the same natural-language self-call workflow after private-room and device setup. The worker remains a single-call service and does not implement queuing or scheduling. New callers can receive setup-required errors before any ringing. Third-party calling, automatic enrollment and broader client interoperability require separate work and evidence.
