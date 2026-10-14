# Optional local speech deployment

See [speech worker](speech-worker.md) for the service protocol, process limits and model integrity checks, and [integration evidence](speech-integration.md) for what has been tested.

For the optional browser deployment, start with `deployment/speech-config.example.json` and `deployment/voice-local-speech.example.json`. Copy them outside the repository, set the browser configuration's `voiceFile` to `/run/config/voice.json`, and supply an agent service implementing [agent protocol v1](agent-protocol.md). The example agent address is a placeholder; this speech image does not provide an agent runtime. Create a dedicated speech secret with `umask 077` and `openssl rand -hex 32`, distinct from the control and agent secrets. Keep configuration and credential files private on the host and readable by the configured non-root container UID.

Set `MATRIX_CALL_SPEECH_CONFIG` to the private speech JSON path and `MATRIX_CALL_SPEECH_MODEL` to the verified model file. Keep the existing browser and voice override environment variables for their private configurations and secrets. Use Docker Compose 2.24.4 or later for the documented merge tags, then validate the combined configuration:

```sh
docker compose -f deployment/browser-compose.yml \
  -f deployment/browser-voice.compose.yml \
  -f deployment/browser-local-speech.compose.yml config --quiet
```

The speech container starts first and owns the network namespace. The browser joins it after speech health succeeds. The only published port is the browser control port, mapped to host loopback through that namespace; speech port 19792 remains unexposed. The service has its own filesystem and PID namespace, only the speech secret and model mounts, a private 16 MiB temporary filesystem and explicit CPU/RAM/PID limits. `pnpm verify:speech-compose` checks the merged deployment boundaries without starting production services.

After independently provisioning and validating the Matrix profile, trusted devices and agent service, the same three-file Compose invocation with `up --build -d` starts the pair. This remains an experimental deployment configuration. A speech restart changes its audience and may change the shared namespace; restart or recreate the browser as well. The dependency restart setting covers Compose-managed restarts, not every daemon-level crash recovery. No credentials or call authority are restored by the speech worker.

For a native Gateway on the same Linux Docker host, append `deployment/browser-local-gateway.compose.yml` to explicitly use host networking for both workers. Browser control binds host loopback and speech remains loopback-only; filesystem, PID, non-root and resource restrictions remain separate. This exposes host loopback services to the workers, so select it deliberately. The [operator example](operator-setup.md#local-native-gateway-example) and [empty-profile integration](operator-compose-integration.md) cover this route, including fresh service authentication after coordinated replacement. The default shared-container namespace still needs a reachable trusted agent endpoint.
