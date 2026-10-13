# Portability

The call core and RTC worker must not depend on OpenClaw, ClawHub, a hosted model service, or a proprietary speech SDK. OpenClaw integration belongs to the plugin package. MatrixRTC and LiveKit integration belong to transport adapters.

The core uses explicit interfaces for agent turns, speech recognition, speech synthesis, RTC transport, participant verification, and state persistence. Adapters may be replaced without changing call authorization, session lifecycle, or orchestration.

An OpenAI-compatible HTTP adapter describes a wire format, not a requirement to have an OpenAI account. Local compatible services are valid implementations. Additional protocols can implement the same ports.

Use portable PCM/WAV media and documented JSON contracts. Keep vendor-specific identifiers and credentials in adapter configuration. Caller authority and call identity must retain their protocol meaning across adapters.

The initial MatrixRTC/LiveKit adapter remains specific to Element Call interoperability. Portability does not mean that every RTC backend is implemented at the first release. Alternative transports must prove equivalent participant identity and media encryption behavior before they can be enabled.

Publish standard package archives and OCI worker images. ClawHub is a discovery and distribution option, not a runtime dependency. Preserve supported local installation and self-hosted operation.
