# HTTP authentication

Internal HTTP integrations use a dedicated random 32-byte secret encoded as 64 lowercase hexadecimal characters. Generate it outside the repository. Never reuse a Matrix access token or an agent host's operator token.

The four authentication headers contain a millisecond timestamp, a random UUID nonce, a target-process audience UUID, and a lowercase hexadecimal HMAC-SHA256 signature. The signed UTF-8 JSON array is `["matrix-call/1", audience, method, path, timestamp, nonce, bodySha256]`. The body digest covers the exact UTF-8 body bytes. The path includes the query string when present.

Each server process must generate a fresh audience UUID at startup and provide it through its capability/health endpoint. Configure the client with that audience before signing. Do not persist or reuse the audience after a restart; this prevents replay into a new process whose in-memory nonce cache is empty.

The default acceptance window is 30 seconds in either direction. Nonces remain protected through the entire window. At replay-cache capacity the verifier rejects new requests instead of evicting live nonces. Expired entries are removed when a valid request is checked.

Use HTTPS outside a private local connection. Authentication does not encrypt transcripts or establish Matrix participant identity. Only a trusted transport verifier may supply identity evidence. Sign responses using `RESPONSE_<status>` as the method and the original request path when an integration requires response authentication.
