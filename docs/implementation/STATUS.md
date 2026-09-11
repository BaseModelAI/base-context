# Implementation status

Base Context is being implemented from Prime Agent **v0.9.3**, commit
`915c78f42c248b08238dd27fcd4bcab32c60beab`. This is not a certified release.

## Current focus: full benchmarks and remaining spec details

The five benchmark prerequisites work on the supported source paths. Scope is now
open to the remaining `SPEC_DEVIATIONS.md` backlog. Full isolated LOW comparisons
for exact `gpt-5.6-sol` and `gpt-6-astra` use the existing ChatGPT subscription before
any MEDIUM comparisons. Timed runs keep their frozen packages and scripts; source
integration, checks and builds happen between runner invocations.

W28 added native/Python recovery, complete compiler dependency closure, same-source
compaction commits and service budget forwarding. W29 adds actual plain-text Responses
selection at the final serialized request boundary. One payload hook runs before selection;
a captured explicit token evaluator is shared across the awaited checkpoint ACK and send.

The same canonical compaction owner commits qualified source-backed epoch recipes, frozen
TaskFrames and representation identity before adoption or dispatch. Close/reopen reconstructs
the same selected content. Actual service requests retain earlier prefix items and remain
usable after an ordinary summary consumes the selected historical views. Native recovery
qualification follows the real selected executor and authorized reader, not public markers.
Retained copies do not retain native recovery admission. Ownership/RPC schema32 fences older
readers; protocol11 and existing cleanup policy remain unchanged.

W29's focused checks, full source check, build and push are settled. The W30 results below
come from later invocations on the current source; repeats are not additional cases.

W30 extends those working paths:

- Official Responses/Codex conversion captures its actual one-to-many tool/message mapping.
  Only established replay groups allow selection; generated unsigned-ID layouts stay complete.
  Codex assesses the full logical body before constructing a cached delta.
- A previously pinned historical assistant can become optional at the next ACKed boundary.
  Ordinary summaries retain genuine recovery and its complete replay group in the same ACK.
  These summary controls are unmeasured, not fabricated provider assessments.
- Explicit copy/fork/import activation rebuilds source recipes and TaskFrames on the destination
  before adoption. Imports lose copied replay permission and retain lowered task authority.
  Original summary usage stays on the copied record; the rebuild control does not duplicate it.
- Ownership/RPC schema33 fences these readers. Protocol11 remains unchanged.

Fourteen distinct existing focused cases have passing W30 outcomes across separate compiler2,
services2, selector2, native/Python2, compaction4 and RPC2 scopes. Type checking passed. The
service path covers genuine recovery, budget-driven eviction, ordinary-summary retention,
same-file reopen and the next native request. The compiler cases also exercise real copy/fork/
import activation, lowered TaskFrames, native fake-fetch continuation from copied summaries,
and known-ACK cleanup failure. Python and canonical storage are real; transports are local fakes.
Earlier failures and repeats remain recorded: live tool executor cloning, an unnecessary
per-send epoch-count assumption, an absent lowered TaskFrame fixture, and three type diagnostics.
These results do not certify installed packages, provider behavior or a whole-process memory bound.

W31 adds two working paths under the same owner:

- An actual official Responses/Codex projection can grant a fresh public window only for its
  unchanged stateless request descriptor and closed groups. Exact actual routes are checked;
  external continuation/conversation state and unsupported routes do not inherit permission.
- At an explicit ordinary-summary boundary, v3 recipes render retained assistant/tool public
  data, including the captured old tail. Canonical opaque originals stay unchanged. No public
  text is substituted into signatures or encrypted fields. User roles remain intact. The next
  native request still needs its actual final-body budget/projection and epoch acceptance.
- Native fork/import rebuilds the public cutoff and references on the destination, without
  copying permission or charging original summary usage again.
- Managed context captures actual owned kernel instance/generation/state once. Its bounded
  tool-data view is stable when unchanged. Changed state requires a new ACK; a stale held
  capture refuses before send without a synthesized assistant. Saved/imported markers are
  not current liveness. Native readers are bound before replacement callbacks. Managed
  summaries skip the old namespace probe/survival message. Generic no-budget/no-epoch output
  remains unchanged. Ownership/RPC schema34 fences these v3 readers; protocol11 is unchanged.

Fourteen distinct existing W31 cases pass across separate compiler2/services2/selector2/
native-Python2/compaction4/RPC2 invocations, and type checking passes. The service path includes
actual parsed opaque tail -> public summary -> reopen -> native fork/import -> native send,
with six main fake responses and one summary. The kernel path uses real Python startup,
stability, restart, shutdown and a new owner after reopen, plus stale-capture refusal. The
Codex adapter path separately checks fresh full dispatch after prefix loss with no old pointer,
opaque data or token credit. It does not stand in for the service renderer path.

The first selector edge had a wrong official-route fixture expectation. Type checking found
an inferred rendering-string union and a missing fake fixture key. Those diagnostics are
retained; only selector2/types were repeated after correction. No production counter or
permission was weakened. W29 and W30 receipts remain settled and were not rerun.

Cached-prefix units still cannot use stale token credit. Unaccepted recovery groups, unsupported
media/routes/native modes and opaque input without a permitted transition remain explicit
refusals. This milestone adds explicit public summary transitions, not an automatic response to
every prefix-loss or unknown-budget state. That continuation boundary remains in the five-feature
backlog. Configured profiles and offline paths do not certify deployment limits or login state;
no live pre-probe is required to implement the remaining source path. No provider cache-hit,
live token accuracy, pricing, installed runtime or whole-harness certification is claimed.

No live benchmark or readiness probe is allowed before all five features work.
After that gate, the latest user order is all 30 isolated tasks at low effort,
then medium effort, using the same session ChatGPT subscription. Publication
still requires approval.

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
| W6 compiler, batch recovery, evidence-local work | Native TaskFrames, dependency closure, bounded recovery and explicit request budgets work in focused paths; Codex/tool selection and complete retention remain open |
| W7 Sol control and generic deployment | S frozen; no parity or live validation claim |
| W8 atomic checkpoints and continuation | Qualified same-source epochs commit before native text requests and reconstruct on reopen; full replay/resource and cross-source boundaries remain open |
| W9 Astra policy and route-scoped advanced features | Inherited catalog only; no certification claim |
| W10 owned scheduler | Not implemented; preserve conservative child default |
| W11 non-destructive migration and recovery | Explicit journal migration/recovery and diagnostic doctor available; full archive/checkpoint migration remains open |
| W12 benchmark, installed artifacts and publication | Corpus unchanged; local package probes underway; runner port and release certification pending |
| W13 maintenance and upstream intake | Not implemented |

## Evaluation rules

- Sol and Astra are separate reported populations.
- Latest user override: no live samples before the five prerequisites work. Then run
  all 30 isolated tasks at low effort first, followed by medium effort, using this
  session's same ChatGPT subscription.
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

## Initialization joins graceful teardown

Graceful session disposal now joins an already accepted standalone initialization
before disposing child, kernel and runtime resources. Initialization keeps reporting
its own error through its original promise; later disposal does not re-raise an old
initialization failure. New initialization calls during or after disposal are refused.
The synchronous disposal surface keeps its existing weaker contract.

Current-version copy/import now reuses the destination entry array while reading the
journal, instead of retaining a separate source array. Usage restoration and relinking
through dropped git facts still run after the source read. Legacy migration and row
retention remain unchanged. The existing single-stream reader has no fixed byte-frontier
capture guarantee. Destination entries/maps and dropped-parent metadata remain resident;
this change does not establish a total copy-memory or startup-memory bound.

## Captured context-usage availability

Schema13 records a source reference to the latest eligible parent-path assistant since
compaction. Aborted/error assistants do not replace it; a zero-usage assistant does.
The native availability check reads that assistant and its authorized latest aggregate
within one capture. Its scalar cache retains no bodies and charges source bytes on hits.
Working-view token estimates and model metadata are captured before the read yields.
These estimates keep their existing semantics; they are not model-aware token limits.

Native context usage, session stats, context trees and compact host responses are now
asynchronous. Extension context usage is asynchronous too, without waiting on native
initialization from inside an extension lifecycle callback. Mode responses contain plain
values, not Promises. Snapshot and live-child reads drain their accepted work and retain
errors; metadata is captured before the new awaits. Example border rendering stays
synchronous and refreshes its usage outside render.

Context-tree spend and completed-child loading still use their existing eager readers.
Persistent Manager stores and current-invocation Agent collectors are not removed here.

## Bounded context-tree usage and asynchronous standalone HTML input

Persistent native context trees now obtain own/total usage from one captured, complete
source materialization and its exact parent path. The default limits are 16,384 source
entries and 64 MiB. Existing ordered usage restoration and subtraction are reused.
The native adapter starts this read with context availability and live-child reads,
then joins all accepted work. Explicit in-memory behavior remains unchanged.
Completed-child disk reads and whole-file own-usage summaries still use eager readers.

Standalone HTML input uses awaited file-handle reads while keeping its fixed initial
length, bounded read chunks and change detection. Limits/options are copied before
awaiting I/O. Parsing, migration and usage restoration keep their previous behavior.
Read and close failures are both retained. Native/resident HTML selection and output
writing are unchanged. Neither change removes the persistent Manager body stores.

## Captured whole-source usage summaries

Native own-usage summaries now read one complete captured source, limited to
16,384 entries and 64 MiB. The reader restores stored child aggregates and applies
the existing whole-source subtraction; in-memory behavior remains unchanged.
The count/tail-ID memo is replaced by one captured source-prefix scalar cache;
cache hits respect the recorded entry/byte costs and return detached summaries. This is not a pricing change or a bound on the
Manager's retained stores. The native compaction case passed with an eager-getter
refusal and an exact source-callback rejection, using committed daemon-source
overlays. It does not certify the later daemon consumer ports. A separate existing list
happy/edge invocation passed on the final mode sources. Metadata-only passivation,
observation and heartbeat views do not read usage. Actual wire/list/roster usage
reads are awaited, with captured metadata and joined accepted reads. Roster fixture
await ports are typechecked; the roster suite was not run.


## Indexed owned Manager and native history consumers

Current-version framed owned Managers now retain header/source metadata and ACK scalars,
not the historical entry array or ID/label maps. Startup, reopen, recovery, migration and
copy destinations activate the indexed path. Explicit in-memory and read-only views remain
resident. Native-facing extension types expose asynchronous entry, branch, source, tree,
label and tool-exchange readers. Complete reads use explicit entry/source-byte limits and
refuse oversized or unresolved results instead of returning a tail. The index remains
derived state, not a second authoritative message store.

Writes allocate/check IDs and resolve parents/targets in their captured queue position.
Child-attribution callers receive the aggregate from the same acknowledged append.
Metadata is prepared before the write and folded after ACK; disposable index refresh
does not turn a known ACK into an unknown outcome. Concurrent identical request phases
are checked inside their queue, and status getters return detached metadata. Header
read/close failures retain both errors.
Native late-IPython delivery uses exact captured parent-path references, including the
period before a tool result exists, and an atomic first-ID append. Working-message updates
and delivery events follow the append ACK; native startup no longer restores a historical
late-message map. Raw history hydration and imported authority classification are unchanged.

Native compaction, navigation and refinement use captured readers. Navigation reads both
parent paths from one capture and keeps the read in its existing cancellation/disposal
lifetime. Retry and child-usage correlation uses acknowledged IDs or scalar correlations on
actual compiled assistant objects, not historical object identity. These correlations do
not grant source authority. Startup can request settings/presence without compiling bodies.
Prepared forks bind one source before hooks and release the reader before preparation
settles; hook failure/cancellation takes precedence and creation never recaptures history.
Footer rendering stays synchronous and uses post-ACK lifecycle refreshes.

Sixteen distinct existing cases passed across separate source invocations: index2,
Manager2, runtime2, compiler2, native binding2, late-IPython1, compaction1, navigation2 and
refinement2. The compiler cases first used an immutable W18 Manager overlay, then repeated
against the activated backend; these are not four distinct cases. The native compaction
case initially failed, then two same-case diagnostics showed that automatic refinement
consumed its fifth queued faux response. The manual-compaction fixture now explicitly
disables that unrelated background feature. Its original assertions and the subsequent
prompt pass; production refinement behavior was not disabled. A later Manager repeat
passed its edge case but failed a new fixture assertion that incorrectly expected
physical-attempt receipts from genuine local-faux simulation. The correction uses a
clearly labelled offline admission fixture through the real bound source and owner;
it does not claim a provider send or settlement. That same happy case passed after
the correction, separately from the earlier edge pass. All failure logs remain.
No external-provider, kernel, emitted-artifact or whole-memory campaign was run here.

Current-invocation Agent collectors, completed-child disk readers and global refinement
history still have separate residency work. Full-operation snapshots remain capped
materializations. These changes do not establish the declared large-history RSS gates,
whole-process memory bounds, model billing or the remaining authority/compiler requirements.

### Bounded disk and global refinement history; native storage scale slice (W20)

Completed-child context-tree reads now use fixed, asynchronous file captures capped at
16,384 non-header records and 64 MiB per file. Ordered usage restoration, off-branch
attribution subtraction and last-physical-row ancestry remain unchanged. Disk reads still
ignore incomplete final records, including undecodable tail bytes. HTML keeps its distinct
whole-image UTF-8 and migration behavior. Each child reduces its history to node metadata
before descending; AgentSession joins all accepted disk and live reads before returning.
These are per-file bounds, not a bound on concurrent files, total descendants or tree output.

Global refinement JSONL reads use the same fixed-image I/O with separate parsing rules:
valid unterminated final rows remain eligible, malformed rows remain skipped, and every
nonblank source row counts toward the 16,384-row limit before parsing. Complete source
bytes are capped at 64 MiB. Appends capture JSON before awaiting and use a 32-item/64-MiB
encoded-byte FIFO in this process. Existing refinement application/disposal now awaits the
append. No new store or cross-process transaction was added. Serialization's transient
allocation and the separate synchronous harness_state.json remain outside these bounds.

Nine distinct existing cases passed across separate invocations: disk tree2, native tree1,
global history2, native refinement2 and HTML2. The native tree and first HTML cases each
needed a fixture port after indexed Manager activation: malformed imports now refuse at
startup, and native branch changes must be awaited. Their initial failures and same-case
retries remain separate evidence. No provider or kernel call was made by these scopes.

The native storage-only measurement used checkpoint 473c85ffcf51d80adf742e5eecebdbd34f8eb53d.
Each declared 10k/100k/1m source-event fixture has 512-byte user bodies, 10/100/1000 off-branch
siblings and native compaction markers. These are context-marker epochs, not model calls
or physical working-set rotations. Each fresh measurement opens/indexes once, then runs
64 ordinary appends and 64 exact reads capped at 64 KiB; all 64 reads found their targets.
One warmup append means each resulting source contains its seed count plus 65 events.

| Seed events | Cold open/index s | Append p95 ms | Exact read p95 ms | Sampled group peak MiB | Warm group peak MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 1.217 | 5.073 | 1.456 | 345.53 | 345.53 |
| 100,000 | 11.524 | 5.946 | 1.018 | 369.35 | 358.32 |
| 1,000,000 | 120.943 | 11.841 | 1.806 | 404.59 | 365.71 |

Hardware: Linux 7.0.0-30-generic, x64, Intel Core Ultra 9 275HX, 24 logical CPUs,
202,005,540,864 bytes reported RAM, Node 22.8.0. The 100 ms sampler sums the main process,
owner/index workers and source-loader processes: six processes at the sampled peaks.
This is summed RSS, not PSS or a guaranteed absolute peak; observer RSS is separate.
The larger runs use an immutable source/emitted checkpoint copy so current implementation
work cannot change their inputs. Timings are descriptive, not latency acceptance thresholds.

Source and index files grow with history: the 1m source was about 884 MB and the SQLite
index about 5.18 GB, plus 5.21 GB WAL measured before close. Warm operations use indexed
points and suffix catch-up rather than full-history materialization. Observed storage RSS
did not grow proportionally to this fixture's retained history. This does not certify the
whole-harness gate: Agent invocation collectors, daemon/kernel/provider working sets,
queued/subscriber data and remaining configuration-state residency still need work.
No numeric RSS/growth/latency pass threshold was invented, and no model benchmark ran.

### Persisted harness state bounds (W21)

The TypeScript host and owned Python runtime now cap each harness_state.json image at
64 MiB and 16,384 combined owned prompt/memory/skill/subagent records plus refinement
items. Reads use one descriptor, a fixed accepted size and at most 64-KiB read requests.
Limits are copied/validated before use. No entries, metadata, event IDs or history tails
are trimmed. The existing schema and language-specific normalization stay unchanged.

Oversize state refuses rather than becoming an empty snapshot that a later save could
overwrite. This refusal can stop synchronous prompt construction or refinement. Ordinary
missing, unreadable, corrupt and non-object files within the budget retain their empty-state
fallback. A byte-limit refusal still escapes if descriptor cleanup also fails.

Both writers check the encoded image before file effects. TypeScript keeps its atomic
rename, existing mode and temporary-file cleanup. Python keeps its in-place writer and
platform newline formatting. Python owned CRUD/event calls undo only a refused budget
mutation, preserving existing object identities, map order and length-based event IDs;
ordinary I/O and serialization failure behavior is not made transactional.

Four distinct existing cases passed across two separate language invocations: one persistence
and one corrupt/non-object case each. The persistence cases also cover exact byte/item caps,
unchanged files on refusal, and Python cached mutation/ID handling. The first Python launch
stopped before imports/tests because bwrap added PWD; the corrected inner six-key env-i
launch passed. This setup failure is not a runtime test failure or an additional case.

These are per-store accepted image/item bounds, not a whole-process memory result. JSON
parsing, serialization/asdict transients, Python in-memory stores, public container mutation,
merged store copies and the aggregate Python path cache remain outside this slice. The APIs
accept explicit higher positive limits; no new CLI setting or retention policy was added.

### Native invocation output and refusal-aware compatibility (W22)

Owned persistent sessions now collect complete detached finalized invocation values under
constructor-copied invocationOutput settings: 16,384 messages and 64 MiB UTF-8 JSON array
by default, with an explicit SDK override. Generic Agents and explicit resident Managers
keep their previous behavior. Source-frame/context limits remain separate.

The native listener joins its exact message_end mutation/persistence job. Original runtime,
action and ACK subjects remain in place. Goal usage accounting still progresses before a
delayed extension returns. Current-invocation child-usage/IPython updates are charged and
one accepted terminal boundary is drained; future child lifetimes are not awaited. Update
admission closes and slot ownership detaches at termination. Returned snapshots are not
retroactively changed by later canonical updates.

Over-limit completion emits a small agent_end refusal without messages and rejects the
raw loop, stream result and Agent invocation. It does not return a truncated/empty success,
fabricate a replacement assistant bundle, retry the provider or revoke known delivery/tool
ACKs. Accepted parallel tools/publications settle; unstarted sequential calls stop. Native
consumers report failure rather than advancing plans or treating idle as success.

The existing daemon/worker fence advances to protocol11/schema30; Base8/9/10 remain
passive-only. RPC additionally requires --rpc-protocol-version 11 before startup and RpcClient checks protocolVersion in get_state before work.
This explicitly breaks unversioned RPC launch/server-entry calls. It preserves prompt
acceptance ACK semantics; promptAndWait rejects later refusal. The fence covers shipped
clients, not a custom client that falsely declares the new contract. Reverse RPC startup
mismatch cleanup has source inspection only, not a physical-client test claim.

Sixteen distinct cases passed across five separate invocations: existing generic2,
owned core2, native default/goal2, settings2/Herdr1, new minimal RPC completion2 and
existing compatibility5. Core transport data and RPC completion events are synthetic;
Herdr uses a local Unix fixture. Native cases use module-owned local faux. No physical
provider, kernel, installed-client or whole-memory campaign ran. An unsupported findLast
TypeScript library use was corrected without changing the configured library. An external
fixture hunk accidentally removed adjacent parameterized cases; Root preserved their exact
original block before applying/running it. The loop file still instantiates35 cases.

These bounds cover owned invocation result values, not EventStream/RPC/subscriber queues,
provider partials, all tool-batch intermediates, caller-retained values or process RSS. The
separate whole context-tree request draft is not part of this checkpoint. Task authority,
explicit task reduction, ViewUnits/token budgets/epochs and release gates remain open.

### Whole context-tree request bounds (W23)

One copied request now admits at most256 nodes,4MiB of encoded metadata and16,384
visited directory entries by default. Per-history16,384-entry/64MiB limits remain.
Node admission counts readable header-only candidates even when no node is returned;
registered no-history runs retain their placeholders. All visited directory names count,
including irrelevant names. Paths, skip IDs and admitted node/source/usage metadata
are charged before retention. Directory enumeration streams names and preserves the
previous lexical/mtime order. Oversize requests refuse rather than returning a prefix.

Native source captures enter immediately; one request-local slot covers complete
materialization, ordered attribution projection, parent-path pages and scalar reduction.
Resident snapshots reduce synchronously during the pre-await live walk. Disk image
capture starts inside the slot after file-path selection. The slot releases before
recursion. Root/live/disk accepted reads drain on admission or read failure, preserving
single-error identity and ordered multiple errors. Tree availability uses the same
captured reduction and keeps the selected canonical-context byte admission; public
getContextUsage remains unchanged.

Two existing cases passed in one isolated invocation (PID3130728,5.038266504s): recursive
disk usage/copied limits/refusals, and native pre-compaction totals with a completed disk
child, same-source availability, shared full-reduction scheduling and accepted-read drain.
The scheduling phase enters two real native captures while only one materialization has
started and decoded entries remain held inside parentPath. A separate actual AS phase
holds accepted disk work while the root read fails; rejection waits for disk completion.
No live-run Map injection, prompt/provider/kernel call or process-memory measurement ran.
Typecheck3130733 passed. Initial targeted formatter3130576 formatted3files but refused one
unused emptyUsage import; Root removed that import after source-reading jobs settled.

These are per-request encoded/work limits, not exact serialized tree size, transient
JSON/heap bounds, concurrent-request limits, index-sync limits or whole-process bounds.
Task authority/reduction, ViewUnits/token budgets/epochs and release gates remain open.

### Qualified native task admission and bounded reduction (W24)

Native input/goal admission now binds the current Manager writer before waits. Origin
fields are copied then; the actual finalized message/normalized goal is appended after
callbacks. Original action/record, cancellation and ACK identities remain unchanged.
Only message_end mints a message append callback. Raw public append APIs keep accepting
descriptive nativeOrigin JSON but cannot mint native qualification.

The owner stamps qualification:"native-admission" in the existing canonical frame via
an internal admitted-append verb. Frame/source readers, captured hydration, resident
metadata, native forks and copies retain it outside unchanged payload JSON. Retained
imports still lower authority. Record-body limits are unchanged; frame allowance is
record bytes+320. Existing exact-prefix/verb rejection is not a universal old-binary
fence: old remove mode does not decode, and hostile same-process/same-UID code is not
isolated by internal module symbols. No new journal, authority store or crypto scheme.

Derived index schema15 rebuilds old task promotions. Positive task authority requires
qualified native admission as well as the expected control shape. Unqualified/old claims
retain exact fields/text/IDs/relations and claimed authority as proposals. Descriptive
goal control attribution remains descriptive. Existing legacy goal-resume behavior is
unchanged; this is a task-projection repair, not completion of every import/execution gate.

SessionManager.readTaskState now provides a complete bounded captured structured branch
reduction: default16,384 projection/edge items,64MiB distinct source frames and64MiB each
for admitted projection/result encodings. Oversized inline evidence is hydrated within
the same captured read. Literal identities are separate from text. Only explicit qualified
relations/operations retire an unambiguous target; missing/ambiguous targets and proposals
do not remove requirements. Native goal completion/clear affects that exact goal only.
Import coverage stays explicit; structuredOnly/selective are not exhaustive semantic
extraction claims. No active-state SQL table, second task store or global cache was added.

The existing native ownership floor and advertised daemon schema advance together to31;
protocol11 and capability names remain. New clients refuse old11/30 owners; supervisor
preservation/cleanup policy remains. RPC get_state advertises schemaRevision and startup
requires at least31 in addition to protocol11, using the existing failure cleanup path.
The --rpc-protocol-version 11 flag remains a separate flag/value pair; no new launch flag.

Twelve distinct focused cases passed across separate invocations and corrected repeats:
reducer/reader2, existing index2/codec2, native goal2/input1 and RPC2/daemon1. Actual native
input keeps submitted text "hi" while its callback-expanded body is stored; descriptive
runtime completion closes its exact qualified goal. RPC uses a real Node mock-server
process, not an installed CLI or provider. Local-faux/faux-ipython-tool cases do not run a
kernel or physical provider. Detailed commands/PIDs are in .work/namespace-state.json.
The initial index fixture incorrectly expected indexedThrough5 after rebuilding to12;
Root corrected the expected frontier from the actual task snapshot without changing
entry equality. Two RPC cases initially failed because the mock script template consumed
its newline escape; String.raw corrected that fixture. Neither was a production failure.

Subscription auth/benchmark adapters remain separate external work, not part of W24.
ViewUnits/model-token budgets/epochs/recovery, remaining coordinator/whole-process bounds,
real isolated medium-effort campaigns and approved release remain unfinished.

### Existing subscription authorization and benchmark adapters (W25)

AuthStorage.fromStorage can explicitly reuse an existing OpenAI Codex login through a
read-only backend. This instance-only option does not validate copied OAuth clients or
enable login/refresh. It rejects writes, API-key overrides, stale/expired credentials and
fallback. ModelRegistry permits only the existing Codex provider/API and official backend
URLs; custom auth headers/config and provider/protocol/endpoint aliases stay rejected.
The owned dispatcher and physical-attempt recording are unchanged.

The native/H runner now injects that backend through each package's existing SDK/runtime
and RPC APIs. The selected auth file is mounted read-only only in the trusted outer
process. The backend filters out refresh tokens and unrelated providers. Candidate Bash,
service and judge execution use separate filesystem/PID/environment views. The shared
Python sandbox keeps workspace access while excluding a dummy host-only file in the
focused test. This is not isolation of trusted in-process extensions. The required
run_codex service-helper signature port does not authorize its separate auth-copy route.

Legacy assistant/plugin observations cannot establish physical-attempt totals under
hidden retries. Their known fields remain separate observations; physical count/usage/cost
stay unknown/incomplete. Native receipts retain identity-based deduplication and capacity
authority; assistant error text cannot override a native receipt. Exact legacy capacity
errors remain recognized. First valid primary and capacity-independent retry limits remain.

Four distinct existing focused cases passed: auth2 and benchmark2. Repeats are separate;
the sandbox assertion initially landed in an unselected neighboring case, so that repeat
did not execute it. It was moved into the selected happy case, which then passed with a
real nested sandbox. No real credentials, provider calls, installed SDK/RPC startup or
kernel ran. The benchmark directory is excluded from Biome; its two new JS scripts passed
Node syntax checks, not runtime tests. Frozen D/S adapter drafts remain external and
unexecuted. Actual subscription freshness/entitlement and all campaigns remain untested.

### TaskFrame provider rendering and ViewUnit metadata (W26)

The native canonical compiler now reads structured task state through its existing
captured branch view. It reuses bounded source hydration without Manager recapture or
whole-source widening. Exact qualified requirements, recorded facts and recovery roots
produce a selective task frame; raw claims are not promoted. Missing information and
resource liveness are not invented. Rendered user text stays unrecorded because callbacks
can expand it; the separately captured original submitted clause retains its authority.

Task-frame defaults are16KiB complete rendered messages,32 displayed references and2KiB
exact-clause text. Large clauses remain referenced, not sliced. These are byte/item caps,
not model-token budgets. Task evidence is additionally source-byte charged and its read
item limit follows the copied canonical message limit. A failed read or exhausted frame
budget refuses rather than using cached authority or silently dropping literal history.

The base and prior revisions retain their text and source-entry insertion positions.
New material changes append sparse revisions near the current input. Actual omitted
assistant IDs are excluded when choosing anchors; later omissions use the prior source
gap. Existing source/branch/compaction boundaries rebuild the frame. This supports stable
prefix layout, but is not the full policy/model/tool-schema epoch transaction yet.

The native SDK converter renders hidden task_frame custom messages as user-role data,
without canonical append or message events. Generic/custom converters are unchanged;
direct embeddings must support native custom-message rendering, as for compaction data.

Source-backed ViewUnits carry exact source/update revisions, source classification and
explicit visible dependencies. Whole-message tool exchanges, delta baselines and default
whole-context opaque replay remain intact. Closure resolves completely or refuses missing
sources/replay and item/dependency/metadata-byte overflow. A linear star avoids quadratic
whole-context edges. The compiler exposes detached metadata without retaining another
canonical body store. Token estimates remain unknown. Actual provider-budget/epoch
selection enforcement is still unfinished; this does not close the ViewUnit prerequisite.

Seven distinct focused cases passed across separate invocations and a corrected repeat:
ViewUnit2, existing index2/compiler2 and native SDK input1. The real native converter,
stable positions across two material changes, held captures, original callback/ACK values
and omission behavior are covered. One Root fixture wrongly expected expanded user text
to have user authority; the expectation was corrected to unrecorded, not the production
rule. No provider, real credentials, kernel or live benchmark ran. Model-aware budgets,
full stable epochs, selective recovery and remaining whole-harness requirements stay open.

### Explicit request budgets and audit corrections (W27)

The native SDK/direct AgentSession and existing inference coordinator accept opt-in
observe/enforce request budgets with explicit deployment profiles. Profiles name the exact
endpoint/final serialized model and declared context/output/template/replay contract; model
catalog defaults and configured auth labels are not provider authorization or confirmed
limits. The three instrumented OpenAI adapters use post-hook request serialization. Native
admission refuses an enforced unknown budget when another adapter supplies no measurement,
instead of bypassing the gate. Observe mode retains unknown admission metadata.

Counts are conservative configured UTF8 estimates, not bytes/4, a local tokenizer or a
proven future bound. Reasoning is included in output only for the matched supported profile;
unsupported semantics remain unknown. Codex reserves the explicit output ceiling, not an
ignored generic maxTokens option. Ordinary complete usage updates observed error samples
only after settlement ACK; it never certifies calibration or aggressive packing. Existing
canonical request records remain the only durable observation store.

Codex uses the actual cached connection endpoint and full logical context. Only its owned
exact-match continuation can use previously ACKed input/output observations plus the new
suffix. Missing observations, media, opaque suffixes and external references remain unknown.
Local refusal preserves healthy cached replay without a send, cache mutation or fallback.
Counters and profile state stay outside prompts; no cache-warming or calibration call runs.

An initial source-only handoff incorrectly stopped at the Agent loop: the outer Agent
lifecycle would still synthesize an assistant after the local refusal. The actual outer
boundary now recognizes direct or primary-first aggregate budget errors and rethrows the
original whole error. Distinct cleanup failures remain attached; accepted input storage ACKs
remain valid. Generic non-budget failure behavior is unchanged.

Nine distinct focused cases have passing outcomes across separate invocations: existing
initial/update summary prompts2, AI retry table2+usage edge1, real Agent/Coordinator2 and
Codex cached/auto2. The native pair was repeated after adding the unmetered-admission guard;
that repeat is not another two cases. Native fixtures preserve actual source ACKs and error
identity, with no synthetic assistant or physical attempt on local refusal. All transport
responses/keys are offline fixtures. This is not real provider, tokenizer, installed SDK/CLI,
AgentSession budget-option, Completions budget-path, kernel or whole-harness certification.

The summary prompt no longer promises Python runtime survival or loss. It preserves useful
names and their last observed state/uncertainty and refers to current runtime reports. This
removes a false assertion; it does not implement authoritative resource generations.
README now gives the owned pre-release branch/source-build entrypoint, not an upstream
installer or a nonexistent published package. Security/contribution links target this fork;
no report endpoint, installer or release operation was exercised.

SPEC_DEVIATIONS.md records the immutable W26 audit:119 numbered subsections, W0–W13 and
all100 acceptance IDs, with source/evidence limits and prioritized TODOs. Later work is
explicitly separate. ViewUnit allocation, complete committed epochs, native selective
recovery, scheduler/recovery durability and remaining whole-harness/release work are open.
No live benchmark may start until all five required context features are complete.

## W32 request-time public continuation

The actual supported native request can use an adapter-encoded, source-backed public checkpoint
without another summary call or converter/hook replay. Exact public messages are adopted after
the existing ACK. Unknown original input estimates remain null, including copy/rebuild and
direct displays; ordinary summary usage is unchanged. V4 distinguishes portable checkpoints
from harness summaries, freezes the public-tail cutoff and keeps older epochs readable.
Schema35/protocol11 fences these readers. Candidate and final physical measurements independently
drop credit when the old prefix/configuration is not preserved.

All 14 existing cases pass on their first W32 invocations across separate compiler2/services2/
selector2/native-Python2/compaction4/RPC2 scopes, and types pass. The native service case covers
new opaque output plus genuine recovery -> public candidate -> qualified ACK -> exact adoption
and send -> close/reopen -> native fork/import. Seven main fake responses and one ordinary
summary are used. The separate AI-only Codex phase verifies every post-callback measurement
and actual physical fake send; its offline acceptance is not a canonical ACK claim. All jobs
have drained and the empty temporary runtime mount was removed. W31 receipts remain settled.

The five source prerequisites now work on the supported paths. After commit and clean build,
move to the authorized all-30 isolated LOW campaign, then MEDIUM, with this session's existing
ChatGPT subscription and exact `gpt-5.6-sol` / `gpt-6-astra`. No samples, readiness/auth/model
probes, D/S setup repetition or further feature-audit loop is required first. Remaining spec
findings are post-prerequisite backlog. Unsupported layouts and candidates that cannot fit
still refuse explicitly. Offline evidence is not provider/tokenizer/cache/pricing/installed/
whole-process certification. Benchmarks, publication and goal completion have not occurred.


## W33 — first full live LOW comparison

The isolated H0.9.3/native comparison completed all 30 tasks for exact `gpt-5.6-sol`
at LOW, using the existing read-only ChatGPT subscription. The candidate is frozen
W32 `7ce5c2b561809f5767984cd464cbe3dccc3b556a`, not the later W34 source. PID3359129
exited 0 after 5339.732378s. Results are in
`.work/w33-all30-campaigns-nl4qyrva/H-native-gpt-5.6-sol-low/`.

- First capacity-valid primaries: native 28/30 judges passed, H 26/30. Native wins
  on tasks13/14/16/26; native losses on23/29. Both native losses recorded WebSocket1006.
  H13 also failed with that error. H3 passed its judge with a WebSocket1006 error;
  native30 passed its judge but the RPC host did not drain after stdin EOF.
- Native was slower on18 of24 matched judge-pass tasks. These results do not establish
  efficiency gains. Total retained times include diagnostics and are not paired speed wins.
- Native retained32 attempts and H34; neither had a capacity-invalidated attempt.
  Diagnostics never replace primary results. Usage/cost completeness remains false;
  billed cost and complete comparable cost are unknown, not zero. H usage is observational.
- The report retains the legacy `thinking must be medium` publication blocker. LOW
  execution is authorized by the user's override; no publication claim follows.
  Astra LOW and the separate D/S LOW comparisons remain before any MEDIUM campaign.

## W34 — recovery writes and conservative child residency

Command/worker recovery journals use checked writes and explicit incomplete-tail refusal.
Persistence failures propagate; uncertain command result persistence cannot trigger a
conflicting second result. The ready checkpoint now uses existing runtime binding cleanup.
The canonical descriptor helper and JSONL v1 format are unchanged.

One concrete live parent owns a pending or resident child admission across native spawn,
direct factories and passive hydration. Constructor binding captures partial setup.
Completed residency still consumes capacity; successful asynchronous disposal and setup
settlement release it. Unknown startup/cleanup cannot establish release. Child runtime
new/switch/fork/import replacement refuses before setup; main/root replacement is unchanged.
Full tree scheduling, persistent reservations and owned child replacement remain backlog.

Four existing journal cases passed (PID3381057,1.368502s). Two existing real SDK/runtime/
daemon cases with the faux provider passed (PID3381062,8.151430s). These are two separate
invocations and six distinct cases, all passing on their first W34 run. Initial required
`npm run check` PID3381068 failed with three TS2554 mock-overload declarations. Those
three declarations now use `typeof fs.writeSync`; runtime operations were unchanged.
The corrected required check PID3382020 passed in3.734085s:1038 files/no fixes, types,
installer and browser smoke. No focused cases were rerun. Logs are under
`.work/logs/w34-recovery-resident-*.log` in this workspace.

This is bounded local evidence, not all daemon fault paths, synthetic/unlimited-sibling
fixtures, platform durability, a full scheduler, or whole-process certification. No timed
benchmark ran during W34 source integration/checks. Its frozen W32 packages and runners
are unchanged. Publication and goal completion remain pending.


## W33 — Astra LOW H/native complete

The frozen W32 comparison completed all30 tasks per arm for exact `gpt-6-astra` LOW
using the same existing subscription. PID3387431 exited0 after3544.648932s. Native
passed30/30 judges; H passed29/30. H17's primary failed at progress3; its diagnostic
does not replace it. Native27 and H27/30 passed their judges but recorded
`RPC host did not drain after stdin EOF`. Judge pass is not runtime-clean completion.

Native was faster on15 and slower on14 of29 matched judge-pass pairs; their agent-time
deltas sum to-155.824390s, including the errored pairs. Neither arm has complete
usage/cost, so cost remains unknown. Native retained30 attempts and H31, with zero
capacity-invalidated attempts. Raw `thinking must be medium` publication policy remains
separate from the user's LOW execution override. Full D/S LOW for both models precedes
any MEDIUM comparison. Source fixes do not replace frozen W32 during this campaign.

## W35 — stop new automatic refinement during shutdown

The native runtime closes automatic-refinement admission synchronously at EOF before
pending RPC handlers and `waitForIdle`. The gate survives an already accepted session
replacement. Disposal drains accepted main/refinement work and explicit queued
`refine.run`, but starts no new automatic review/plan and does not recreate a failed
background plan for a disposal-only retry. Existing error handling, child cancellation
and capacity rules remain unchanged. Model-visible eligibility and Sol's custom prompt
are unchanged. Accepted slow work can still exceed30s; neither Sol30 nor Astra27 is
uniquely attributed to a particular admission call site by the captured evidence.

Eight existing cases passed on their first W35 invocations: serialized-refine6
(PID3407475,5.888393s) and RPC2
(PID3407480,6.909701s). The initial required check
failed with TS2353 for an unsupported fixture services `model` option. Removing that
extra option preserved explicit model selection in the session factory. The corrected
required check passed (PID3408293,4.267737s;
1038 files/no fixes, types, installer and browser smoke). No runtime cases were rerun.
Logs: `.work/logs/w35-native-eof-*.log`. No new test suite, provider run, or physical-receipt
claim is added by the local-faux fixture.

For Astra, the27 judge-pass pairs with no recorded runtime error have native4334.047s
versus H4135.403s (+4.8%), with native slower on14. This supplement does not replace the
29-pair primary report. Overall efficiency and billed-cost gains are not established.


## W36 — reduce redundant provider metadata

The Sol first-response observations showed roughly998 extra native input tokens before
solution trajectories diverged. This is a prompt-overhead lead, not attribution to one
component or a billed-cost/latency result. Newly rendered TaskFrames now omit physical
locators, journal paths and internal source-control labels while retaining exact public
recovery coordinates and the captured horizon. Internal rows/material/origins and all
requirements, relations, authority, coverage and capture remain unchanged. Old frozen
text is reused verbatim when material matches. Destination rebuilding is unchanged.

Recovery advertises equivalent string enums; strict input validation and behavior are
unchanged. Sol/custom/behavior prompts and explanatory text are preserved verbatim.
On existing recorded data only, fresh-render-equivalent TaskFrame text changes from
1240–1280 to734 UTF-8 bytes; tool-parameter JSON changes from1623 to1471 bytes. These
are separate static representations, not executed-renderer measurements, token counts,
a serialized-request delta, or a live efficiency result. Frozen W32 is not rewritten.

Three existing cases passed on their first W36 invocations: compiler happy/edge2
(PID3413270,7.563883s) and the real services/recovery case1
(PID3413275,5.937469s). Exact displayed coordinates and stale-revision
refusal use the existing fake-SSE flow without added provider calls. Expected profile/
epoch refusals remain in passing stderr. Required check passed on its first invocation
(PID3413281,4.319638s;1038 files/no fixes, types, installer and browser smoke).
No case/check rerun was needed. Logs: `.work/logs/w36-provider-metadata-*.log`.


## W37 — keep explicit request budgets in owned child paths

The existing budget exposes a detached copy of explicit configuration through its
Coordinator. Native spawn, inline construction, runtime/daemon factories, genuine
passive hydration and the production creation whitelist carry that snapshot before
setup/service waits. Defined trusted overrides retain priority; no policy stays absent.
No profile/catalog guess, durable policy field, learned calibration, retained credit,
body or resource ownership is copied. Each child uses its own ordinary budget instance.
W34 lifetime/capacity and W35 EOF behavior remain unchanged. Sol's custom prompt is intact.

The two existing runtime cases passed after two fixture corrections: retained child
snapshots use status `done`, and the root fixture explicitly selects its intended faux
model. The initial two failures remain in `w37-child-budget-runtime.log`; the corrected
scope is `w37-child-budget-runtime-corrected.log` (PID3452065, 7.176s). No production
correction was needed. The happy path is local-faux execution/configuration evidence.
The real passive-hydration edge uses a genuine offline-configured openai-responses
adapter and refuses unknown budget before fetch. Expected passivation/refusal stderr
is retained. No physical receipt, tokenizer, pricing, live-provider or complete
tree-budget claim follows.

D Sol LOW completed on the separately frozen D/stock 0.9.1 controls: 27/30 primary
judge passes in each arm, 33 retained attempts per arm, and no recorded runtime
errors or capacity-invalid attempts. Stock failed 3/21/28; D failed 5/13/28.
Diagnostics remain separate from immutable first-valid primaries. Across 25 matched
passing pairs D took 5657.014s versus stock 6221.697s (-9.1%), faster on 16 pairs.
This is D evidence, not the current native Base Context candidate. Physical usage
and billed cost remain incomplete/unknown. The raw LOW publication blocker remains.

### W38 — bounded skill text loading

Discovery uses bounded frontmatter reads (16 KiB including delimiters, with up to
one 1 KiB chunk of discarded read-ahead). Selection reads one complete held-file
capture up to 1 MiB. Oversized or incomplete selected reads reject before a user
prompt is appended or sent. Existing expansion and raw submission attribution stay
intact. Aggregate catalog/module/version and global memory bounds remain open.

Both existing cases passed on their first invocation: metadata (PID3451402, 1.150s)
and selected expansion (PID3451407, 3.448s), in `w38-skill-metadata.log` and
`w38-selected-skill.log`. A template-literal style suggestion was corrected without
changing behavior. No live provider, atomic same-size file snapshot or model-fit
claim follows.

### W39 — retain unknown orphan tracking

Strict orphan-journal read failures now retain the journal and recovery descriptor.
The owned frontend still reports pending RPC uncertainty before it stops; it does
not launch a replacement worker on an unknown read. Cleanup is attempted at its
original location, and distinct cleanup/reporting failures remain ordered.
Daemon cleanup disables associated-file deletion after its read-error diagnostic.

The same two real owned-worker EOF/crash cases passed on their first invocation
(PID3451413, 1.313s), in `w39-orphan-retention.log`. The daemon-ps flag is source/type
scope, not behavior-covered by unrelated planning tests. Shared writer enrollment,
Python writer fixtures and global durability remain unresolved.

W37–W39 ship as one source gap. The initial W37 required check passed, and the
combined required `npm run check` passed after the fixture corrections
(PID3452070, 4.025s, 1038 files, one formatting fix, types/installer/browser checks).
Six distinct focused cases passed; corrected reruns are not additional cases.
All logs are under `.work/logs/`. No benchmark ran during these source checks.

### W40 — selected skill catalog admission

Actual system-prompt construction captures one admitted skill catalog, with limits
of 32 visible items and 65536 rendered UTF-8 bytes. All selected entries keep their
existing order and text, or construction refuses; there is no partial/empty fallback.
Default/custom prompt placement and existing disabled/empty/file-access gates stay
unchanged. Loader inventory and attribution are not replaced or bounded by this work.

Both existing ResourceLoader override and RLM markdown-skill system-prompt cases
passed on their first invocation (PID3471235, 2.470s; PID3471240, 2.096s).
Logs: `w40-42-catalog-loader.log`, `w40-42-catalog-prompt.log`. Initial formatting
reported the boolean parameter `escape` shadowing a global; renaming it to
`escapeValue` corrected the lint error without changing behavior. No model call,
whole-prompt/model-fit, global heap, discovery or module/version-lifecycle claim
follows. Sol's custom prompt is unchanged.

### W41 — remove an unimplemented hooks export

The package no longer advertises `./hooks` or its two stale TypeScript aliases.
No corresponding source or generator exists, and runtime aliases never advertised
that hooks entry. The real root-import case exposed a separate missing exact owned
AI `/mcp` alias: the root alias incorrectly produced `dist/index.js/mcp`. Added only
the published `dist/mcp.js` mapping through the existing resolver, preserving native
AI root registry sharing, supported root API and actual extension events.

The initial loader scope passed the unavailable-subpath case but failed the supported
root import. One affected-case diagnostic exposed the import error (PID3473098,
2.032s). Both existing cases passed after the two-line loader correction
(PID3473445, 7.331s). Original failures remain in `w40-42-hooks-loader.log` and
`w41-hooks-handler-diagnostic.log`; corrected scope is `w41-hooks-loader-corrected.log`.
No existing assertion was weakened. This is Node source/import evidence, not bundled,
installed-package or updater certification.

### W42 — refuse self-update on unavailable lookup

Self-update now requires an available release result, including with `--force`.
Unknown metadata is reported as a failure, not updated or already up to date.
Thrown errors use the existing CLI reporter and exit code 1. No self command,
daemon probe, installer or restart follows a failed lookup. Accepted extension
updates that precede lookup are retained; they are not described as rolled back.

The same two package-command custom-socket and installer-failure cases passed on
their first invocation (PID3471252, 3.041s), in `w40-42-update-lookup.log`. Lookup,
installer and daemon effects were controlled. The displayed npm installation and
success messages belong to those mocked effects, not a live installation. Known
same-version forced reinstall remains supported. No origin validation or atomic
CLI/runtime activation evidence follows.

D Astra LOW completed on the frozen D/stock controls: 29/30 primary judge passes
per arm, 31 retained attempts per arm, no capacity-invalid attempts. D task15
(progress0) and stock task29 (progress1) retained their primary WebSocket1006
failures; diagnostics did not replace them. No other retained runtime errors were
recorded. Across 28 matched passing pairs D took4415.404s versus stock5211.983s
(-15.3%), faster on24pairs. This is separately frozen D evidence, not the current
native Base Context candidate. Physical usage and billed costs remain incomplete;
the raw LOW publication blocker remains.

W40–W42 ship as one source gap. Six distinct focused cases passed; diagnostic and
corrected runs are not additional cases. The initial required check passed
(PID3471259, 4.337s). After the real loader fix, the required `npm run check` passed
again (PID3473450, 3.995s, 1038 files, no fixes, types/installer/browser checks).
All initial formatting/runtime diagnostics remain under `.work/logs/`. No benchmark
ran during integration or checks. Sol/custom/behavioral instructions are unchanged.

### W43 — release metadata redirects and advertised origins

Metadata lookup uses native fetch `redirect: "error"`. An advertised resolved
tarball outside the captured configured-base origin makes the whole release
unavailable, so W42's existing refusal applies without a package-install fallback.
Same-origin relative/absolute results and the owned registry route stay unchanged.

The same two explicit-manifest and wrong-product release-lookup cases passed.
`npm run check` passed (Biome, types, installer and browser smoke).
Fetch is stubbed; this is the real lookup's option/error contract, not a live
redirected-server test. Download redirects, activation and wider G14 remain outside
this change. Sol/custom/behavioral instructions are untouched.

### S Sol LOW — frozen control result

The frozen S/stock `gpt-5.6-sol` LOW invocation finished with 60 immutable primary
comparisons: modified S passed 29/30 judges and stock passed 28/30. S task 24
failed at progress 3 (main 3/5, edge true); stock task 21 failed at progress 3
(main 3/5, edge false), and stock task 27 at progress 4 (main 5/5, edge false).
Each has a retained diagnostic attempt, not a replacement primary. All 63 retained
attempts are runtime-clean; there are no capacity-invalid attempts.

The 27 matched passing pairs took 6053.428 s for S versus 6709.881 s for stock
(9.783% less); S was faster on 21 pairs and slower on 6. On those same pairs,
solver-message observations were 295/305 model calls, 270/251 tool calls,
2672191/3490798 input tokens including cache, 595263/763374 uncached input,
and 152386/171479 output tokens (S/stock). These are frozen-control timing and
solver observations, not current native gains, complete physical accounting,
billed cost, or latency causality. Usage/cost completeness is false and API-cost
totals are null. The raw `thinking must be medium` publication flag remains.

All LOW invocations must finish before any MEDIUM; S Astra LOW is next.

### W44 — owner-backed context.mode

A reversible on/off control now commits through the existing qualified epoch owner.
Off keeps pinned/public continuation and the literal tail, without archive replay,
new selection or new refine/compact planning. Accepted work drains. Explicit
recovery, physical receipts, final budget/resource/adapter checks and protected
prompt text remain. Settings seed only fresh policy; committed mode wins on resume.

The v5 policy-only checkpoint stores no measured request or invented usage. A
genuinely fresh off session may ACK its first actual compatibility contract once
through that same owner; later native continuations validate it instead of learning
new contracts. Legacy missing-contract history receives no generic grant.

The existing serialized real-apply and native services cases pass, including
post-public-checkpoint off/reopen/refusal and fresh-off native tool continuation.
Controlled planner/fetch responses are not live provider evidence.
Child/copy/re-enable/failure paths are source wiring, not extra behavioral coverage.
Global tree scheduling, independent auxiliary budgets, bridge/semantic configuration and full G07 remain open.

### W45 — learning model and effort selection

An optional `autoRefine.model` contract now reaches both actual built-in review
and planning requests, selected before history/auth waits. Invalid explicit
selection refuses without auth/send or main-model fallback. Existing ownership,
request budgets, receipts, cancellation and W44 admission remain unchanged.

Without the override, the current main model is used and effort is omitted,
as before. This corrects the earlier source-level assumption that passing the
main thinkingLevel meant it reached the helper's request options.

The same built-in-planner fallback and missing-main-auth cases pass, with actual
default/configured faux callbacks and unknown-learning-model refusal.
These observations are not physical wire, entitlement or billed-cost
evidence. Other malformed/effort/cross-provider/capture branches are source wiring.
Independent auxiliary budgets and the remaining §18.4/G07 work stay open.

### Final S Astra LOW and completion of LOW sequence

The frozen S/stock Astra LOW invocation finished with all 60 immutable primaries:
modified S **25/30**, stock **27/30** judge passes. S failed tasks 6,17,24,26,27;
stock failed 17,21,24. Every failed primary has one retained diagnostic attempt.
The only runtime errors across all 68 retained attempts are primary S26 and
stock21 (`AgentError: WebSocket closed 1006`). No capacity-invalid attempts were
recorded. Both task30 primaries passed without runtime errors. Diagnostics do not
replace primaries.

Across 24 matched passing pairs, S took 3377.016s versus stock 3951.858s
(**14.546% less time**); S was faster on 22 pairs and slower on 2. This conditional
timing result accompanies lower S correctness, not an overall efficiency win.
These are frozen S/stock results, not gains from current native source. Physical
usage/cost remains incomplete and API cost totals remain null. The raw
`thinking must be medium` publication blocker is retained.

All six LOW invocations have finished. MEDIUM has not started at this source
checkpoint. The planned MEDIUM sequence uses the same frozen W32 H/native and
old D/S builds, without repacking or replacing them with these source changes.

Initial W44/W45 diagnostics are retained: all four first case runs stopped on
settings access before constructor assignment; the direct configuration reference
fixed that. The missing-auth case then exposed an indexed mode read on an explicit
in-memory session. The shared reader now retains that mode's creation default
without attempting indexed history. Persistent reads still require their owner.
The first project check also found two old summary fixtures widened to the new
policy-only epoch union. The measured v4 producer and its unchanged bounded
snapshot now preserve their actual return subtype; no fixture casts, runtime
validation changes or weakened v5 null rules were added. Four distinct cases pass
after these corrections. Required `npm run check` passes: 1038 files without
formatter fixes, TypeScript, installer and browser-smoke checks.

### W46 — root publication without repeated workspace builds

The root `prepublishOnly` sequence checks source before one `build:source` step.
Both `publish` and `publish:dry` then pass `--ignore-scripts` to the workspace npm
command. Standalone package hooks, version/commit/tag workflow and the R2 packer
are unchanged. This is not a new tested-tarball staging workflow.

Validation passed in the same two package-command-path cases. Their self-update
success/installer-failure phases now use current owned paths and metadata, then
observe actual root script routing through controlled commands. Normal/dry routes request check, one build and intercepted publication;
a failed-check phase stops before build/publication. No real npm CLI, lifecycle,
registry, build or publish effects are exercised by those added phases.
Publication and installed/platform evidence still need their separate approvals
and work.

### W47 — bounded pending catalog requests

Catalog requests use the existing pending map/FIFO owner with local limits of
32 ordinary requests and 1 MiB combined encoded UTF-8 payload, captured before
startup or queue waits. A single reserved 128-byte shutdown control closes new
admission and follows accepted work even at ordinary capacity. Settlements, not
send/progress notifications, release admission.

Validation passed (two existing cases): the same dedicated-IPC case now fills ordinary capacity with
31 resolves and one rename, stops, and reads the persisted result. The same cold
startup case checks pre-start/send refusal, detached input and combined byte
admission using its existing mocked process boundary. No extra fault matrix.
Inbound rejection and failure/restart paths are source-only. Existing timeout and
transport-error behavior does not certify successful drainage after failure.
Saved catalog paging/scans/cache/output and global memory bounds remain open.

### W48 — unknown Responses routes do not inherit long retention

Long-retention defaults now use the resolved client's request URL rather than
assuming every Responses-compatible route supports the field. Official OpenAI
Responses keeps its previous default; explicit true/false compatibility settings
still override it. Final post-hook request measurement is unchanged.

Validation passed (two existing cases): two existing Responses cases stop at onPayload, confirm that
fetch was not called, and observe unknown-route omission, official-route default
and explicit compatibility overrides. Other cache tests are not selected or run.
This is pre-fetch request construction, not live provider/cache/billing evidence.
Other providers, headers and broader G05 work remain outside this change.

### W49 — bounded live Python Bash admissions

Each kernel admits 32 live or unresolved Bash handles through its existing owner
set before setup effects. Healthy owner/reader settlement and observed group/job
absence release capacity. Unknown cleanup may retain a slot until kernel exit;
results, leader death or kill delivery alone do not release it. No new reaper or
registry was added. Caller-owned completed results remain usable.

Validation passed (two existing cases): the same result case adds 33 healthy completions with actual
capacity reuse. The same wake-pipe failure case keeps its original close checks
and adds 32 real handles held at existing worker exit, pre-effect excess refusal,
and settlement/reuse. No quota reset or fabricated owner entries.

A private shutdown-gate correction preserves original cleanup after a process
has signal authority even while construction finishes. Tests are unchanged by
that correction. Windows, cancellation, thread-start/uncertain-cleanup and
shutdown behavior remain source-only, not runtime-certified. G01 journal writes
and enrollment, global memory/process limits and caller-retained output remain
outside this local bound.

### W50 — require identity on private release metadata

Private download manifests without the active package identity are now refused.
Existing `package`/`packageName` fields and the producer's current manifest shape
remain; the owned npm registry path is unchanged.

Validation passed (two existing cases): the same two release-manifest cases retain their previous
phases and add refusal of a same-origin tarball manifest without package identity.
The new source behavior is not a replay of settled W43 checks for reassurance.
Controlled metadata lookup is not tarball-content, installed-update, rollback or
platform evidence. Other G14 work remains open.

### W51 — correct local doctor schema reporting

Doctor now reports the owned request and policy epoch renderer identifiers from
their existing source constants, instead of `not implemented`. The field remains
a string; the existing JSON/text reporting paths and credential handling stay.
These identifiers describe local schemas, not session, provider or model health.

Validation passed (two existing cases): the same two doctor cases retain their original owned-path,
credential exclusion and legacy-root refusal checks; the happy case also reads
the native metadata and real text formatter. No provider/auth probe or installed
CLI run is part of those cases. The isolation document now reflects current
protocol 11/schema 36; frozen W32 schema-35 benchmark artifacts remain unchanged.

### H/native Sol MEDIUM — frozen W32 comparison completed

The first MEDIUM invocation exited normally after 8694.473s.
All 60 immutable primaries and 63 retained attempts remain: native 28/30 judges
(32 attempts), H 29/30 (31 attempts), zero capacity-invalid attempts. Native4
failed with WebSocket1006; native28 failed main0/5 with edgeTrue and no runtime
error. H13 failed main3/5 with edgeTrue and no runtime error. Each failed primary
has one diagnostic, which does not replace it. H4/H7 passed their judges with
WebSocket1006 errors. These three primary WebSocket errors are the only runtime
errors across all retained attempts. Both27 and both30 passed runtime-clean.

The 27 matched passing pairs took native 11125.386s
versus H 11132.330s (-0.062%),
12 faster and 15 slower. The 26 runtime-clean matched pairs, excluding H7, took
10926.102s/10996.081s
(-0.636%). This supplement does not replace the full matched result.
Lower native correctness and effectively even conditional timing do not establish
an overall native gain. All-attempt time is not matched-pair speed evidence.

Same27 solver observations (native/H): 388/374 model calls, 357/334 tool calls,
1/0 recovery calls; input including cache 6547793/6134645, uncached981585/953205,
cache-read5566208/5181440, output315647/317743. The recovery call was native25's
primary; a call count alone is not successful recovery evidence. These are solver
observations, not complete comparable physical accounting or billed cost. Usage
and cost remain incomplete/null. MEDIUM has no publication-protocol flag, but
publication readiness remains false and no publication approval is granted.

Read-only task28 comparison found native's explicit correction-batch import
routing versus H's nested discovery on root imports. Native rehearsed root then
batch; H rehearsed root twice. Supplied docs/data were present. The fresh-grading
clause does not specify the second operand, and saved fresh grader commands/CSVs
were unavailable. This is a supported semantic difference, not identified context
loss, sole-cause attribution or a reason to reclassify the failed primary.

This invocation used frozen W32 H/native, not the later shipped source. D/S remain
separately frozen controls. H/native Astra MEDIUM is next after the source gap;
no candidate repacking, runner swap or new readiness probe is part of that step.

### W46–W51 source-gap validation outcome

Twelve distinct existing cases passed in seven focused commands. W47 catalog
entry/startup, W48 Responses-only cache cases, W49 native Python Bash cases, W50
manifest cases and W51 doctor cases passed on their first run. The two W46
command-path cases initially failed before the added publication-routing phases:
one expected a tarball without configuring its private manifest origin/identity;
the other expected a foreign-package rename even though owned lookup refuses it.
The first error was the missing tarball argument at line265. The second was
`release lookup is unavailable` rather than the intended installer exit23.

Root aligned only those two fixtures with the actual owned product contract:
owned installed/project paths, explicit same-origin manifest with package identity,
and an owned-package installer failure. The obsolete rename/uninstall expectation
was removed; the case is now named `fails self-update when owned npm package
installation fails`. It still requires the actual controlled installer exit23,
exact install call, failed outcome and no success output. The added normal/dry
routing and failed-check phases remain. No production refusal was weakened.
Only that affected pair reran and passed; the ten passing cases were not replayed.

Initial and corrected required `npm run check` passed: 1038 files, no fixes,
TypeScript, installer and browser checks. Expected controlled pre-fetch refusal
logs in W48 and a Python asyncio slow-task diagnostic accompanied passing tests;
neither indicates a provider request or failed case. Original failures/logs are
retained. No broad suite, live provider probe, installation or publication ran.

### W52 — receipt-owned native capacity invalidation

The native runner now grants a capacity exemption only from a parsed settled
physical receipt. The selected host's package name is checked against the actual
package metadata during existing manifest admission. RPC and legacy assistant
capacity messages remain observations, not native exemption authority. H keeps
its previous behavior. No receipt means no established exemption, not zero work.

Validation passed on first run: the same two benchmark harness cases exercise real parsing,
runner/attempt/case classification and saved primary retention with mocked RPC
processes/judges. Receipt-confirmed capacity retains the invalid attempt before
the next valid primary; RPC-only native failure remains primary despite a later
diagnostic pass. Legacy compatibility and exceptional unknown observations remain.
The first case's existing Python/process-isolation phase is unchanged. No live
provider/judge call, frozen-host change or retrospective result reclassification
is part of the new phases. Broader G17 metadata and billing evidence remain open.

### W53 — bounded optional session-list metadata caching

The existing session-info cache is capped at 256 entries/4MiB encoded key/stat/info
metadata. The same Map owns entries and derived byte counts; oldest entries evict
and hits become recent. Bounded encoding precedes retained cloning. Cache copies
preserve Date/types and do not share mutable nested metadata with callers.
Oversized successful results still return completely, without being cached.

Validation passed on first run: two existing cases retain their original timestamp and
large-message list assertions, then exercise actual reads/lists, caller detachment,
null/item eviction, combined UTF-8 byte capacity and complete oversized list
results. Read spies call through; no cache injection/reset or artificial quota
override is used. IPC/resolve and unusual copy-failure branches are source wiring.
This is retained derived-cache admission, not bounded scans, paging, outgoing
results, caller values or whole-process heap/RSS evidence.

### H/native Astra MEDIUM — frozen W32 comparison completed

The invocation exited normally after 3428.637s.
All60 immutable primaries and63 retained attempts remain: native29/30 judges
(31 attempts), H28/30 (32 attempts), zero capacity-invalid attempts. Native17
failed main4/5 with edgeTrue/no runtime error. H17 failed main0/5/edgeFalse
with WebSocket1006; H27 failed main2/5/edgeFalse with WebSocket1006. Each failed
primary has one retained diagnostic, never substituted for the first valid primary.

Five runtime errors occur across all retained attempts: primary H17/H27
WebSocket1006, primary native27 EOF-drain error, primary native30 WebSocket1012,
and diagnostic H27 EOF-drain error. Native27/native30 passed their judges despite
their runtime errors. H30 passed runtime-clean. Judge pass is not runtime-clean.

The28 matched passing primary pairs took native
5335.872s/H5142.587s
(+3.759%),8 faster/20 slower. The27 runtime-clean pairs, excluding30, took
4769.394s/H4465.427s
(+6.807%),7 faster/20 slower. That supplement does not replace the full
matched result. Higher native correctness comes with slower conditional timing;
usage/billed cost remain incomplete/null, so no overall native gain is established.
All-retained agent6250.571s/6208.781s is not paired speed evidence.

Same28 solver observations, native/H: model calls
309/313, tools
248/251, recovery0/0; input including cache
3020169/2725563, uncached
522377/557371, cache-read
2497792/2168192, output
150957/146407. These are solver observations, not complete
comparable physical accounting, billing, or latency-cause evidence. MEDIUM has no
publication-protocol blocker, but publication readiness remains false and no
publication approval is granted. Older LOW flags remain unchanged.

Read-only native17 LOW/MEDIUM primary comparison found identical saved clause
and missing CSVs but different comparison-report labels/grouping. LOW renders
human-readable liability labels and repeats values; MEDIUM retains normalized
labels and citation-only members. The actual values and inspected public inputs
were present. The judge does not define check4 or expose failing fresh output.
This is a supported representation difference, not a confirmed wrong-value bug,
missing-context finding, optimizer/effort causation or exhaustive sole cause.
The failed MEDIUM primary remains failed; no solver/corpus patch or feedback ran.

The earlier Sol MEDIUM native25 primary's actual public recovery search returned
two source records containing the report-freshness clause. Its status/coverage
remained partial (`unsupported_public_shape`). This is a working partial public
search, not complete recovery or causal correctness/time/cost gain.

This invocation used unchanged frozen W32 H/native, not the later source. D Sol
MEDIUM is next on its separately frozen runner/hosts after this source gap. No
completed output, frozen host or candidate is rewritten, repacked or replaced.

### W52–W53 source-gap validation outcome

Four distinct existing cases passed on their first run in three focused commands:
two native Python benchmark cases and one case each for session timestamp/cache
and flat-storage cache behavior. The required `npm run check` passed:1038 files
with no fixes, TypeScript, installer and browser checks. Only the three changed
TypeScript files were formatted beforehand (two format fixes). No new suite,
provider probe, inference, installation or publication was run. W46–W51 and
previously completed campaigns/checks were not replayed.

Capacity coverage is actual parser/runner/attempt/case flow with mocked RPC/judge
and selected-host fixtures, plus the existing isolation subprocess phase. Cache
coverage uses real persisted metadata, full list/read paths and call-through read
spies without injected cache entries or quota resets. These scoped paths do not
establish manifest/artifact/provider certification, bounded catalog scans, all
IPC/resolve/copy-failure branches, global heap, billing or release readiness.

### W54 — exact accepted epoch reference in request events

Native request admission and settlement now carry the optional descriptive
`contextEpoch: { sessionId, entryId }` from successful actual request-view
preparation. Retained epochs use the qualified compiler reference; new selection
and fresh-off compatibility use the actual epoch ACK. Each physical attempt
keeps its detached admission reference through settlement, not a later leaf or
selection. The original pre-commit source frontier remains unchanged.

This uses existing compiler metadata/callbacks and transient attempt tracking,
not a parallel registry, body store or authority mechanism. Generic/unmanaged
and unrelated auxiliary contexts do not infer an association. Budget/effort
fields, unvalidated model/pricing declarations, source/purpose ownership, resource
checks, conversion/callback count and ACK/cancellation/error semantics remain.

Validation passed: exactly two existing cases: services `honors an explicit
daemon-carried telemetry opt-out` and coordinator `keeps late settlement and
semantic retries on their captured source and rebinds children`. The service
case uses its existing fake-SSE sends for new/retained ACKs, local destination
references, summary omission and a late ordinary source entry. The unmanaged
fixture retains its existing child/auxiliary/foreign-capture phases and checks
omission. No new provider call, test suite or additional lifecycle matrix.

The added late-state phase moves an ordinary source leaf; it does not fabricate
a new epoch. Wider retry/epoch-change/copy/import/lifecycle cases not exercised
by those existing paths remain source-only. This does not certify live providers,
installed artifacts/platforms, complete receipt coverage or billing. The change
does not modify frozen campaign runners/parsers/controls or protected prompts.

### D Sol MEDIUM — separately frozen control completed

The frozen D invocation exited with code0 after 6501.520s.
All60 immutable primaries and64 retained attempts remain: D29/30 judges
(31 attempts), stock27/30 (33 attempts), zero capacity-invalid attempts.
Failed primaries are stock5 (main5/5, edgeFalse, no runtime error), D19
(main4/5, edgeTrue, WebSocket1006), stock19 (main0/5, edgeFalse, no runtime
error; bad gaps.csv header/BAD-only edge failure), and stock20 (main1/5,
edgeFalse, WebSocket1006; negative-kWh edge outputs missing). Each has one
retained diagnostic, never substituted for its primary. The only two runtime
errors across all64 attempts are primary D19 and stock20.

All27 matched passing pairs are runtime-clean: D
9279.136s/stock11312.508s,
-17.975%,24 faster/3 slower. These results show higher observed
correctness and faster conditional time for this separately frozen D control,
not for current native source. All-retained agent10295.602s/13232.381s is not
paired speed evidence. Usage/cost remain incomplete; catalog/assistant cost
observations are not physical totals or billed cost. MEDIUM has no publication
protocol blockers, but publication readiness remains false and no approval is
granted. Old LOW flags and all completed results remain unchanged.

Nine invocations are complete with576 retained attempts. D Astra MEDIUM is next,
then S Sol and S Astra MEDIUM, on their existing frozen runners/hosts. No
candidate/runner/model/auth change or probe was used to finish this invocation.

Same27 matched solver observations, D/stock: model calls
372/389, tools
368/347, recovery
12/0; input including cache
4666234/5848887, uncached
932346/1041463, cache-read
3733888/4807424, output
259939/313327, total
4926173/6162214, cache-write0 observed. These counts do not establish
complete physical calls, billing, causation, or current-native performance.

### W54 validation outcome

Both distinct existing cases passed on their first focused runs. Expected
controlled pre-fetch budget refusals appeared on stderr in the passing service
case; no live provider call occurred. Initial formatting corrected two files but
reported three noConfusingVoidType warnings. The initial required check stopped
on those same warnings before type/installer/browser checks.

Callback types now keep value/undefined promises separate from existing
Promise<void> callbacks, and fixed preparation infers its return type. A second
check passed lint but reported TS2322 on the wrapper's combined inferred return.
The wrapper now normalizes its optional return with `accepted || undefined`;
actual reference/undefined values and the selected provider body are unchanged.
The selector does not consume this callback result. No fixture, suppression,
unsafe fix, cast or extra inference was added. The focused cases were not rerun.

The final required `npm run check` passed:1038 files with no fixes, TypeScript,
installer and browser checks. Both earlier diagnostics remain retained. No broad
suite, provider probe or frozen benchmark change was made.


### W55/W58 — native indexed catalog and explicit Node compatibility change

The existing derived index owner now maintains a whole-source SessionInfo
projection and same-index numeric usage rows under schema16. Discovery uses a
real read-only index worker and one held SQLite snapshot, checked against the
current source path/dev/ino/length and actual header/terminal frames. Selected
metadata records use existing payload parts, then the source capture is checked
again. Covered reads do not iterate the complete journal body history. Header,
terminal and selected metadata records can still require complete bounded frame
or payload reads; this is not a zero-body-read or constant-time claim.

Actual native readSessionInfo/list/listAll consume the covered summary. Missing,
stale and unsupported coverage remain explicit; SQL/open/read failures remain
errors. Native failures escape list handling rather than becoming an empty or
partial successful catalog. Already emitted progress is not rolled back. Normal
source owners rebuild known older derived indexes; discovery does not acquire a
writer, create/seed/repair/migrate the index or fall back to a native EOF scan.
Legacy header scanning remains a separate path. Original public fields, Dates,
text/search/preview limits, all-source metadata and the sole W53 optional cache
remain. Cache hits require current native coverage. Complete oversized results
are returned uncached; encoded cache charges include key/stat/capture/info data.

Native usage now includes actual assistant/compaction/branch-summary usage even
when a containing record exceeds the old scanner's text cutoff. This corrects
that native omission without changing legacy scan behavior. Source-order target
eligibility and aggregate replacement precede the original assistant order,
summary addition and ordered clamped child subtraction. Numeric reduction uses
128-row pages on relevant usage changes, not a per-message JS map or every
unrelated append. Missing usage is not invented zero; incomplete/non-finite
supplied usage makes projection coverage unsupported. Known observed zero and
existing all-zero public summary omission are preserved. These are source usage
summaries, not complete physical requests, billed cost or attribution causality.
Indexing/reduction work and index disk size still grow with source history.

Root explicitly selected `^22.12.0 || >=23.3.0` under spec343/586, with a README
migration notice and matching five own package/lock engine entries. This replaces
the inherited22.8 floor and excludes early23 releases that lack the read-only
option. Older runtimes refuse read-only opening before database access; no
writable/query_only fallback, alternate backend or capability probe is added.
No third-party dependency versions change. This is Root's explicit engineering
compatibility decision, not inferred user consent; release publication still
requires approval. Actual minimum/current-runtime execution is required before
claiming support. Current source protocol11/schema36 and canonical journal
formats are unchanged; the derived history index alone advances15→16.

No Sol/custom/behavior/system/developer/tool instructions, model/auth/runner/
control artifacts, source-effect ownership, or frozen benchmark evidence change.
G08 still has inventory/paging/output/global-resource limits open; this is not
full G08, migration, installed/platform, lifecycle, billing or release closure.
Validation passed: exactly the two existing W53 cases ran once on actual22.12
and once on current22.22.1 (four isolated commands), all first-pass. These cover
native writer projection, current covered read-only discovery, attribution order,
large usage/text fields, cache ownership and unavailable-index refusal; they do
not establish whole-process/global-resource or installed-platform behavior.
Initial formatting found three unsafe-finally errors and one catch-assignment
warning. Read outcomes now close outside finally before return/rethrow, preserving
primary-first cleanup errors; the worker uses a local failure variable. The first
required check then found entry-view, TextContent-import and fs.stat-overload type
errors. Type-only corrections retained the full original payload and actual
numeric Stats contract; runtime cases were not rerun. Corrected `npm run check`
passed (1039 files, TypeScript, installer and browser smoke). Original failed
format/check outputs are retained. No provider/auth probes were run.


### Frozen D Astra MEDIUM final

All30 tasks completed on the unchanged frozen D0.9.1 runner/hosts-v1:29/30 D
and29/30 stock. All60 immutable primaries and62 retained attempts are kept;
capacity-invalid0 and no reported runtime errors across all62. Only both task17
primaries failed: main4/5, edgeTrue, progress3, main semantic check4 failed,
D149.51800973305944s/stock227.6213664910756s. Both have a separately retained
diagnostic attempt; no substitution or causal attribution was made.

All29 matched passing pairs are runtime-clean: D4616.516224260558s versus
stock6300.907294527511s, -26.732516%,27 faster/2 slower.
The all-retained4925.459s/6770.057s totals are not matched-pair timing. This is
frozen D evidence, not current-native performance or billing. Usage/cost remain
incomplete and API cost null. No MEDIUM protocol blocker grants publication
readiness or approval; old LOW flags remain unchanged.

Same29 matched solver observations, D/stock:307/336 calls,241/270 tools,
0/0 recovery, input including cache2438189/3238672, uncached551085/709520,
cache-read1887104/2529152, output117668/171800, total2555857/3410472;
cache-write0 observed. These are not complete physical totals or billed cost.
After D Astra, ten campaigns/638 retained attempts were complete; the following
S Sol campaign is summarized below. S Astra retains its existing frozen S runner. No current-source
substitution, extra provider/auth/model probe or completed-campaign rerun occurs.


### G10 unresolved-effect boundary remains open

Source inspection found that an ACKed tool intent advances the canonical branch,
but an assistant call with no finalized result is refused as an incomplete replay
group before actual provider/public-window admission. Ordinary tool-intent frames
also lack a separate positive native-tool-owner qualification. Existing captured
IDs support correlation, not effect reconciliation or a new replay permission.
A working resumed path needs an explicit qualified incomplete-whole-group public
continuation/admission rule and frozen-epoch treatment. No helper-only API,
fabricated result, automatic replay/repair, stale-contract grant or weakened
closure was added. This is a bounded source finding, not a new crash execution or
full G10 closure. No G10 implementation or case change is included in this
milestone; the separate continuation proposal remains unapplied.


### Frozen S Sol MEDIUM final

All30 tasks completed on the unchanged frozen S0.9.1 runner/hosts-v1: S28/30,
stock25/30. All60 immutable primaries and67 retained attempts are kept (S32,
stock35), capacity-invalid0. Failed primaries are S8/S27 and stock5/21/25/27/30;
each has one separately retained diagnostic, never a replacement. S8/S27 and
stock5/25 reported WebSocket1006; stock23 passed the judge but also reported
WebSocket1006. Those five PRIMARY errors are the only reported runtime errors
across all67; no new cause is inferred from the error code. Stock21 failed all
main/edge checks; stock27/30 passed4/5 main checks and the edge, progress3.

On24 matched passing pairs S7377.048331256141s/stock9827.773780670948s gives
-24.936730%,21 faster/3 slower. Excluding stock23's reported runtime
error gives23 clean pairs, S6971.100903418148s/stock9326.260575299966s,
-25.252990%,20 faster/3 slower. The clean supplement does not replace
failed primaries or the original matched result. These observed correctness and
conditional-time gains belong to frozen S, not current-native source. Usage/cost
remain incomplete, physical/billed cost unknown; MEDIUM publication readiness
remains false and old LOW flags are unchanged.

Same24 matched solver observations, S/stock:303/316 calls,297/288 tools,
1/0 recovery, input including cache3405656/4117915, uncached678616/909723,
cache-read2727040/3208192, output201525/265306, total3607181/4383221,
cache-write0 observed. These are not physical/billing completeness or causation.
Eleven campaigns/705 retained attempts are now complete. S Astra MEDIUM is the
only remaining campaign and will use its unchanged prepared frozen S runner
once this coherent source gap finishes; unfinished W59 work does not hold it.


### G10 original-owner public tool continuation (source scope)

A qualified intent records original selected-tool-owner admission after its
assistant entry ACK and before execution. Per-invocation manager/source/write
generation are captured before initialization and event-queue waits. All intent
writes, including ordinary unqualified ones, use that captured writer; replaced
owners and persisted native-source mismatches refuse rather than redirect.
A recorded intent never proves execution, start, failure or rollback.

The native compiler keeps the original RAW whole group with a mandatory public
constraint. It correlates intent/finalized refs only through the held indexed
branch/frontier and existing source/item bounds. Ordinary/imported/copied-label
intentions do not qualify; absent finalized evidence remains outcome_unknown.
Known finalized evidence must match the original invocation and be present in
the same captured whole group; sibling/future results cannot be borrowed.

Only the real Responses converter receives the bounded pending-group plan. Its
one ordinary traversal suppresses synthetic missing results for those originals
alone and validates original items, IDs, signatures and membership. Actual
current official route/config and unchanged-onPayload checks must enable the
existing public encoder. Every required member becomes descriptive public data,
then the existing v6 epoch ACK precedes adoption and physical admission—even if
the raw request fits budget. Default/unsupported/replaced adapters, actual mode
off and incompatible recipes refuse. The producer checks the accepted public
body; the coordinator separately requires the actual accepted epoch entry.

Public literals retain stable session/entry/intent/result references, original
public text and recorded outcomes, not a moving current leaf/sequence. Private
executed arguments, tool arguments, signatures and reasoning are not rendered.
Accepted source mode overrides creation or previous-branch preferences; defaults
for summaries/exports do not gain the RAW native plan. v6 copy and older
policy/recovery-summary recipes refuse rather than downgrade original ownership.
No automatic execution/replay/reconciliation, new effect/receipt/job store,
probe, production model call or prompt bookkeeping is added. Sol instructions
and W54's exact per-attempt accepted-entry association remain unchanged.

Schema37 (`protocol-11-schema-37-tool-continuation`) and canonical-owner minimum37
use existing stale-daemon handling/incompatible-worker parking; protocol11,
legacy inspection and index16 remain unchanged. There is no forced teardown,
repair or claim that parser refusal alone fenced an old reused owner. Doctor
metadata names actual request4/policy5/tool6 renderers, not runtime readiness.

Two existing offline selectors ran at actual Node22.12.0. The canonical
unqualified copied-label refusal passed first (3797206,3.3596966231707484s).
The services path initially failed (3797201,3.2501375270076096s) because the task
source envelope decoder still rejected the new qualification tag. Only that
allowlist was extended; task authority remains native-admission-only. The same
services selector then passed (3798155,6.975471487967297s), using genuine intent
ACK → controlled post-ACK resource-class stop → real close/reopen → actual native
fake-SSE public request, plus a normal follow-on. Saved-on mode wins creation-off;
the unchanged public literal and exact per-attempt accepted epoch refs survive.
No tool runs and no finalized result is fabricated. The first failure is retained;
the already-passing negative selector was not rerun. Expected controlled budget
refusal stderr is not a provider call or failed case.

Initial formatting found a duplicate local publicBody in the existing services
fixture; the new block was renamed publicToolBody before either case ran. Required
check then found TS2339 for invocationId on the execution-evidence union. The
existing required intent-reference check now narrows that variant; missing refs
still refuse. No fallback, qualification grant or schema weakening was added.

This is not a process-crash/external-effect/installed/platform or whole G10
certification. The doctor expectation changes only with its metadata string;
no extra runtime case or matrix is added.

Corrected required `npm run check` passed (3798599,4.835714657092467s):
1039 files/no fixes, TypeScript, installer and browser smoke. Initial failures
remain recorded; no extra runtime cases or provider probes were run.



### Final S Astra MEDIUM and completed frozen benchmark sequence

Final frozen S `gpt-6-astra` MEDIUM exited0 after4676.512568940991s. S passed28/30
versus stock26/30. There are60 immutable primaries and66 retained attempts
(S32/stock34), zero capacity-invalid. All25 matched passing pairs are runtime-clean:
4109.5781885349425s versus5805.029968667892s, −29.206598230913407%; S faster24/25.
This is conditional paired time, not an all-task/all-attempt or billing claim.

Failed primaries remain S6/S24 and stock12/17/21/24. Each has exactly one retained
diagnostic, not a substitute. S6 and stock17 pass4/5 main checks and the edge but
stop at progress3; stock17 names semantic check4. S24 has no allocations.csv,
main0/edgefalse/progress0; stock24 main3/edgetrue/progress3. Stock21 fails audio,
transcript and all-silence checks (main0/edgefalse/progress1). The sole runtime
error across all66 attempts is stock12 primary `AgentError: WebSocket closed 1006`
at123.30849059601314s; it fails main replay/idempotency (3/5, edge true, progress3).
The error code does not establish a new causal diagnosis. Runner5 regression
entries are not five distinct failed tasks. All original times/errors remain.

Same25 passing pairs, S/stock observational solver calls275/314, tools220/259,
recovery0/0, inputTotal2171943/3271801, uncached454951/652409,
cacheRead1716992/2619392, output103064/151450, total2275007/3423251.
Observed cacheWrite0 is not billing. Physical usage/spend remains incomplete.

All12 frozen campaigns are complete:720 immutable primaries/771 retained attempts.
All six LOW finished before MEDIUM began. H/native remains frozen W32/schema35;
D/S remain frozen0.9.1. W55 and later source were not substituted. No overall
current-native accuracy/cost/efficiency gain or stock Codex CLI certification is
established. Fixed waves are not randomized repeats/significance evidence. LOW
publication flags remain; MEDIUM has no protocol blockers but publication ready
is still no. Completion of these campaigns grants no publication approval.


# Benchmark campaign summary — twelve frozen campaigns complete

All six LOW invocations finished before MEDIUM began. All twelve invocations are
complete: 720 immutable primaries and 771 retained attempts. This is not
publication approval or evidence for later current-native source.

Time is the current variant relative to its matched baseline on passing primary
pairs: negative is faster. It is conditional on both primaries passing, not an
all-task or all-attempt speed claim. Judge pass does not imply a runtime-clean
attempt. Each accuracy denominator is all30 immutable primary tasks.

| Comparison | Model | Effort | Current / baseline pass | Matched pairs | Current time delta | Retained attempts |
|---|---|---|---|---:|---:|---:|
| H/native (W32) | `gpt-5.6-sol` | low | 28/30 / 26/30 | 24 | ≈+8.8% | 66 |
| H/native (W32) | `gpt-6-astra` | low | 30/30 / 29/30 | 29 | -2.770% | 61 |
| D/stock (frozen0.9.1) | `gpt-5.6-sol` | low | 27/30 / 27/30 | 25 | -9.076% | 66 |
| D/stock (frozen0.9.1) | `gpt-6-astra` | low | 29/30 / 29/30 | 28 | -15.284% | 62 |
| S/stock (frozen0.9.1) | `gpt-5.6-sol` | low | 29/30 / 28/30 | 27 | -9.783% | 63 |
| S/stock (frozen0.9.1) | `gpt-6-astra` | low | 25/30 / 27/30 | 24 | -14.546% | 68 |
| H/native (W32) | `gpt-5.6-sol` | medium | 28/30 / 29/30 | 27 | -0.062% | 63 |
| H/native (W32) | `gpt-6-astra` | medium | 29/30 / 28/30 | 28 | +3.759% | 63 |
| D/stock (frozen0.9.1) | `gpt-5.6-sol` | medium | 29/30 / 27/30 | 27 | -17.975% | 64 |
| D/stock (frozen0.9.1) | `gpt-6-astra` | medium | 29/30 / 29/30 | 29 | -26.733% | 62 |
| S/stock (frozen0.9.1) | `gpt-5.6-sol` | medium | 28/30 / 25/30 | 24 | -24.937% | 67 |
| S/stock (frozen0.9.1) | `gpt-6-astra` | medium | 28/30 / 26/30 | 25 | −29.207% | 66 |

## What the results establish

- No overall native accuracy/cost/efficiency gain is established. Native Sol LOW
  was slower on matched passes. Native Astra LOW's runtime-clean supplement was
  slower. Native Sol MEDIUM had lower correctness and effectively even timing.
  Native Astra MEDIUM had higher correctness with slower matched timing.
- D/S conditional gains describe their separately frozen controls. They are not
  current-native results. S Astra LOW had lower correctness despite faster
  matched passing pairs.
- Usage and billed-cost coverage remain incomplete. Missing cost stays null, not
  zero. Observed cached/uncached/output token counts are not physical billing or
  causal timing attribution.
- Failed primaries remain failed. Diagnostics and capacity-invalid attempts keep
  their time, spend and errors; they do not become selected winners. Completed
  invocations have zero capacity-invalid attempts.
- All H/native invocations use frozen W32, not later shipped source. H0.9.3 is
  not stock Codex CLI certification. D/S use frozen0.9.1 controls and runners.
- LOW publication-protocol flags remain in the original reports. MEDIUM's lack
  of that flag does not grant publication readiness or approval.

## Native runtime-clean timing supplements

These supplements keep the original matched results above. They exclude pairs
with a reported runtime error and do not replace failed primaries with diagnostics.

| Model / effort | Runtime-clean pairs | Native time delta |
|---|---:|---:|
| Sol LOW | 22 | ≈+8.2% |
| Astra LOW | 27 | +4.803% |
| Sol MEDIUM | 26 | −0.636% |
| Astra MEDIUM | 27 | +6.807% |

The runs used fixed ordered waves with concurrent comparison arms. They are not
randomized repeated blocks and do not establish statistical significance.

## Completed sequence

The final S Astra MEDIUM runner exited0 after4676.512568940991s. All six LOW
invocations finished before any MEDIUM invocation. Each used all30tasks, one
runner/six workers maximum, exact model IDs and the same read-only ChatGPT
subscription. No frozen runner/candidate was replaced with later source.

## Evidence limits

The native25 Sol MEDIUM primary returned an actual partial public recovery search
result. Two source records contained the report-freshness clause; coverage stayed
partial with unsupported_public_shape. This is not complete recovery or evidence
that recovery caused correctness/time/cost gains.

Native28 Sol MEDIUM remains a failed primary. Its explicit correction-batch import
routing differed from H's nested discovery. Saved fresh-grader commands/outputs
were unavailable. This does not establish lost context, optimizer causation or
an exhaustive sole cause. No solver/corpus patch or diagnostic feedback followed.

Native17 Astra LOW/MEDIUM primary comparison found identical saved clause and
missing CSVs but different comparison-report labels and grouping. The inspected
values and public inputs were present. The saved judge did not define check4 or
expose its failing fresh output. This supports a report-representation difference,
not a confirmed wrong-value bug, missing-context finding, or optimizer/effort
cause. The failed MEDIUM primary remains failed. No solver/corpus patch or
campaign feedback followed.

All four H/native invocations are complete on W32. Later source fixes, including
0f36af6d4, were not substituted into any frozen campaign. All twelve completed
invocations retain771 attempts. Every campaign has zero capacity-invalid attempts.
No further campaign is active; no completed campaign was rerun.


## G12/F21 — known legacy context extension pre-load exclusion

The existing extension loader resolves an entry with Jiti without importing it,
then checks the physical entry's nearest package.json. The actual legacy package
name `prime-agent-context` refuses before target import or factory execution.
Its documented dist/index.js and src/index.ts entries share that owner. The error
names the native replacement and tells the user to remove the old package/path
from packages, extensions or -e/--extension. Ordinary extensions keep the current
API and load-error flow. Prime source, archives, host and processes are untouched.

This loader executes inside native daemon/session workers through runtime service
creation and DefaultResourceLoader.reload. Schema38
(`protocol-11-schema-38-native-extension-owner`) and canonical-owner minimum38
therefore use the existing stale-daemon/worker compatibility path to reject an
old selected loader. No new lifecycle mechanism, forced teardown or unpatcher is
added. Protocol11, index16 and request4/policy5/tool6 renderers are unchanged.

The exclusion uses known package identity, not authenticated code provenance or
arbitrary source matching. Renamed/copied code, wrappers/transitive imports,
caller-supplied inline factories, private monkey patches and hostile filesystem
replacement are not detected or certified. This is not a sandbox, complete
migration/rollback workflow or whole-G12 completion.

Exactly two existing offline discovery selectors passed first at actual
Node22.12.0 (3804410,1.2318190038204193s;2pass/25skip). One loads an ordinary
manifest extension. The existing initializer-failure case retains its original
phase, then checks known-legacy refusal and absence of a top-level file marker.
The real Prime plugin is never imported. No new case/suite/matrix, provider call,
probe or extra runtime dependency. Required `npm run check` also passed first:
1039files/no fixes, TypeScript, installer and browser smoke. No runtime reruns.

The preceding qualified tool-continuation path is committed as `0e35c5c9b2b4c95c470c96a435c9888db4a7f3b8` (35files/1303+/92−). Its two existing focused selectors and corrected requiredcheck pass; normal commit hooks pass, clean `build:source` passes. Frozen benchmarks remain unchanged.


## W66 / G01 — serialize current orphan-process writers

Current Node and Python orphan writers capture their original path/owner before
bootstrap waits or command spawn. One existing-pattern SQLite sidecar mutex spans
incomplete-tail admission, complete JSONL writes, file fsync and descriptor close.
The connection closes last. SQLite stores no process/job/receipt data. A partial
write stays in place; the next participating writer refuses it without repair.
Write errors remain first, followed by distinct descriptor/owner cleanup errors.

Node tracking is still post-spawn. Shell and autonomous commands install their
existing timeout, abort, output and completion controls before the synchronous
bridge. Registration failure retains the actual handle until settlement/cleanup,
not a fictional unstarted command. Autonomous tracking errors escape before gate
retry classification or unavailable-snapshot fallback; the error cause retains
the observed result/status/signal/output. Ordinary execution errors keep their
existing result behavior. The existing outer lifecycle diagnostic ends the run
and is excluded by session retry admission; this is source evidence, not a claim
of an unsynthesized outer refusal. Kernel startup keeps its original error and
actual child cleanup. Retirement retains the original owner and existing drain.

Python enrollment failure keeps its existing command gate closed and invokes the
existing abort path. It retains the original I/O error, then cleanup errors. Only
existing resource/group-absence state determines confirmed cleanup/quota release;
failed enrollment alone does not establish that the spawned process was killed.
Background retirement reports uncertainty without abandoning shutdown drain.

Daemon schema39 (`protocol-11-schema-39-orphan-writer-owner`) and owner minimum39
use existing stale-worker handling. TS/Python kernel protocol4 and bootstrap
schema11/readiness4 use existing ready checks and installed-runtime reuse rules.
Current fixture metadata follows those versions; deliberate old/mismatch inputs
remain. Existing runtime source identity already covers the changed Python files.
No extra cache/hash mechanism, dependency, PID registry, journal format, repair,
append replay, forced teardown or lifecycle policy is added. The external-Node
worker is included in the existing source/dist/native packaging paths.

The mutex only coordinates participating writers. Old binaries can ignore it;
read/clear still depends on existing accepted shutdown drain. Node's post-spawn,
pre-registration crash window remains. The five-second lock wait/ten-second Node
helper timeout can block the host thread, delaying timer delivery even with
controls installed first. No hard-wall deadline, fairness, power-loss/directory
persistence, universal filesystem/platform or whole-G01 completion is claimed.
Sol instructions, Prime processes and all12 frozen campaigns are unchanged.

Exactly two existing offline selectors now pass. Node registration/retirement
passed first on actual22.12.0 (3825110,1.018226739950478s;1pass/4skip). It uses the
real external-Node SQLite writer and retains its captured path after environment
drift. Python gated short-write first failed (3825115,0.08898586686700583s): the
fixture compared a canonical Path with a string, so it never injected the fault.
The command was not demonstrated to stay gated by that failed case. Its later
SQLite warning followed temporary-directory teardown, not a proved mutex defect.
The fixture now compares canonical path strings. Only that affected selector was
rerun (3825456,0.09537421888671815s;pass): original I/O error first, retained partial
prefix, cleanup tail refusal, later-owner refusal, no command marker and actual
process-group/admission cleanup. Production code did not change for this fix.
Required `npm run check` passed first (3825461,4.9721702160313725s):1040files/no
fixes, TypeScript, installer and browser smoke. No extra case, suite, live probe,
Node reassurance rerun, installed/native-platform or whole-process claim.

## W67 / G14 — owned POSIX installation and paired selection

The user approved the owned layout and exact human-facing installer name
**Base-Context**. Publication remains unapproved. The shell installer and owned
self-update use one bundled installer owner rather than modifying an external
package-manager global tree. A unique version directory contains the CLI, shipped
runtime payload and release-local default Python environment. Candidate npm and
runtime preparation run inside that directory. The candidate's bundled
`installer.mjs prepare` must finish runtime/default-import readiness before selection;
ambient Python/venv overrides cannot stand in for its prepared default runtime.

One `current.json` records generation, active and previous together. The switch
captures its expected selection before effects. An external Node worker, launched
with child-only `--experimental-sqlite`, holds the SQLite mutex and compares the
generation before rename. Node executable, environment, worker entry and original
parent are captured before waits; Bun also uses external Node. Previous comes from
the actual held selection. A returned accepted selection survives later helper or
cleanup failures. Missing or malformed helper output stays uncertain, without
candidate deletion or rollback. The synchronous bridge can block the caller;
its timeout is not a hard-wall or fairness guarantee.
Initial stable launchers are published as complete files under that same owner.
Explicit `base-context-install rollback` selects the retained previous pair through
the same switch. Failed preparation does not replace the old selection. Old and
failed candidates remain on disk; there is no automatic garbage collection or new
state table. A known accepted activation and a later cleanup failure remain separate
facts, with the failed status retained rather than reported as complete success.

Running owners remain bound to their physical package/runtime paths. The existing
restart coordinator launches the selected physical CLI, uses that release's default
daemon socket, and retains an exact explicit/custom socket. Its existing registry
and lease use the stable owned root within the existing home/install scope; actual
daemon sockets remain release-physical. The interactive updater captures one
physical target after child settlement and before teardown/restart awaits, then
uses that same target for restart and relaunch. Observing a different selected pair
still requires predecessor coordination even when the child reports a failure; it
does not establish which updater accepted that selection. Existing predecessor
preparation, drain, fence and recovery remain authoritative. No daemon/schema,
kernel/bootstrap or history-index version changes are needed for this route.

The default owned root is `${XDG_DATA_HOME:-$HOME/.local/share}/base-context`, or
`BASE_CONTEXT_INSTALL_ROOT`. Standalone Node stays in the separate `base-context-node`
root. PATH guidance precedes Run guidance. Installer predicates and messages now
match the shipped Node range `^22.12.0 || >=23.3.0`. CLI/package/environment names
remain `base-context`, `@ponythewhite/base-context` and `BASE_CONTEXT_*`.

**Scope limits:** existing npm/pnpm/yarn/bun global trees keep their own updater and
are outside paired rollback. Running processes and session data are not rolled
back. Normal Python Skill synchronization remains unchanged; retained venvs are not
immutable snapshots or sandboxes. There is no Node rollback, Windows/Homebrew/binary
installation guarantee, automatic repair, power-loss/universal-filesystem guarantee
or complete migration claim. Frozen benchmarks, subscription auth, Prime state and
Sol's custom instructions are unchanged. Whole G14 and release completion remain
open outside this owned route.

The first focused run (3851419,2.4425214750226587s) failed both existing selectors
at `owned-install.ts:100`: `No such built-in module: node:sqlite`. Node22.12 needs
`--experimental-sqlite`; this was a production activation-path gap, not a fixture
failure. The first log is retained. The external-Node correction was formatted
once (3859815,0.07831983803771436s;3files/fixed3). Only the same two affected selectors
reran (3859954,2.7806692151352763s):2passed/26skipped, actual external Node22.12 and
SQLite activation/rollback, captured request inputs and candidate cwd, retained old
pair after failed preparation. npm and Python preparation remain offline boundaries;
these fixtures are not a real package install or working-Python installation claim.

Required `npm run check` passed first (3860215,4.877740819007158s):1044files/no fixes,
types, installer and browser checks. No provider call, dependency download, actual
installation, publication, new benchmark or earlier-milestone reassurance rerun.

## W68 / G09 — selected Skill instruction versions in native epochs

The genuine native `prime_context` route adds the fixed action
`{"action":"skill","name":"..."}`. Explicit host-owned `/skill:name` uses the
same captured descriptor/body owner. Full bodies are read only on selection or
invocation, under the existing limits. Captures live in the existing canonical
source, not a separate version registry, body cache or filesystem snapshot.

Queued command captures are not active context. Their scoped reference becomes
selected only when the actual primary input consumes its captured expansion.
Queue edits and body replacements cannot add a binding from copied markup.
Model capture records do not insert user messages inside assistant/tool-result
replay groups. The actual tool result or explicit input carries the body; a small
source-backed view carries selected refs. Ordinary and fixed/off request admission
check those refs against the accepted epoch. Existing boundaries permit a later
version selection. Rotation, cold recovery and supported source copies keep the
original captured material available by reference. The existing v6 tool-continuation
copy refusal remains unchanged.

Root chose capability-based advertising as a technical decision: native model
selection is not advertised when the genuine recovery definition is replaced,
overridden, inactive or outside the allowlist. A disabled capability is not enabled
implicitly, and otherwise valid native admission does not fail merely because skills
are installed. Explicit `/skill` still supports hidden/disabled-model skills and the
effective loader ordering. Generic non-native behavior stays unchanged. Existing
selected source material is not erased when tool policy changes.

Selection-bearing v4/v5/v6 epochs use `native-canonical-epoch/7`; older readers refuse
that marker. Only queued snapshots carrying a selected source binding use action
format2; unaffected snapshots keep format1. The real restart parser preserves the
supported version and validates the binding before forwarding it. Binding use stays
on the original session/file namespace; there is no cross-session queue rebinding.
Daemon schema/minimum40 (`protocol-11-schema-40-selected-skill-epochs`) fences the new
selector and queued field. Protocol11, history index16, kernel4 and bootstrap11 remain.
Doctor reports the selected-skill renderer in addition to the existing variants.

**Limits:** these are captured instruction bodies/descriptors, not frozen Python
packages, scripts/assets or immutable venvs. Normal Python Skill synchronization
and Sol's custom instructions are unchanged. Existing capture/recovery byte and
item limits can refuse work. This is not complete malicious-history learning,
filesystem isolation, platform, billing or full G09/goal certification. The skill
guide uses the actual owned paths and runtime overrides instead of directing writes
to Prime. W67 and all frozen campaigns remain settled; publication is unapproved.

The two existing focused selectors passed first on actual Node22.12 through project
tsx and package Vitest (PID3898155,7.812779288971797s;2passed/32skipped). The services
case used fake SSE for selection/source/ACK/version reuse and cold recovery. The
restart case used its existing mocked endpoint to preserve action2 and refuse bad
ref shapes/format1 bindings; it is not destination writer/body certification.
Controlled budget-refusal stderr is fixture output, not a live provider incident.

The first required check failed (PID3898703,4.407891002018005s): TS2339 for the
nonexistent `Agent.setSystemPrompt` in agent-session.ts:1492, TS2322 for the broad
ContextRef kind in selected-skills.ts:206, and TS18048 for an optional captured ref
inside session-manager.ts:2918's callback. The first error identified a real bad
method call in the policy-refresh branch; the focused case did not exercise that
branch. It was replaced with the existing `agent.state.systemPrompt` assignment.
The other corrections explicitly retain the narrowed custom-message kind and a
local selected ref across callbacks. No parser, test matrix or unrelated source
was changed. Only the affected services selector and required check were rerun.

The affected services selector passed (PID3899017,9.221652266802266s;
1passed/5skipped). The parser selector was not rerun. Corrected `npm run check`
passed (PID3899022,5.343376633012667s;1045files/no fixes,
types, installer and browser checks). Both runs used the existing isolated source
environment. No live provider, benchmark, installed lifecycle or publication run
was made. These receipts do not establish current-native overall gains or physical
billing. The active implementation/release objective remains incomplete.

## W69 / G07 — independent compaction model and effort

An explicit `compaction.model` object selects `provider`, `modelId` and
`thinkingLevel` together for the existing owned compaction summary path. All three
fields are required when the setting is present. Resolution uses the local model
registry and that model's existing effort rules. Invalid or unsupported choices
refuse instead of silently falling back to the main model. With no setting, the
existing main-model/current-effort behavior remains. Learning still uses the
separate `autoRefine.model` setting from W45.

The manual and automatic/model-requested compaction callers capture the selected
model/effort before their authentication and summary-history waits. They do not
change the main session model or its overflow trigger. The existing summary and
split-turn-prefix generators use the passed choice, existing coordinator purpose,
request measurement, cancellation and physical attempt receipts. Accepted summary
adoption still requires the original captured source's canonical append ACK.
No extra automatic call or parallel summary owner is added. Extension-provided
summaries and generic standalone calls retain their existing behavior.

An enforced request budget must explicitly cover the actual auxiliary API, provider,
endpoint and model within the current supported API set (`openai-codex-responses`,
`openai-responses`, `openai-completions`). The setting does not synthesize a profile,
widen API support, infer availability from the main model or bypass an unknown/
over-budget refusal. Configured model/effort support is not deployment entitlement
or pricing evidence. This is not an independent spending/call-count budget,
semantic-extraction configuration, branch-navigation summary setting or full G07
completion. Context-off/shutdown admission, generic behavior and Sol text remain.

Daemon schema/minimum41 (`protocol-11-schema-41-compaction-model`) prevents current
native commands from reusing an older worker that ignores the explicit choice.
Protocol11, history index16, kernel4/bootstrap11, epoch variants and queued-action
formats do not change. No provider, benchmark, installed lifecycle or publication
activity is authorized by this setting. W68/W67 and all frozen campaigns remain
settled; the implementation/release objective is still active.

Both agreed existing selectors passed first on actual Node22.12 through project
tsx and package Vitest (PID3908124,5.168437144020572s;2passed/36skipped).
The happy path kept the main conversation on its local Faux model and sent both
auxiliary summaries through the real OpenAI Responses adapter with only HTTP
fetch replaced. It observed the explicit different model/high effort, captured
settings across source-read work, owner-bound physical receipts, canonical summary
adoption and unchanged main model/effort. That fixture retained its original absent-
budget policy: it is not positive enforced-profile coverage or deployment evidence.

The edge case retained the original missing-auth assertion. An unknown explicit
model refused before auth/source binding. A known explicit model on the actual
requested/automatic path refused under enforce with no covering profile, without
fetch or accepted compaction. The controlled budget-refusal stderr is not a live
provider incident. No new selector, suite, harness or test matrix was added; the
existing harness only forwards the optional request budget.

Required `npm run check` passed first (PID3908129,5.044830980943516s;
1045files/no fixes, types, installer and browser checks). No correction or focused
rerun was needed. No provider, benchmark, installed lifecycle or publication run
occurred. These source receipts do not establish cost/efficiency gains, physical
billing or completion of the active implementation/release objective.

## W70 / G07 — independent branch-summary model and effort

An optional `branchSummary.model` selects `provider`, `modelId` and `thinkingLevel`
together for built-in tree-navigation summaries. Its explicit choice is separate
from W69 `compaction.model` and W45 `autoRefine.model`. Invalid, unknown or unsupported
explicit choices refuse rather than silently using the main model. An absent
setting preserves the existing main-model and omitted-request-effort behavior;
it does not forward the main session's effort or certify reasoning is disabled.

The actual `navigateTree` summary path uses one captured choice with the existing
`generateBranchSummary` producer, coordinator purpose `summary`/detail `branch`,
request budget, cancellation, physical receipts and acknowledged destination
adoption. It preserves original source/target ownership and does not change the
main model/effort. Explicit effort follows existing provider option semantics.
Extension-provided summaries, no-summary navigation and standalone omitted-effort
calls retain their existing behavior. The change does not add automatic summaries
or change branch-summary prompt/skip policy.

Enforcement still requires explicit coverage for the actual supported auxiliary
route/model. There is no profile synthesis, wider provider support, inferred
entitlement, parallel summary owner or separate receipt store. This is not an
independent auxiliary spending/call-count budget, semantic extraction or full G07
completion. Existing Sol/custom prompt text remains unchanged.

Daemon schema/minimum42 (`protocol-11-schema-42-branch-summary-model`) fences reuse
of workers that ignore the explicit setting. Protocol11, history index16,
kernel4/bootstrap11, epoch and queued-action formats remain unchanged. W69/W68/W67
and all frozen campaigns stay settled. No live provider, benchmark, installed
lifecycle or publication activity is authorized; the overall objective remains
active and incomplete.

The two agreed existing selectors passed first on actual Node22.12 through project
tsx and package Vitest (PID3917516,5.488804213935509s;2passed/26skipped).
They were relocated from the live-gated tree-navigation suite into its existing
offline runtime suite. Old definitions were removed; the other eight live cases,
their auth gate and setup were unchanged and unrun. No auth/environment change,
new case, suite, matrix or harness was added.

The happy path used a local Faux main conversation and the actual OpenAI Responses
adapter/coordinator with HTTP fetch replaced. It observed the explicit different
model/high effort, auxiliary-model auth, detached selection across a target read,
owner-bound receipt and acknowledged root-destination summary, with the main model/
effort unchanged. The second case retained in-flight cancellation and added an
unknown explicit-model refusal before target read/auth. Its cancelled native receipt
settled without a summary or transcript-branch/leaf change. These fixtures retain
absent-budget policy; they are not positive enforced-profile, off-level deployment,
independent spending-budget or live-provider evidence.

Required `npm run check` passed first (PID3917521,5.427920550107956s;
1045files/no fixes, types, installer/browser checks). No correction or focused rerun
was needed. No live provider, benchmark, installed lifecycle or publication run was
made. Source results do not establish cost/efficiency gains, physical billing or
completion of the active implementation/release objective.

## W71 / G08 — bounded native saved-session pages

The native saved-session catalog and agents-view consumer use bounded query pages
rather than collecting, merging, sending and retaining the whole saved archive.
The existing `list_saved_sessions`/catalog operation remains the route. Its saved
page budget is at most64 rows, including required ancestor/context rows, and1MiB
encoded page data. The separate live roster remains outside that saved-page budget.
Source iteration still uses W55 indexed per-journal summaries and its bounded
optional cache; this does not reopen or replace W55's native history-read path.

Search/scope filtering, passive-descendant identities/dedup and needed relationships
are part of page selection. Relevant colliding saved file/session aliases refuse
explicitly as ambiguous sources; no full alias-group reconstruction or archive
alias index is claimed. Required parents, cursor and bounded display facts share
that refusal boundary. An oversized required row/closure is an explicit scoped
refusal, not clipped relationships, false absence or a full-array fallback. Page
selection does not keep all paths, all rows, a full presence set or an all-results
sort under another name. The consumer replaces/releases pages and bounds pending
query work instead of accumulating progress rows, pages or cursor history.
Page-derived counts/rollups are not presented as whole-archive totals.

Root chose preservation of the actual agents-view order: section, empty-session/
anchor, heartbeat and busy-descendant priorities, then the existing activity,
creation, title and ID ordering within the hierarchy. Modified/path alone is not
that order. Continuation uses the existing ordering context and row identities;
relevant context changes reset the saved page. No new snapshot registry, index,
cache, hash or ranking scheme is added. This is live paging, not a frozen snapshot
or completeness claim across concurrent metadata changes. Refresh may be needed.

Metadata traversal can revisit sources for ancestry and ordering. These
page/request/component limits do not establish global heap/RSS, bounded latency,
disk or live-roster size. Generic `SessionManager.list`/`listAll`, internal array
callers and `DaemonAgentConnection.listSavedSessions` retain full-array contracts;
collecting native pages into an explicit generic array is not a bounded-retention
claim. Generic row callbacks run after page receipt; old per-file scan progress/totals
are not fabricated. The actual agents view consumes/replaces pages directly.
The existing per-ledger projection remains limited to32MiB/100,000 records; native
page reads require complete tails and known operations, without changing generic
readers or write/repair owners. Existing catalog
queue/shutdown ownership and source-read errors remain explicit; no index-error-as-
absence or legacy full-history scan fallback is introduced. No model call is used
to search or page sessions.

Daemon schema/minimum43 (`protocol-11-schema-43-saved-session-pages`) fences the
changed native catalog request/reply contract. Protocol11, per-journal history
index16, kernel4/bootstrap11, epoch and queued-action formats stay unchanged.
W70/W69/W68/W67 and all frozen campaigns are settled. No provider, benchmark,
installed lifecycle or publication run is authorized; the overall objective
remains active and incomplete.

The separate known package-README correction replaces upstream product install/
control/state/package guidance with owned Base Context guidance and source-only
availability. It distinguishes native captured Skill instructions from generic
mutable Python/file reads. Existing provider wire/env names, inherited conventions,
Python `rlm` import, legal ancestry and historical screenshots remain. No installer,
provider/auth behavior, Sol prompt, publication or platform-support decision is
changed by that documentation correction.

The two agreed existing offline selectors passed first on actual Node22.12 through
project tsx and package Vitest (PID3958288,29.356284932000563s;
2passed/216skipped). The source/direct-daemon case used real session journals and
the existing persisted RLM fixture for page/default/order/next/previous/search/
ancestor paths, no all-row progress, encoded-byte refusal and no runtime hydration.
The agents-view case used real consumer methods with a mock transport for scope
retention, one-active/one-latest search, stale-result rejection, next/previous page
replacement and loaded-only notice. No new cases, suite, matrix or harness were
added. The ambiguity-refusal boundary is source implementation, not a claim of
separate runtime coverage. These cases do not measure archive-scale latency or
certify global memory, a frozen snapshot, or every transport path.

Required `npm run check` passed first (PID3958293,5.054459482897073s;
1046files/one formatting fix, types, installer/browser checks). No failing case or
check, runtime correction or focused rerun occurred. Source review before applying
identified the saved-alias ambiguity; one refreshed private alternative fixed that
boundary and removed the unused local. Only the refreshed full alternative was
applied. The original artifact was never applied.

The known package README correction was integrated in the same change without a
separate pipeline. No live provider, benchmark, installed lifecycle or publication
run occurred. No current-native overall accuracy/cost/efficiency or complete G08
claim follows from this bounded listing path; the overall objective remains open.

## W73 / G12 — explicit single-session retained import

`base-context session import <file>` connects the existing public session command
handler to `SessionManager.importRetainedFrom`. It accepts one explicit file path,
uses the current destination cwd and normal owned session-directory default,
reports the resulting path, closes the returned manager and returns before runtime
creation. It does not discover a source by session ID or route through resume/fork.

The existing copy owner handles both native-framed and supported legacy data with
forced retained-import semantics. Copied labels do not establish native task
admission. Existing conversion, entry/JSON-byte limits, acknowledged destination
writer/index, copied epoch/resource rules and version6 tool-continuation refusal
remain their owners. No second copy engine, index, authority store or checksum
scheme is added.

The explicit retained-import API now requires a supported header (missing/v1,
v2, currentv3) and complete LF-terminated records within its captured descriptor/
size. Future/invalid versions and incomplete tails refuse before destination
construction. Ordinary captured-prefix readers and `--fork` retain their existing
semantics. This is not an atomic writer snapshot or completeness guarantee across
concurrent source mutations. The existing16,384entries-after-header/64MiB consumed
JSON limit includes header bytes, not raw framing size or a global heap bound.

The original source is read-only. A later copy/activation failure may leave an owned
destination; no automatic deletion or rollback is added. A known successful import
is not reclassified as rolled back if close/reporting then fails. No credential,
settings, package, Python/kernel/process, whole-root migration or full G12 rollback
workflow is claimed. No daemon protocol/schema, history-index, kernel/bootstrap,
epoch or queued-action format change is required by this local command/API path.
W72 auxiliary-budget defaults remain unapproved and unchanged.

The two agreed existing offline selectors passed first on actual Node22.12 through
project tsx and package Vitest (PID3976053,2.857291626976803s;
2passed/68skipped). The public-command case kept its existing export/model rewrites
and exercised the real import owner using a native-framed admitted source. It
observed retained-import on copied data, unchanged source bytes, the reported new
owned path/new session ID, and reopening after the command closed its manager.
Existing unrelated command mocks were not invoked. This is public-handler evidence,
not a separately launched/installed CLI or platform certification.

The existing LF-boundary case exercised incomplete-tail refusal before destination
creation, retained the source unchanged, and confirmed that ordinary fork still
accepts its captured complete prefix. Supported/future-version handling is source
implementation, not a separate version-matrix runtime claim. No new cases, suite,
matrix, harness or provider setup were added.

Required `npm run check` passed first (PID3976058,5.054137552157044s;
1046files/no fixes, types, installer/browser checks). No failing test/check,
correction or focused rerun occurred. No user session, credential store, settings,
package, Python/kernel/process migration, live provider, benchmark or publication
run occurred. Whole-product migration/rollback, current-native gains and completion
of the active objective remain unclaimed. W72 budget defaults are unchanged and
still awaiting the user's decision.
