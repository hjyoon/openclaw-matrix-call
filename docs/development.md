# Development

Use Node.js 24.16.0 and pnpm 10.28.2. OpenClaw 2026.10.2 requires Node.js `>=24.16.0 <25 || >=26.1.0`.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm check
```

The project tests the actual pinned OpenClaw SDK. Dependency installation permits only esbuild's build script; other dependency lifecycle scripts are not needed for source development. Runtime installation is validated separately against a supported Gateway.

Coverage is enforced per file at 100% for statements, branches, functions, and lines across the plugin, shared core, and worker runtime sources. Generated bundles, dependencies, tests, and build tooling are outside the runtime coverage scope. Build and package checks validate those artifacts separately.

Tests must exercise security decisions, invalid inputs, cancellation, concurrency, failure recovery, and transport boundaries. Full unit coverage does not establish Matrix calling interoperability. The release process also requires a real encrypted call with actual audio.

Build output and coverage reports are generated locally and are not committed. Explain design changes in Markdown rather than adding source comments.

`pnpm build` bundles the portable core and HTTP agent adapter under `dist/` and the native plugin under `packages/openclaw-plugin/dist/`. `pnpm verify:artifacts` loads these outputs, checks native plugin metadata, and verifies that portable bundles have no OpenClaw SDK dependency or other external package requirement. The plugin leaves public OpenClaw SDK imports external so the host supplies the tested SDK.

The OpenClaw adapter's runtime boundary is described in [ADR 0004](adr/0004-delegated-openclaw-ingress.md). Its current turns are delegated and tool-free. SDK registration tests do not establish model-backed execution or RTC audio support.

When changing the native channel configuration shape, run `pnpm schema:sync` and commit the manifest change with the source change. Artifact verification checks that `channelConfigs.matrix-call.schema` matches the runtime channel schema. This metadata lets a host validate configuration before loading plugin code.

`pnpm check` also starts the standalone worker and installs a packed plugin in a disposable OpenClaw profile. The install check accepts capabilities only inside that isolated profile; it never dispatches an agent or starts a call. Production installation remains a separate operational action.

To check the container, build `deployment/worker.Dockerfile` with the `matrix-call-worker:0.1.0-alpha.1` tag and run `pnpm verify:container`. It uses a temporary secret and removes its test container afterward. GitHub Actions runs these same standard commands; local development and other CI hosts do not require GitHub APIs or marketplace access.

For actual encrypted WebRTC audio, run `pnpm browser:install` and `pnpm verify:media`. This separate integration check starts temporary local infrastructure and sandboxed browsers; see [media integration](media-integration.md) for its evidence and scope.
