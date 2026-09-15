# Development

See [CONTRIBUTING.md](../../../CONTRIBUTING.md) and the repository [AGENTS.md](../../../AGENTS.md) for contribution rules.

## Setup

Use Node.js `^22.12.0 || >=23.3.0` and a compatible npm version:

```bash
git clone https://github.com/BaseModelAI/base-context.git
cd base-context
npm ci
npm run build:source
node packages/coding-agent/dist/bundle/cli.js
```

To use a checkout in another project, change to that project and run the built CLI by its absolute path:

```bash
cd /path/to/project
node /absolute/path/to/base-context/packages/coding-agent/dist/bundle/cli.js
```

See [installation](installation.md) for Python bootstrap and manual runtime options.

## Product and package names

The public CLI package is `@ponythewhite/base-context`; the binary is `base-context`. The other public packages are `@ponythewhite/base-context-ai`, `@ponythewhite/base-context-agent`, and `@ponythewhite/base-context-tui`. The bundled Python distribution is `base-context-runtime`; its import remains `rlm`.

Some extension interfaces and package manifests retain the `pi` API/key. Provider identifiers such as `prime-inference` and `PRIME_API_KEY` keep their real provider meaning. Do not rename these just because the product is a fork.

## Local configuration

Global configuration lives under `~/.base-context`. Project settings and resources use `.base-context/`. `BASE_CONTEXT_HOME` selects a separate absolute global root; `BASE_CONTEXT_SESSION_DIR` controls session storage independently.

Use an isolated root for development sessions:

```bash
BASE_CONTEXT_HOME=/absolute/path/to/dev-state \
  node /absolute/path/to/base-context/packages/coding-agent/dist/bundle/cli.js
```

This separates product state. It is not a security or network sandbox.

## Daemon protocol changes

Classify daemon command, event, and response-shape changes by their compatibility impact. Follow the protocol and schema requirements in the repository instructions before changing the wire contract.

## Package assets

Use `src/config.ts` helpers for packaged assets rather than resolving them directly from `__dirname`:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

## Debugging

Daemon, worker, client, and provider diagnostic logs are under `~/.base-context/logs/`. Logs and session exports can contain private work; inspect them before sharing.

```bash
base-context status
base-context doctor
base-context doctor --fix
base-context shutdown
```

## Local checks

The repository check formats files, lints, checks types, and runs installer/browser smoke checks. It does not run the test suite:

```bash
npm run check
```

Run only the focused tests relevant to a change. From the coding-agent package:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

Use the repository's test harness and faux providers rather than live provider credentials. Benchmark reproduction is documented separately in the [benchmark guide](../../../benchmarks/python-realworld-30/REPRODUCE.md); ordinary source setup does not require a benchmark run.
