# Portability

The call core and RTC worker must not depend on OpenClaw, ClawHub, a hosted model service, or a proprietary speech SDK. OpenClaw integration belongs to the plugin package. MatrixRTC and LiveKit integration belong to transport adapters.

The core uses explicit interfaces for agent turns, speech recognition, speech synthesis, RTC transport, participant verification, and state persistence. Adapters may be replaced without changing call authorization, session lifecycle, or orchestration.

An OpenAI-compatible HTTP adapter describes a wire format, not a requirement to have an OpenAI account. Local compatible services are valid implementations. Additional protocols can implement the same ports.

Use portable PCM/WAV media and documented JSON contracts. Keep vendor-specific identifiers and credentials in adapter configuration. Caller authority and call identity must retain their protocol meaning across adapters.

The initial MatrixRTC/LiveKit adapter remains specific to Element Call interoperability. Portability does not mean that every RTC backend is implemented at the first release. Alternative transports must prove equivalent participant identity and media encryption behavior before they can be enabled.

Publish standard package archives and OCI worker images. ClawHub is a discovery and distribution option, not a runtime dependency. Preserve supported local installation and self-hosted operation.

## Agent portability

An agent is a replaceable runtime, not just a replaceable model name. The core must support another agent framework or a custom self-hosted agent without importing OpenClaw or changing call orchestration.

The agent port accepts a neutral conversation identifier, a turn identifier, verified caller context, and ordered text messages. It returns a text reply. Cancellation uses the standard AbortSignal interface. OpenClaw session keys, provider-specific model options, credentials, and private SDK objects belong inside the chosen adapter.

Conversation records use versioned JSON with text, roles, caller identifiers, and timestamps. They do not require a vendor database to read or export. A host may also retain private tool traces or hidden state; replacing that host does not promise migration of undocumented internal state. Switching runtimes starts a new call unless an explicit migration preserves both history and authorization.

The portable agent HTTP protocol is a separate integration option. A self-hosted service can implement it using any agent framework or model backend. OpenAI-compatible model APIs are optional adapters, not the definition of an agent.

Caller authorization happens before agent dispatch. An adapter must preserve the verified caller and call isolation and must keep its host's tool approval checks authoritative. Changing an agent backend cannot grant owner authority to an unverified participant. Capability differences must be declared rather than silently replaced with broader permissions.
