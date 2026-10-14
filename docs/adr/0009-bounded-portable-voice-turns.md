# ADR 0009: Bounded portable voice turns

Status: Accepted. Output policy extended by [ADR 0016](0016-bounded-segmented-speech.md).

Date: 2026-10-13

## Context

The browser worker can exchange encrypted PCM and verify Matrix participants, but it does not yet connect received audio to an agent. The voice layer needs explicit limits and cancellation without binding the portable worker to a speech or agent vendor.

## Decision

Use a portable voice coordinator around the existing call coordinator. Speech recognition, agent execution, speech synthesis and RTC publishing remain separate ports. An optional signed HTTP speech protocol supplies both speech ports without requiring a particular provider. Browser capture uses decrypted remote audio and never accepts participant identity or audio through the public worker API.

Authorize a participant before sending audio to recognition. Reverify the same Matrix user and device before agent dispatch and after synthesis. Pin each turn to its captured participant identity. A transcript cannot change authority. A fresh call gets a new conversation UUID; devices, call authority and audio buffers are never restored from conversation history.

Process one utterance at a time, with a total deadline. Drop overlapping utterances instead of retaining a queue. Capture and output are bounded to ten seconds of mono PCM. Cancel all work and close the conversation on session end or turn failure. Discard late provider results. Use bounded volatile storage by default; durable storage remains a separate port.

## Alternatives considered

Embedding a hosted speech SDK would make a vendor account mandatory. Streaming and overlapping turns would require additional interruption, echo and memory policies before they could safely share the existing call coordinator. Retaining an unbounded audio queue would keep stale input after the participant or call changed.

## Consequences

This first voice implementation is half duplex. It does not provide interruption while the assistant is speaking, streaming recognition, long generated responses or separate per-user assistants. Those capabilities require explicit buffer, cancellation and history policies.

HTTP agent implementations retain their own credentials and tool policy. The native OpenClaw adapter remains subject to [ADR 0004](0004-delegated-openclaw-ingress.md); adding speech does not grant host tools or owner authority.

Protocol fixtures validate routing, authentication, cancellation and actual encrypted audio transport. They do not validate the accuracy or latency of a real speech model or claim released-client interoperability.
