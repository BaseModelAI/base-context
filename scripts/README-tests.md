# Offline tests

Install locked dependencies with `npm ci`, then build checked-in source with `npm run build:source`.
Run `node scripts/test-offline.mjs` for all default offline suites, or select `agent`, `ai`, `coding-agent`, or `tui`.
Use `--shard=1/8` for one bounded file group and `--list` to print its exact files.
Run the separate coding-agent groups with `--group=kernel` and `--group=process-stress`.
CI gates every package, eight coding-agent shards, and both separate groups.

The runner creates temporary HOME and BASE_CONTEXT_HOME directories, removes inherited credentials, and blocks external Node socket connections. Loopback servers and Unix sockets are allowed. It uses Vitest for agent/ai/coding-agent and Node's test runner for TUI. Tests import this checkout; build artifacts and the Python kernel must belong to this checkout too. The coding-agent runner bootstraps its own Python environment and bundled Python skills with uv before enabling the network block, or validates and reuses `BASE_CONTEXT_KERNEL_PYTHON` when supplied. Cached uv packages and managed Python installs may be reused; credential stores are not.

Provider integration tests are listed in `scripts/test-suites.mjs` and excluded by default from the native Vitest configs. They require explicit `BASE_CONTEXT_CREDENTIAL_TESTS=1` and a specific test-file command from the package root, for example `BASE_CONTEXT_CREDENTIAL_TESTS=1 npx --no-install tsx ../../node_modules/vitest/dist/cli.js --run test/stream.test.ts` in packages/ai. These calls can spend money. They are not part of offline CI and must not run without permission. Do not use the isolated offline runner for them. The mixed coding-agent `compaction.test.ts` file keeps its 35 offline cases in the default run; its two OAuth summarization cases also require this opt-in flag and remain skipped offline. Platform-specific cases can also be skipped on other operating systems.

To reuse a prepared runtime without downloading Python or packages:

```sh
BASE_CONTEXT_KERNEL_PYTHON=/path/to/prepared/python UV_OFFLINE=1 UV_PYTHON_DOWNLOADS=never node scripts/test-offline.mjs coding-agent
```

The [native workflow cases](../packages/coding-agent/test/suite/regressions/claude-review-workflow.test.ts) exercise large Python output retention, compaction, cold reopening, exact `prime_context` recovery, preserved Python variables, and parent work during an admitted child's run. The child sends a concise report through the Python skill and normal session input delivery; its working transcript is not copied into the parent. Provider replies and local family routing are scripted. These tests check runtime behavior, not model answer quality, provider compatibility, comparative cost, or speed.
