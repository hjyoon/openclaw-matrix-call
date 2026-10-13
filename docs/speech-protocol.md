# Portable speech protocol

Speech recognition and synthesis use the core ports, independently of the agent runtime or Matrix transport. A local or hosted implementation can expose this HTTP protocol. No hosted account is required.

The service advertises `GET /capabilities` with `{ "protocolVersion": 1, "audience": "<process UUID>", "recognition": true, "synthesis": true, "encoding": "pcm-s16le" }`. Capability and successful operation responses use the same HMAC response authentication as the [agent protocol](agent-protocol.md), with a dedicated speech secret. The audience changes when the service restarts.

`POST /transcriptions` accepts `{ "protocolVersion": 1, "requestId": "<UUID>", "audio": { "encoding": "pcm-s16le", "sampleRate": 48000, "channels": 1, "data": "<canonical padded base64>" } }`. Its response echoes both envelope fields and provides `text`. An empty transcript means silence and does not invoke an agent.

`POST /syntheses` accepts the envelope and a nonempty `text`. Its response echoes the envelope and provides an `audio` object with the same format as the recognition input. Samples are signed 16-bit little endian, mono, at an integer rate between 8,000 and 48,000 Hz. Audio must contain at least one sample and at most ten seconds. Text is limited to 16,000 characters. Unknown fields, invalid base64, odd byte lengths, mismatched request IDs and oversized audio are rejected.

Provider credentials, model names, languages and voices belong in the speech service configuration. They are not supplied by participants. Speech services must honor request cancellation and use bounded generation. The bridge can use an offline speech engine or a hosted provider without changing the call policy or agent protocol.

This protocol defines interoperability between worker and speech service. It does not assert recognition quality, language support or compatibility with a particular speech engine.
