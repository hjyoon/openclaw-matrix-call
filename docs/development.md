# Development

Use Node.js 24.16.0 and pnpm 10.28.2. OpenClaw 2026.10.2 requires Node.js `>=24.16.0 <25 || >=26.1.0`.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm check
```

The project tests the actual pinned OpenClaw SDK. Dependency installation permits only esbuild's build script; other dependency lifecycle scripts are not needed for source development. Runtime installation is validated separately against a supported Gateway.

Coverage is enforced per file at 100% for statements, branches, functions, and lines across the plugin, shared core, and worker runtime sources. Generated bundles, dependencies, tests, and build tooling are outside the runtime coverage scope. Build and package checks validate those artifacts separately.

Tests must exercise security decisions, invalid inputs, cancellation, concurrency, failure recovery, and transport boundaries. Full unit coverage does not establish Element Call interoperability. The release process also requires a real encrypted call with actual audio.

Build output and coverage reports are generated locally and are not committed. Explain design changes in Markdown rather than adding source comments.

`pnpm build` bundles the portable core and HTTP agent adapter under `dist/` and the native plugin under `packages/openclaw-plugin/dist/`. `pnpm verify:artifacts` loads these outputs, checks native plugin metadata, and verifies that portable bundles have no OpenClaw SDK dependency or other external package requirement. The plugin leaves public OpenClaw SDK imports external so the host supplies the tested SDK.

The OpenClaw adapter's runtime boundary is described in [ADR 0004](adr/0004-delegated-openclaw-ingress.md). Its current turns are delegated and tool-free. SDK registration tests do not establish model-backed execution or RTC audio support.
