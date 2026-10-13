# Development worker

The current worker implements an authenticated control plane and process lifecycle. It does not implement MatrixRTC or legacy VoIP media. Its liveness endpoint returns HTTP 200, readiness returns HTTP 503, and an authenticated call request returns HTTP 501. These results prevent a container health check from being mistaken for a working call.

The worker bundles standard Node.js and portable core code. It has no OpenClaw SDK, hosted AI account, Gateway operator token, or Matrix device state. Agent and transport integrations will be configured explicitly when implemented.

## Native execution

Build with `pnpm build`, create a dedicated random 32-byte hexadecimal secret outside the repository, and protect the secret file. Set `MATRIX_CALL_SECRET_FILE` to its absolute path, then run `node dist/worker/worker.mjs`.

`MATRIX_CALL_HOST` defaults to `127.0.0.1` and accepts an IP address. `MATRIX_CALL_PORT` defaults to `19790`; zero selects an ephemeral port for development. The startup event prints the actual listening port and readiness status without credentials.

SIGINT and SIGTERM close connections and remove process signal handlers. A malformed secret or a bind failure stops startup. The worker neither creates a Matrix account nor sends Matrix messages.

## Control endpoints

- `GET /healthz`: non-secret process audience, protocol version, liveness, and implemented transport list.
- `GET /readyz`: unavailable until a compatible secure transport is implemented.
- `POST /v1/calls`: dedicated-secret request authentication, replay checks, and a signed unavailable result.

Control requests are limited to 65,536 bytes with strict UTF-8 decoding. Default responses omit internal exception details. Use the fresh process audience from health when creating an authenticated client, as described in [HTTP authentication](http-authentication.md).
