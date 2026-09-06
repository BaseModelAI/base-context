# Implementation status

Base Context is being implemented from Prime Agent **v0.9.3**, commit
`915c78f42c248b08238dd27fcd4bcab32c60beab`. This is not a certified release.

## Source correction

The supplied archive hash verifies, but its commit `9c54a35…` is v0.9.2.
The user confirmed that actual v0.9.3 takes precedence over stale spec hashes.
The three intervening commits include the native Astra Codex catalog addition.
The supplied archive remains a historical audit input, not the fork ancestor.

The exact public Sol control S is retrieved at `8fd60de83cb9b0506c7a4d1b13014e9316a151e4`.
The user-designated current legacy checkout is `a9ae11c7b6ccc85a74cb31f7996db81c89dd0e58`.
It is distinct from supplied D `ee83ff8c196f4f8341b38eea0ae2f244ba6c1ab2`.
See `baselines.json` for input identities. Original source checkouts stay unchanged.

## Work packages

| Work | Status |
|---|---|
| W0 controls, source audit, baseline build | In progress; S retrieved; npm ci, native check and all four package compilations passed |
| W1 product/state/runtime/package isolation | Own packages, state, daemon, auth/export gates and source artifacts implemented; same-home installed coexistence passed; upgrade/uninstall checks in progress |
| W2 native semantic ports | Inventory complete; generic finalized execution edge implemented and tested; session persistence/compiler integration pending |
| W3 source durability, effects, complete receipts | Not implemented |
| W4 durable task truth and SQLite evidence index | Not implemented |
| W5 bounded hot history and process memory | Not implemented |
| W6 compiler, batch recovery, evidence-local work | Not implemented |
| W7 Sol control and generic deployment | S frozen; no parity or live validation claim |
| W8 atomic checkpoints and continuation | Not implemented |
| W9 Astra policy and route-scoped advanced features | Inherited catalog only; no certification claim |
| W10 owned scheduler | Not implemented; preserve conservative child default |
| W11 non-destructive migration and recovery | Not implemented; W1 diagnostic doctor is available |
| W12 benchmark, installed artifacts and publication | Corpus unchanged; local package probes underway; runner port and release certification pending |
| W13 maintenance and upstream intake | Not implemented |

## Evaluation rules

- Sol and Astra are separate reported populations. Use medium effort.
- User override: run only 4–6 sampled tasks at early benchmark gates. Defer full
  30-task campaigns for both model classes until final goal phases.
- Each task/variant/attempt runs in isolation. Do not alter fixture or judge semantics.
- Do not select faster retries or treat unknown usage as zero.
- Confirmed provider capacity failures invalidate a run and do not affect its retry counter.
- Keep raw receipts for invalid and valid attempts; report their costs separately.
- Unsupported or untested protocol features remain disabled.

## Baseline findings

Unmodified v0.9.3 passes `npm run check` on Node 22.22.1/npm 11.19.0.
`npm ci` reports extract-zip (high), nanoid (high), and protobufjs (moderate)
advisories. Triage and any source/dependency changes are separate from this baseline.
Normal release builds must consume the checked-in model catalog, not refresh it.

Private local working data live under `.work/` (Git-excluded): frozen source bundles,
control checkouts, command logs, future run artifacts. Credentials must not enter commits.

## Native implementation checkpoint

- Connected central `ProductIdentity` and `RuntimePaths` to coding-agent config.
  New state overrides are absolute `BASE_CONTEXT_HOME` and `BASE_CONTEXT_SESSION_DIR`.
  Legacy state roots and their symlink aliases are rejected for writes.
- Kernel bootstrap uses a separate runtime distribution and managed environment.
  Missing source payloads fail locally rather than falling back to a registry runtime.
  Upstream and fork runtime distributions cannot share the selected interpreter.
- Added `npm run build:source`, compiling the checked-in catalog without discovery.
  All four source packages and the CLI bundle compile. License/notice files are staged.
- Built `base_context_runtime-0.1.0` source/wheel artifacts locally; wheel metadata
  includes fork identity and both notices. No artifact is published or certified.
- Executed 24 config/identity tests and 21 mocked-bootstrap tests successfully.
  Execution-edge tests are tracked in the port worker's implementation commit.

- Moved the connected source graph to `@ponythewhite/base-context*` version 0.1.0.
  Namespace/auth-export commit `9d455584b` is pushed to the implementation branch.
- Isolated daemon protocol, sockets, worker pipes, and writable diagnostics. Foreign
  protocol handshakes fail before commands, replacement, or cleanup.
- Kept ordinary supported API-key/bearer routes. Unvalidated OAuth login, refresh,
  and credential-use paths are unavailable, including custom and MCP registrations.
- Defaulted traces/telemetry off. Remote export requires an explicit destination and
  dedicated credentials. Legacy credential and outbox import is not automatic.
- Added diagnostic `doctor` output. It reports build identity, resolved paths and
  provider contracts. Native context is explicitly reported as not implemented.
- Source build and private pack probes passed. Extracted 0.1.0 reports the owned
  package and state paths outside the checkout. The private 0.1.1 package is only an
  upgrade fixture, not a release. Both versions include runtime source and notices.
- OAuth/MCP tests passed 179 TypeScript and 4 Python cases. Remaining identity tests
  passed 410 cases. Global checks and the source build passed. Windows pipe code
  compiles but has not run on Windows.

The installed same-home coexistence fixture passed: foreign handshake rejection sent
zero command bytes; Base doctor cleanup and shutdown left upstream responsive.
W1 remains open until installed update/uninstall fixtures finish.
The locally installed H tarballs are unmodified, but their newly resolved external
npm dependencies are not the certified frozen W0 benchmark graph. Npm lifecycle
permission was explicit for the Base Context postinstall; managed-kernel bootstrap
was disabled for this package probe. Heavy installed-kernel validation remains open.

No live provider validation, benchmark campaign, publication, or release certification
has occurred. W2 canonical session integration and W3–W13 implementation remain
pending. See `product-isolation.md` for the model-visible identity differences.
