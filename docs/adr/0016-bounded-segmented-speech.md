# ADR 0016: Bounded segmented speech

## Status

Accepted. Extends the output policy of [ADR 0009](0009-bounded-portable-voice-turns.md) and the optional local service in [ADR 0010](0010-optional-local-speech-service.md).

## Date

2026-10-14.

## Context

The first voice implementation requires a complete response to fit one ten-second PCM result. An actual model can exceed this even when asked to be concise. Increasing a buffer limit would remove a useful bound without addressing cancellation, caller revocation or total spoken duration.

## Decision

Keep capture, speech HTTP results and transport publications bounded to ten seconds each. Split full agent text into at most 64-grapheme pieces, preferring word and punctuation boundaries. Synthesize and publish sequentially, with no prefetch or overlapping input. Retain one complete agent reply in conversation history.

An explicit portable `synthesis-too-long` error permits smaller text pieces. HTTP adapters expose that signal only after verifying a strict, signed, request-bound 422 response. Diagnostic overflow and ordinary provider/authentication/timeout errors never cause subdivision. Repeated model execution is not part of this policy.

Bound each reply to 64 synthesis attempts and sixty seconds of generated audio, within the existing total turn deadline. Reverify the same captured user/device before every generation and publication. Session end, revocation, failures and exhausted bounds close the conversation and prevent further speech. Wipe transferred synthesis PCM, owned playback copies and late canceled results.

## Alternatives considered

- Raising the PCM or HTTP body bound would increase memory retention and reduce revocation opportunities.
- Truncating the model reply would silently omit content while preserving a misleading full text history.
- Retrying ordinary failures could repeat billable or side-effecting agent work.
- Streaming provider audio needs a separately negotiated protocol and interruption policy.

## Consequences

The portable coordinator supports longer bounded spoken responses without requiring a particular agent or speech vendor. It remains half duplex. Unbroken tokens can require hard splits; pronunciation and inter-piece gaps need client/provider evaluation. The complete text record does not assert that every piece was delivered: a later error or budget limit can leave partial audio. Arbitrary-length speech, interruption, real-provider failure behavior and released-client interoperability retain separate evidence gates.
