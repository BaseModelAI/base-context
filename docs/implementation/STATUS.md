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
| W1 product/state/runtime/package isolation | Linux native isolation gate passed: own packages/state, same-home coexistence, upgrade/uninstall and installed session-write guards |
| W2 native semantic ports | Native tool/request ownership and protocol9 compatibility tested; typed turn transitions and integrated artifacts pending |
| W3 source durability, effects, complete receipts | Partial: request sinks and checked writes; framed RLM family journals and isolated writer actor implemented; daemon integration and canonical session fencing remain open |
| W4 durable task truth and SQLite evidence index | Derived metadata index passes Node22.8 and Bun-to-Node probes; canonical feed, task truth and compiler integration pending |
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
The full native update/shutdown/uninstall fixture also passed. Base upgraded from
private 0.1.0 to 0.1.1, the installed daemon coordinator launched the current version,
and native shutdown plus npm uninstall removed only Base. Upstream kept the same live
PID/generation and answered both original and fresh clients. Its settings stayed
unchanged and its absent auth file stayed absent. Active logs were not byte-compared.
Initial fixture failures were a missing dependency cache, a version-output stream
assumption, and stale fixture socket residue; none required a product-code change.

SessionManager now also checks explicit legacy destinations at open/create and final
writes, while explicit read/copy is retained. Its focused tests pass 56/56. A fresh
source build from committed `9b667a682` passed an installed SDK read/copy and symlink
write-rejection probe in a separate installation outside the checkout.

These checks close the Linux W1 isolation checkpoint, not final release certification.
The original coexistence/update artifacts identify `9d455584b` plus dirty source;
the later session-write correction was tested separately from clean `9b667a682`.
The locally installed H tarballs are unmodified, but their newly resolved external
npm dependencies are not the certified frozen W0 benchmark graph. Npm lifecycle
permission was explicit for the Base Context postinstall; managed-kernel bootstrap
was disabled for this package probe. Heavy installed-kernel validation remains open.

No scheduled model validation, benchmark campaign, publication, or release certification
has occurred. One delegated mixed test run accidentally made at least three live
Anthropic requests. It was stopped and is not counted as offline validation. Exact
physical-attempt usage and cost were not captured and remain unknown. Its existing
output is retained locally; no historical receipt is fabricated.

## Current native execution and storage work

- Native tool intent and finalized evidence share an execution ID. The session stores
  inputs once and finalized results once. Persistence runs before caller hooks and
  cannot be removed by ordinary callback reassignment. Nine focused binding tests pass.
- The common inference coordinator binds main, summary, refinement, child and control
  requests to the original source. Late receipts survive source switches and do not
  advance the conversation leaf. Built-in transports report physical attempts;
  arbitrary custom/proxy streams and provider replacements fail before a native send.
  Four coordinator tests, eleven isolated mocked AI tests and eighteen mocked Codex
  stream tests pass. These are not provider-route or pricing validation. Unknown
  usage and cost remain unknown.
- Checked journal writes handle partial progress and reject damaged tails. A failed
  source writer stays blocked pending repair. Request encoding has byte/depth limits.
  The prior 58 focused source/journal tests passed; latest request-bound cases also pass.
  Seventeen latest journal/request/flush tests pass, including first-error preservation
  when closing also fails. Canonical SessionManager framing and fencing are still missing.
- Protocol9/schema28 compatibility passes 74 focused tests. Native work and graceful
  cleanup require native ownership; older Base8 permits only proven passive inspection.
  Incompatible live workers are not reclaimed. Integrated daemon artifacts remain open.
- RLM family journals now use bounded sequence-linked checksum frames. Eight codec and
  EventLog cases pass, including explicit migration that retains the original legacy
  inode and bytes. Legacy reads remain available; writes require explicit migration.
  This does not migrate SessionManager histories or certify their existing locators.
- A dedicated Node writer actor holds a lifetime SQLite EXCLUSIVE lock beside its
  canonical family journal. The lock database contains no canonical payload and must
  never be removed or replaced while an owner is live. A tiny compiled Bun host and
  bundled Node22.8 actor passed Linux local-filesystem ownership/close/successor probes.
  That bundle predates the migration route. Two final exact-Node22.8 process tests pass,
  including migration and owner death. Four mocked daemon-wiring cases also pass.
  Windows, network filesystems and full native daemon artifacts are not certified.
- The derived SQLite index runs in a separate Node process. Node22.8 lacks FTS5, so
  the index uses ordinary SQLite postings. Two minimum-version tests pass. An actual
  Bun1.3.10 host successfully used Node22.8; missing Node fails without a Bun fallback.
  The private npm payload contains the worker. Tiny Bun-compiled hosts loaded that
  packed worker in both binary layouts using Node22.8. These are worker probes, not
  full product binary certification. Canonical writer feed and compiler remain open.

The connected source snapshot passed the combined check (998 files, installer and
browser smoke) and `npm run build:source`. Earlier private worker probes identify
`9b667a682` plus dirty source and do not certify a released artifact. Final source
builds and package probes remain separate from installed-product release validation.
Whole-history arrays, typed transitions, task truth, compiler and the remaining release
work are not complete. The inherited release workflow also needs its W12/W13 source-owned
migration before any release trigger is used. See `product-isolation.md` for model-visible
identity differences.
