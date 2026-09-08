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
| W2 native semantic ports | Native tool/request/context ownership and protocol10 compatibility implemented; typed turn transitions and integrated artifacts pending |
| W3 source durability, effects, complete receipts | Canonical session actor, ACK-gated publication, retained request sinks and owned removal implemented; source checks, scoped integration tests and clean packaged-worker probes pass; index feed work is active |
| W4 durable task truth and SQLite evidence index | Canonical indexing, branch-scoped queries, native input/goal provenance and bounded payload recovery pass focused tests; authoritative item reduction, import trust and compiler integration remain open |
| W5 bounded hot history and process memory | Captured read lifetimes and bounded exact branch membership implemented; whole-history resident stores and paged-query work remain open |
| W6 compiler, batch recovery, evidence-local work | Captured native compiler active; model token profiles, dependency closure and selective recovery remain open |
| W7 Sol control and generic deployment | S frozen; no parity or live validation claim |
| W8 atomic checkpoints and continuation | Not implemented |
| W9 Astra policy and route-scoped advanced features | Inherited catalog only; no certification claim |
| W10 owned scheduler | Not implemented; preserve conservative child default |
| W11 non-destructive migration and recovery | Explicit journal migration/recovery and diagnostic doctor available; full archive/checkpoint migration remains open |
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

## Native execution and storage checkpoint (`70b0ae86b`)

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


## Canonical session checkpoint (`fcbc28a45`)

This checkpoint is committed and pushed. The clean source build and private packaged
worker probes pass. Index/compiler work and release certification remain open.

- SessionManager writes through an external Node actor with the canonical journal's
  SQLite lifetime lock. Append acknowledgement follows complete writes and fsync.
  File device/inode checks reject substituted files, including equal-size replacements.
- Persistent factories and mutations are asynchronous. Entries, labels, usage, source
  paths and durable input status publish only after acknowledgement. Unknown append
  outcomes block the source; explicit recovery does not replay tools or inference.
- Request sinks capture and retain the original source before asynchronous work.
  Forks use distinct owners. Asynchronous disposal drains accepted work and preserves
  persistence errors. Saved-session removal uses the same canonical lock and syncs
  the source directory before its terminal acknowledgement.
- Readers accept framed histories and explicit read-only legacy views. Migration
  retains legacy bytes. Startup no longer relocates retained sessions automatically.
  Exports drain the captured source and create their destination without overwriting.
- Protocol10/schema29 requires canonical session ownership for active work. Older
  Base8/9 connections permit only proven passive operations. Unknown or incompatible
  live workers remain fenced from cleanup.
- Registered source-owned faux streams support local native simulations. Synthetic
  usage is a projection, not billing. They do not generate physical provider receipts.
  Native CLI faux fixtures now pass with shared AI module instances; arbitrary streams remain refused.
- Existing async fixtures use no provider access or fake ownership. The full repository
  check passes: 1003 files, TypeScript, installer and browser smoke. The 115 recursion cases
  passed in two disjoint commands: 114 cases and one genuine owned-runtime case.
  This is not a single combined run or installed-product certification.
- Runtime asset copying excludes Python caches. The clean four-package set identifies
  `fcbc28a4500f670f951de9788408709c3783c04e` with `sourceDirty:false`.
  The packaged Node22.8 worker and two tiny Bun1.3.10 host layouts pass append/drain,
  exclusive ownership and owned-removal checks. No source rebuild or publication ran
  during these probes. They do not certify full binaries, npm's Node floor, installers,
  Windows or network filesystems.

Whole-history arrays, canonical index feed, task truth and the native compiler remain
unfinished. Existing test cases passed across scoped and corrective runs, not one
combined suite. The real-peer forced-cleanup fixture passes without weakening live-peer
verification. No publication, release trigger or model campaign is authorized by these
local results.


## Canonical source index checkpoint (`c83ba6219`)

- A lazy external index consumes ACKed source prefixes. It stores exact frame locators,
  verifies the target prefix before publishing coverage, and reads only new suffixes
  on ordinary updates. Missing derived data rebuilds from canonical bytes, not effects.
- SessionManager history reads capture and pin the original source, branch and sequence.
  New ACKs feed a coalesced metadata queue. Index failure does not erase canonical
  facts or turn a known append ACK into an unknown outcome. Literal history remains
  available; projected references must wait for indexed coverage.
- Task evidence retains all supplied identities and explicit relationships. Legacy
  snapshots, including empty carriers, retain earlier-loss markers. Exact misses are
  partial when imported coverage is uncertain. `Foo.txt` and `foo.txt` stay distinct.
  Pages are selective structured evidence, not exhaustive semantic requirement lists.
- Native admission captures original input before transforms, queue waits and delivery.
  Per-call goal operations record their actual actor without copying provenance into
  later usage snapshots. Generic transformed previews remain unrecorded; only exact
  native submitted fields receive user attribution. Imported envelope trust and full
  authoritative item reduction remain open.
- Bounded recovery reads exact canonical JSON fragments from one UTF8-aligned part
  per call, at most 64KiB of source data. Per-part metadata is derived in the same
  verified source transaction, not stored as a second payload copy. Branch scope and
  indexed coverage are checked before file access. Changed selected bytes or physical
  identity cause failure; unrequested bytes are not reread as a whole frame.
- Focused actor, codec, prompt/goal, index, payload and integration checks pass in
  separate commands. These are scoped component/source results, not one combined
  test invocation, a live provider run, or full-history memory certification.

The checkpoint is committed and pushed. Normal hooks pass `npm run check` (1011 files,
no fixes), TypeScript, and installer/browser smoke. The clean source build passes.
Private packages identify `c83ba62193b2fd5c324d0d68f031bd2bceb58c53` with `sourceDirty:false`
and contain no Python caches. Node22.8 and both tiny Bun host layouts pass incremental
source indexing, task attribution, branch exclusion and exact bounded payload recovery.
The first two tiny-host starts lacked fixture package metadata; only those starts were
retried after copying the actual packaged metadata. No source rebuild or publication ran.
These probes do not certify full binaries, npm's Node floor, Windows or network filesystems.
Whole-history arrays, bounded query work and the native context compiler remain unfinished.


## Captured reads and projection boundary (`8565f4c5d`)

- History reads and request receipts share one source barrier, physical snapshot and
  branch frontier. A capture remains tied to that source after a session switch.
  Running reads participate in request activity and disposal joins them.
- Exact scoped lookup and payload recovery use derived depth/ancestor jumps. Unresolved
  source links remain intact; fallback stops after 128 parent lookups and reports
  missing links, cycles or an exhausted traversal budget explicitly.
- The immutable agent context owner can return a detached message projection and an
  opaque per-request stream context. The latter goes only to the native stream owner,
  not provider arguments or options. Terminal handling joins projection cleanup and
  preserves both primary and cleanup errors. Effective stream identity is preserved.

This checkpoint is committed and pushed. Normal hooks, the full check and the clean
source build pass. Private Node22.8 and two tiny Bun host layouts pass schema6 exact
lookup and captured-history reads after a real source switch. These are packaged worker
probes, not full binary, installer, npm-floor, Windows or network-filesystem certification.
The native compiler is not enabled by this boundary alone.

## Canonical context reconstruction (`6559f4a99`)

- Schema7 manifests select the complete active branch context across bounded pages,
  with a separate latest compaction summary and an exact first-kept boundary. Unknown
  lineage and invalid boundaries fail explicitly; selection is never silent last-N.
- Schema8 related-update references restore the latest whole-source assistant usage
  aggregate and full-branch late ipython message annotations. Related payload access
  checks the relationship before reading bytes. Ordinary payload access stays branch-only.
  Candidate and response limits reject incomplete results rather than clipping them.
- The compiler uses explicit message/source-byte limits and an active revision cache.
  Output is detached from raw canonical entries. Shared conversion and complete tool-result
  ordering preserve context barriers across pages and compaction boundaries. Related
  source bytes count on each application, including cache hits.
- These aggregates are context projections, not billing or own-spend reduction. Existing
  Manager loading still rejects earlier malformed usage aggregates; the latest-ref reader
  does not certify equivalent behavior after archive eviction.
- The semantic wrapper and inference coordinator carry the same captured source through
  the opaque native stream argument. Provider calls keep their ordinary three arguments.
  Persistent AgentSession requests now use that captured compiler path, with configurable
  `canonicalContext.maxMessages` (16384) and `maxSourceBytes` (64MiB). In-memory sessions
  retain their explicit nonpersistent path; index failure is not a fallback condition.
  Native retry controls capture exact acknowledged assistant IDs for transient omission.
  Full context rebuilds reset those omissions as before; no blanket error filter is added.
- Page, search and task queries use indexed candidate scans capped at 256 plus an overflow
  sentinel. They return an exact selection or an explicit budget error. Coverage checks
  have their own bounded scans. Recursive ancestry queries are removed; one-time creation
  of ordinary derived indexes is not a bounded-startup claim.
- The retained index2, compiler2, coordinator4, native binding2, retry1, settings2,
  context-tree14, semantic2 and late-message1 cases pass in separate scoped commands.
  The native binding cases use the real loop and local faux, including real index-open
  failure without a fallback. The retry case preserves actual JSON bodies and request IDs.
  Its initial fixture tried to clone executable tool functions; only the capture was fixed.
  Corrective runs are the same cases, not added coverage. The full source check passes
  (1015 files, TypeScript, installer and browser smoke). The checkpoint is committed
  and pushed; normal hooks and the clean source build pass.
- One private package set identifies clean `6559f4a9915760e4555652bd5211808a11992eee`.
  Node22.8 and both tiny Bun1.3.10 layouts pass schema8 manifests, bounded queries,
  related payload recovery and captured compiler reads after a real session switch.
  All 18 observed workers use the current private JavaScript helpers under Node22.8
  and exit cleanly. No repack, fixture correction or runtime retry was needed.
  These are component/worker probes, not NativeAgentSession, provider-wire, full-binary,
  installer, npm-floor, Windows or network-filesystem certification.

Agent lifecycle arrays, Manager loading/storage, task truth/import trust, model budget
profiles and the remaining release gates are unfinished.
Source-byte limits are not token limits or a total process-tree memory claim. No model
campaign, publication or release trigger has run for this work.

## Release workflow migration (not executed)

The inherited release workflow now uses Base Context build commands, artifacts,
installer variables and explicitly configured destination credentials. It has only
manual dispatch. Publication defaults off and needs an explicit dispatch approval.
YAML parsing and shell syntax checking pass. No workflow, installer smoke, npm
publication, hosted release or remote upload was executed by this migration. Final
CI isolation/toolchain validation and release approvals remain open.

## Retained import qualification

A lowering-only `retained-import` qualifier now belongs to the canonical frame, not
its JSON payload. Raw legacy decoding/migration derives it from the actual operation;
explicit JSONL import qualifies all copied rows. Ordinary framed forks preserve each
row's existing qualification. Migration still preserves the original raw JSON bytes.
The existing frame checksum covers the qualifier, and schema9 rebuilds derived task
projections. Original submitted text, goal IDs, operations and relations remain visible
as unrecorded claims when imported. Imported goal controls do not activate a goal;
ordinary unqualified native framed goal resumption is unchanged.

This does not authenticate arbitrary forged unqualified framed files, direct SDK
nativeOrigin claims, or old unqualified import destinations. Absence of a qualifier is
not proof of native authorship. Seven existing cases pass in four isolated commands:
frame encoding/owner migration (3), Manager read/copy/materialization/indexed claims (1),
native import/cancellation (2), and native framed goal restart without nativeOrigin (1).
These cover local source/control behavior, not provider or kernel execution. The full
project check passes (1015 files, TypeScript, installer and browser smoke); its three
format-only changes do not alter the tested behavior. The earlier `6559f4a99` package
probes do not cover this change.

## Explicit captured history reads and reduced eager work

Persistent managers now expose separate captured branch and whole-source read scopes.
Exact hydration keeps the indexed source reference and retention outside the payload.
Iteration and detached materialization require entry and source-byte limits and refuse
incomplete results. Existing inference coordinator views remain branch-scoped. Full
Manager and Agent history arrays still remain; this is not a complete resident-memory bound.

Clone commands use leaf metadata without constructing a full tree. Initial in-process
snapshots leave the optional tree for explicit retrieval. SDK startup reuses its branch
walk. Compaction events use the saved ACK ID, including when summaries repeat. Connection
state reads use an ACK-derived compaction count instead of scanning all entries.

The benchmark runner now reports primary attempts, retains diagnostic/invalid attempts,
and does not select performance-triggered replacements. Confirmed capacity invalidations
do not consume the valid retry allowance. Missing usage and cost remain incomplete;
native physical receipts are counted once and catalog estimates are not invoices.
The inherited host/setup constraints still need migration before a model sample can run.
No model campaign has started.


## Captured branch bootstrap

Schema11 adds four source-linked setting/goal references and two exact parent-chain
bits to the existing derived context index. Lookup uses one resolved leaf and at most
four source lookups. Unknown lineage fails explicitly. Goal seedability is separate
from context-message presence. Retained model/thinking/tier behavior is unchanged;
goal selection skips retained or malformed controls using the existing predicate.

Persistent SDK startup now hydrates settings and compiles active context within the
same captured branch read. It no longer uses the live Manager context/branch builders.
Persistent goal restoration and seedability move to async initialization; tree reload
awaits goal restoration. Active-goal tool activation and prewarm policy are retained.
Explicit in-memory behavior remains separate. Bootstrap setting hydration has a source
byte budget; active context has its existing independent message/source-byte budget.
These limits are not token limits or total process-memory bounds.

Manager loading, other native metadata scans, and Agent lifecycle arrays still remain.
The frozen benchmark candidate is clean `93bfa8416`, not this later bootstrap source.
It was packed once; no repeated three-host component campaign ran. Model samples need
an OpenAI API key: the interactive bashrc-loaded setup found no configured OpenAI,
OpenRouter, Prime or Azure OpenAI key variable. Source implementation continues.


## Active working views and bounded export materialization

Native AgentSession now opts into adopting the complete canonical projection in the
Agent state and continuing loop context. Generic projections remain inference-only
unless explicitly opted in. Inference transforms get separate arrays; source callbacks,
opaque request context and release ordering remain intact. This does not bound the
complete current-invocation `newMessages`/`agent_end` output collector, which is unchanged.

Session names now use whole-source ACK-derived metadata, including empty-name clearing,
branch changes and reopening. Resident snapshots support explicit entry/serialized-JSON
limits and detached header/entry copies. Per-row retention remains outside payloads.
They preserve a supplied readonly Manager's captured view rather than rereading a later
file. HTML export uses bounded complete materialization or a bounded standalone file
capture; it never silently picks a last-N suffix.

The name cases use an immutable committed Agent dependency. Native adoption integration
uses an immutable committed export dependency while export development proceeds. These
are scoped source results, not coverage of those later dependency changes. The first
native integration happy run used a nonexistent fixture API; the actual copying state
setter corrected that same case. The original failure remains recorded.

Manager body stores and the per-invocation collector are still unbounded. No large-history
RSS, full-product binary, live-provider or release claim follows from these changes.


## Bounded parent-path and context consumers

The shared captured bootstrap reader now also reconstructs AgentSession context after
compaction and tree navigation. Persistent public context rebuilding is asynchronous;
mode snapshots and daemon context replies await it. Transient outcomes are copied before
the read and remain separate from canonical history. Explicit in-memory behavior remains.

Actual parent-path pages are separate from attached request evidence. The Manager's
capped parent-path materializer keeps each hydrated row's source metadata. Tree consumers
now use complete bounded source materialization rather than the eager tree cache.
The default tree caps are 16,384 source entries and 64 MiB. Native byte accounting counts
canonical entry frames; resident views count serialized header/entry JSON. Exceeding a
cap refuses the complete tree rather than returning a last-N subset.

Ten existing cases passed across four separate source invocations: parent-path index2,
Manager2 (including the capped wrapper), mode2, and direct context4. The later snapshot
ordering correction captures child metadata before awaiting context and reruns only its
existing affected case. No provider, kernel, packaged-product or whole-memory claim.
These changes prepare removal of persistent body stores; they do not remove them yet.


## Runtime bootstrap and streaming branch export

Schema12 adds the latest eligible RLM-depth source and an exact parent-path message-entry
bit to branch bootstrap. The RLM predicate and retained-control behavior remain unchanged;
this does not strengthen control authority. Goal and depth restoration share one capture
and a source-byte cap. Native runtime construction follows that restoration, so kernel
configuration does not capture a provisional depth. Direct Agent entry points now run the
bound native initialization callback before context snapshots and loop events. A failed
initializer does not dispatch extension events when no extension runtime was created.

JSONL export retains the existing admission drains and source-change check. The native
helper streams actual parent-path pages and one bounded record at a time, restores selected
assistant usage, and re-chains parent IDs into a fresh raw v3 header. It has no native
whole-branch accumulation or total-branch entry cap. Non-indexed sources use an explicit
bounded resident snapshot. Existing destinations are refused; failed new outputs are
removed and cleanup errors are retained. This is not an import or authority operation.

Fork-picker mode reads use complete capped source materialization rather than getEntries.
The 16,384-entry/64 MiB defaults count all source entries before filtering, including other
branches. Text order, whitespace and joined text-part behavior remain unchanged.
The synchronous AgentSession picker API, other branch/control scans, late-IPython startup
map, persistent Manager stores and current-invocation Agent output collectors remain.


## Captured compaction boundaries and asynchronous JSONL output

The existing schema12 bootstrap exposes the latest actual parent-path compaction
reference. The two asynchronous native compaction checks hydrate its timestamp in the
same captured read instead of scanning the resident branch. A single revision-keyed
scalar cache retains no entry bodies. The selected frame-byte cap also applies to cache
hits. Retained compactions and invalid-date behavior keep their existing semantics.

JSONL export now awaits directory creation, exclusive output creation, each bounded
record write, close and failed-output removal. Native source capture or the bounded
resident snapshot happens before output I/O can yield. It keeps the original source,
record ordering, backpressure and primary/cleanup errors. No whole output is buffered.

The public `AgentSession.getUserMessagesForForking()` method now returns a Promise
and uses the same complete, capped source reader as the mode interfaces.

Persistent Manager body stores, synchronous context-usage scans, late-IPython startup
history/maps and complete current-invocation Agent output collectors still remain.
These changes are not a whole-process memory bound or a model/release result.
