# Contributing

## Requirements

- Node.js >= 22.19.0
- The `pi` CLI on `PATH` for the end-to-end test (`npm install -g @earendil-works/pi-coding-agent`)

## Setup

```bash
npm install
```

## Tests

```bash
npm test          # unit tests with coverage (fails below 60% lines/branches/functions/statements)
npm run test:watch
npm run test:e2e  # runs the real pi CLI against a local fake OpenAI-compatible endpoint
```

The unit tests stub the host packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) through `resolve.alias` in `vitest.config.ts`, so they run without installing the pi-ai dependency tree. Host-package types are imported type-only in `index.ts`.

The e2e test (`test/run-e2e.sh`) starts `test/fake-openai-server.mjs`, which returns `402 Insufficient Balance` for `sk-bad`, `429` for `sk-rate`, and a valid SSE completion otherwise. It then runs `pi -p` in a throwaway agent dir and asserts that a dead key is retried with the next one.

CI runs both jobs on every push and pull request (`.github/workflows/ci.yml`).

## Releasing

The first version is published by hand; later versions publish from CI using npm **trusted publishing** (OIDC). No token is stored anywhere.

The npm package is scoped: **`@snorfyang/pi-switch`** (the unscoped name `pi-switch` is rejected as too similar to `piswitch`).

### First publish (creates the package on npm)

```bash
npm login
npm publish --access public --otp=<code>
```

### Configure trusted publishing (once)

On npmjs.com go to the package → **Settings → Trusted Publisher → GitHub Actions** and fill in:

- Organization or user: `snorfyang`
- Repository: `pi-switch`
- Workflow filename: `publish.yml`

### Later releases

```bash
npm version patch        # bumps package.json, commits, tags vX.Y.Z
git push --follow-tags   # triggers .github/workflows/publish.yml
```

The workflow re-runs the tests, checks the tag matches `package.json`, and runs `npm publish --access public`. Trusted publishing generates provenance automatically and requires only `id-token: write`.

Pi discovers the published package through the `pi-package` keyword in `package.json`.

## Layout

```
index.ts                     the extension (storage, rotation, login menu, provider wrapper)
test/unit/                   vitest unit tests
test/stubs/                  minimal stubs for the host pi packages
test/fake-openai-server.mjs  fake endpoint used by the e2e test
test/run-e2e.sh              end-to-end test
vitest.config.ts             test + coverage config
```

## Adding a provider

DeepSeek is currently the only supported provider. The storage format and the code are provider-agnostic; `PROVIDERS` in `index.ts` is the list of providers that get wrapped on `session_start`, and the login menu uses each provider's own display name. Adding a provider is a matter of appending its id to `PROVIDERS` once its auth shape is verified.

Only providers that authenticate with a header / API key at request time are supported. OAuth-based providers need extra work.

## Style

- Keep changes provider-agnostic: no provider names in code paths, UI strings, or file names.
- Add or update tests with behavior changes; keep coverage above the configured threshold.
- Commits use `type: summary` (for example `fix:`, `feat:`, `docs:`, `test:`, `ci:`).
