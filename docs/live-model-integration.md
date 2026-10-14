# Optional live model integration

Checked locally: 2026-10-14. This workflow tests an existing operator login in disposable infrastructure. It does not install or configure a production calling service.

## Private configuration

Use the pinned OpenClaw 2026.10.2 SDK and a supported Node version. Prepare a private directory outside the repository with mode `0700` and a regular, singly linked `model.json` file with mode `0600`, owned by the test user. The file has this shape:

```json
{
  "schemaVersion": 1,
  "model": "openai/gpt-6.1-sol",
  "settings": { "agentRuntime": { "id": "openclaw" } },
  "thinking": "high",
  "credential": {
    "type": "oauth",
    "provider": "openai",
    "access": "EXISTING_VALID_ACCESS_TOKEN",
    "refresh": "",
    "expires": 0
  }
}
```

Replace the model, model-scoped settings, thinking level and credential metadata with the existing operator configuration. `expires` is the credential's real expiry in Unix milliseconds and must be at least ten minutes in the future. Optional credential fields are `accountId` and `chatgptPlanType`. Unknown credential fields are rejected. Do not copy refresh tokens, setup descriptors or an entire auth database. Do not put credentials in shell arguments or repository files.

The existing auth store can be read with public `loadAuthProfileStoreWithoutExternalProfiles` from `openclaw/plugin-sdk/agent-runtime`; this avoids discovery/import of external credentials. Export only the selected profile's access token, expiry and necessary account metadata. The integration never writes the source store. This snapshot workflow is an optional test adapter, not a portable-core authentication requirement or a general login export format.

The helper validates the private input and writes the credential using public `saveAuthProfileStore` in a child process with isolated `HOME`, `OPENCLAW_HOME`, state and config paths. Its agent directory must remain beneath that state directory, and `copyToAgents` is false. The packed plugin and selected provider are explicitly allowed in that disposable profile. The packer alone uses the developer's normal home to resolve the pinned pnpm installation; Gateway processes do not inherit ambient provider credentials.

## Actual model and history check

Build artifacts before running:

```sh
pnpm build
MATRIX_CALL_LIVE_MODEL_FILE=/absolute/private/model.json pnpm verify:agent-live
```

The check installs the packed plugin into a fresh Gateway, sends Korean and English greetings through its signed agent endpoint, and asks the actual model to recall a randomly generated code from an earlier Korean turn. The recall request supplies only the latest message, so the prior code must come from host session history. English uses a separate conversation. Synthetic test caller proofs do not establish Matrix identity or media support.

A transparent observer verifies original signed requests and replies without constructing identity evidence or re-signing traffic. Public Gateway `sessions.list` results must identify the configured model/provider with generated output tokens. Public `chat.history` results must contain exactly the expected user and assistant turns in order. The fixture provider must receive no requests. Logs contain reply hashes/lengths, timings and safe model metadata rather than full replies or credentials. Test Gateway profiles are removed on completion; delete the input snapshot after use.

The local check used `openai/gpt-6.1-sol`, the existing `openclaw` runtime and `high` thinking. Actual greetings and cross-turn code recall passed. This is evidence of model-backed text dispatch, not yet a spoken-call or released-client result.

## Ordinary checks

`pnpm verify:live-model` uses fake credentials to check expired input, rejected refresh ownership, unexpected metadata, malformed/oversized input, symlink/hardlink rejection, private modes, isolated SDK storage and redacted preparation failures. It is included in `pnpm check`. Ordinary CI does not use an operator login or call a hosted model. Deterministic provider and encrypted Matrix checks remain independently reproducible.
