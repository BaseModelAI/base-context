# Base Context Harness
## Source-owned, model-universal coding harness with bounded working memory

**Status:** Proposed implementation contract, not an implemented release or a claim of measured improvement.  
**Prepared:** 6 September 2026.  
**Audience:** The coding agent implementing the fork, code reviewers, release owners, and benchmark maintainers.  
**Product name:** Base Context; proposed CLI `base-context`. Package and organization names below require ownership checks before publication.  
**Starting point:** The supplied Prime Agent 0.9.3 source, supplied Prime Context development source, and a separately frozen public Sol implementation.  

> Fork the product, not the model policy. Own the execution loop, evidence lifetime, provider boundary, scheduler, and release. Keep one shared runtime, separate Sol/generic and Astra behavioral policies, and independently validated provider capabilities. Let the model reason; make exact information cheap to recover without requiring the model to administer its memory.

**Reading map:** §§1–9 specify the fork and migration; §§10–21 define the shared memory/runtime and model policies; §22 defines measurement; §23 assigns implementation work; §24 specifies acceptance tests; §§25–26 define deliverables and evidence.

## 1. Decision: make a maintained product fork, not a renamed plugin

### 1.1 Binding decision

Create **Base Context as a source-owned fork of Prime Agent 0.9.3**. Integrate Prime Context's valuable mechanisms directly into the harness. Eliminate installation-time rewriting of another product's compiled JavaScript, declarations, bundled CLI, and nested dependencies. Build all public surfaces from the same source graph.

This is not a clean-room rewrite. Retain working provider integrations, tools, terminal UI, SDK, daemon, session plumbing, and Python execution behavior until a measured or correctness-driven change justifies replacing them. Extract responsibilities incrementally behind typed interfaces and regression tests. Preserve Git ancestry and source attribution.

This is also not a permanently rebased downstream branch that must follow every upstream release. Own an independent release line and **selectively backport** useful upstream security, provider, correctness, and maintenance changes. An upstream version is an input to review, not a mandatory Base Context upgrade.

The standalone Prime Context plugin becomes a frozen compatibility/baseline product, not a second place to implement new optimizations. Its old source, fixtures, artifacts, and installation instructions must remain recoverable for evaluation and migration. Critical legacy maintenance may be time-bounded and explicitly owned; it must not create indefinite two-product feature parity obligations.

### 1.2 Why a fork is warranted here

The supplied patcher is 5,998 lines long. A static inventory found 391 patch-label occurrences and 32 distinct literal `applyPatches(...)` target paths, plus dynamically addressed bundled paths not counted by that inventory. These counts describe maintenance surface, not 391 unique bugs. The patcher already changes execution, compaction, model catalogs, goals, daemon behavior, resource limits, accounting, and exported types. [N1]

For this particular project, the plugin boundary has stopped being a clean boundary. The most valuable next changes—bounded native history, exact execution events, atomic compaction, resource reservations, and complete inference receipts—belong inside the host. Trying to preserve an external patch architecture while changing those owners creates duplicate implementations and weakens type/build guarantees.

A fork removes **patch-format maintenance**, not **software maintenance**. Base Context assumes responsibility for security fixes, dependencies, provider changes, installers, daemon behavior, operating-system support, and data migrations. The decision is justified only with the ownership and release gates in this specification. Forking by itself does not prove lower cost or higher accuracy.

### 1.3 Alternatives and rejection criteria

| Option | Benefit | Principal cost | Decision |
|---|---|---|---|
| Keep the current plugin and compiled-output patcher | Small apparent repository ownership; easy access to upstream releases when replacements still match. | Deep coupling already exists; multiple generated surfaces can diverge; host lifetime and memory remain difficult to own. | Retain only as a frozen baseline/migration target. |
| Upstream a small context ABI and remain a plugin | Potentially low long-term divergence if upstream accepts and maintains the required semantics. | No demonstrated agreement on the necessary storage, execution, and continuation ownership; delivery depends on another project's priorities. | Offer narrow upstreamable fixes, but do not make Base Context delivery depend on adoption. |
| Maintained source-owned product fork | Direct correctness ownership; one build; freedom to integrate memory and fix inherited faults. | Must own releases, providers, security, and selected upstream intake. | **Selected.** |
| Clean rewrite of the entire harness | Maximum theoretical design freedom. | Recreates mature provider/UI/runtime behavior before validating the memory improvements. | Rejected for the initial implementation. |
| Separate Sol and Astra harness forks | Independent experiments. | Duplicate correctness, storage, tool, and release work; divergent semantics. | Rejected. Use policies and capability adapters. |

Reconsider the deployment choice only if the actual deep integrations become unnecessary or an upstream contract genuinely supplies them with adequate ownership. Do not preserve an elaborate abstraction solely to make a hypothetical future unfork easier.

### 1.4 What success means

The product must improve task success and avoid unnecessary work, with fully accounted cost and latency. It must support sessions whose retained history grows without proportional growth of the **rendered working set or decoded hot history**, under explicit configured limits.

This is not a claim of literally infinite storage, perfect retrieval, or arbitrary information fitting simultaneously into a fixed-size prompt. Exact retained storage necessarily grows with retained evidence; some questions require multiple bounded reads. If mandatory information cannot fit, the harness must recover, stage, or explicitly report the limit—not silently delete requirements or produce a protocol-invalid request.

Correctness, data integrity, permissions, protocol validity, and honest accounting are release constraints. Token counts and compaction counts are useful measurements, not goals that justify worse solutions.

## 2. Inputs, provenance, and evidence boundaries

### 2.1 Freeze these distinct baselines

| Label | Identity | Role |
|---|---|---|
| **H — upstream source control** | Supplied Prime Agent 0.9.3; ZIP comment identifies `9c54a35dac3a2ad17910074d66664859ea175666`. | Fork ancestor and host-only regression control. The release page also identifies v0.9.3 and `9c54a35`. [U1] |
| **D — supplied development candidate** | Prime Context package 9.2.0; handoff identifies `ee83ff8`, `astra-v3-pc-round04-quit`; dependency/patcher target is host 0.9.1. | Source of audited context mechanisms and Astra experiments, not the proven public Sol baseline. |
| **S — public Sol control** | Prior review observed public main `8fd60de83cb9b0506c7a4d1b13014e9316a151e4`; public metadata reported package 9.2.0 on host 0.9.1. | Required exact source/artifact freeze before claiming Sol behavior preservation. That pin must be fetched and verified, not treated as the current live head. |
| **S-old — historical comparison** | Host-0.8.1-era lineage, including previously recorded `a726ad8c2cc01453ec0bd874121ba8f3f914a503`. | Optional historical experiment, not a requirement to support an old host ABI in the new product. |
| **B0 — source-fork control** | New Base Context build from H with product isolation and explicitly enumerated source ports. | Behavior-preserving migration control; record which public Sol or development variant it reproduces. |
| **B1+ — experimental builds** | Individual integrity, storage, compiler, continuation, execution, or model-policy changes. | Independently attributable experiments, not an undifferentiated rewrite. |

```text
prime-context-dev.zip
211238b5862a2f4946d98b8783de6c8f71c1a0860c0e68d04988310f9bd79439

prime-agent-main (1).zip
3906c03714fa6f70e5205ab89f47133fae1bef68b1e2c6f50393da4698a8d8cb
```

Create immutable manifests containing Git commits, archive hashes, lockfiles, Node/Python versions, generated model catalogs, tool schemas, prompts, skills, provider route/configuration, pricing snapshots, benchmark fixture hashes, and known defects. A package version is not a complete identity.

### 2.2 What this revision actually verified

The local supplied trees were inspected. This revision adds a reproducible static patch/identity inventory, a release-renaming characterization, and an isolated event-log short-write fault injection. Earlier context/state/accounting probes are retained as earlier evidence, not represented as newly executed tests. The exact public Sol TypeScript tree was still unavailable: public retrieval attempts and container network attempts did not yield that source. [N1–N4, T1]

Therefore, the coding agent must fetch and freeze S and diff it against D before certifying Sol parity. It may proceed with local H/D correctness work while that retrieval is unresolved, but must not substitute D for S, claim a full public-source comparison, or promote changed Sol defaults without the control.

No complete repository build, full test suite, live-provider validation, installed-package integration test, or thirty-task campaign was performed for this revision. New performance benefits remain design hypotheses. The user's reported roughly 60% public Sol cost saving is a baseline claim to reproduce with its original denominator and configuration, not a guaranteed result of the fork.

### 2.3 New fork-specific findings

| ID | Evidence | Consequence |
|---|---|---|
| N01 | Source inventory: 5,998 patcher lines, 391 label occurrences, 32 literal target paths; bundled paths add further surface. [N1] | Convert semantic changes into native source implementations; remove compiled-output patching. |
| N02 | Extracted release-packer functions accept a new package and binary name but retain `.prime/agent`, the upstream repository metadata, and upstream-scoped internal dependency keys. Reproduced without building a package. [N2] | A rename alone is not product isolation. Establish a complete identity matrix. |
| N03 | Source retains `prime-agent.daemon`, `.prime/supervisor-owners`, upstream release URLs, Python distribution/bootstrap identities, and an upstream coding-agent dependency. [N1, N5–N8] | Separate daemons, updates, state, runtime installation, and dependencies before running both products. |
| N04 | In isolated fault injection, `EventLog.appendSync` returned success after the mocked filesystem wrote 7 of 74 intended bytes; it made one write and one fsync and left no complete record. [N3] | Implement checked writes and durable publication before using the log as correctness-critical truth. This demonstrates the source-level short-write assumption, not the frequency of real OS failures. |
| N05 | The AI package's ordinary build invokes model generation; the generator contains external catalog fetches. [N9] | Separate intentional catalog refresh from reproducible release builds. |
| N06 | The release packer's explicit staging copy list does not name `LICENSE`. The root source license is MIT with retained upstream copyright notices. [N1, N10, U2] | Verify every real distribution artifact includes required notices. No published tarball omission was established by this audit. |

### 2.4 How to classify inherited issues

Use `SOURCE-CONFIRMED`, `PROBE-REPRODUCED`, `DOCUMENTED-UPSTREAM`, `INTEGRATION-RISK`, `DESIGN-PROPOSAL`, and `BENCHMARK-VALIDATED` in the change ledger.

Upstream issue trackers are regression-test seeds, not proof that every reported symptom remains present in H. Relevant categories include transcript/compaction recovery, interrupted task lifecycle, daemon ownership, persisted-state crash safety, configuration parsing, and release reliability. Review the exact pinned source and reproduce each symptom before assigning a fix. [U3–U4]

In particular, 0.9.3 documents specific descendant-cancellation and heartbeat/passivation improvements, request lineage changes, and summary-settlement fixes. These do not establish that child capacity is atomically reserved or that all concurrent-agent cases are safe. Preserve useful fixes while testing remaining invariants. [U1, H1–H3, H7–H10]

## 3. Source ownership and repository architecture

### 3.1 Keep the useful monorepo boundaries

Retain the existing package directory layout initially. Rename ownership/public package identities where necessary, without a wholesale file move or terminology substitution. The proposed structure is:

```text
packages/
  ai/                          provider adapters, replay/rendering, raw usage
  agent/                       generic turn/tool sequencing and service types
  coding-agent/
    src/core/context/
      events/                  canonical event identities and validation
      store/                   evidence locators, indexes, bounded caches
      state/                   descriptive task and execution reducers
      compiler/                working-set closure, selection, epochs
      recovery/                exact and indexed recovery
      profiles/                Sol/generic and Astra behavioral policy
      continuation/            summaries/checkpoints and commit coordination
      telemetry/               request receipts and completeness
    src/core/execution/         reservations, jobs, resource generations
    src/core/session-manager.*  incrementally paged source history
    src/modes/                  CLI, SDK/RPC, daemon, presentation adapters
  tui/                         rendering and user input; no correctness owner
prime-agent-runtime/            directory may stay during initial migration
  src/rlm/                     compatible Python import; owned distribution
```

Do not create a distributed service, vector database, new orchestration framework, or separate repository for each module. One local harness with an embedded index and its existing execution workers is sufficient for the first implementation.

The generic agent package may depend on injected service interfaces, but must not import coding-agent implementations or SQLite. Provider wire semantics belong in `ai`; task ranking belongs in the context core; TUI/daemon/SDK are clients of the same runtime rather than alternate owners.

### 3.2 Ownership matrix

| Concern | Sole authoritative owner | What other components may do |
|---|---|---|
| Source event identity/order | Session coordinator and durable journal | Observe committed events; submit commands. |
| Exact evidence/locators | Evidence store | Read bounded pages under access control. |
| User requirements and decisions | Durable descriptive reducer | Propose attributed facts; never silently overwrite user truth. |
| Working-set selection | Compiler for a resolved model contract/epoch | Request a view with purpose and budget; no ad hoc prompt pruning. |
| Native replay validity | Provider adapter | Supply source groups; receive validated render/count results. |
| Checkpoint commit | Continuation coordinator | Generate candidates, but never mutate the active lineage independently. |
| Tool effects/jobs/children | Execution coordinator with fenced reservations | Request work and observe state; do not fabricate completion. |
| Inference accounting | Shared request boundary and receipt ledger | Display or aggregate receipts; do not infer authoritative totals from messages. |
| Presentation | TUI/CLI/SDK/daemon adapters | Render committed state; losing a UI connection must not lose ownership. |
| Background learning/refinement | Explicit owned job service | Run only under configured utility and budget policy. |

### 3.3 One native runtime, multiple optional extensions

Make the context runtime a normal, typed part of harness construction. Exact capture, permissions, lifecycle, receipts, and valid continuation cannot depend on an optional extension loading first, a private object-property mutation, or an event listener returning at just the right moment.

Keep an extension system for user tools, skills, renderers, and approved hooks. Provide versioned public service interfaces where useful, not an exported mutable `AgentSession` internals object. Observer failure must not corrupt the source log or silently bypass accounting. A blocking policy hook must be declared as such, have bounded cancellation behavior, and cannot forge a provider receipt or durable tool completion.

Preserve the mature UI and external automation interfaces where feasible. A terminal attach, RPC session, headless run, and daemon job must all use the same memory/execution pipeline. Do not ship a correct interactive path and a separate unmetered SDK path.

### 3.4 Native service contracts

The following names are proposed contracts, not claims that H already exports them:

```ts
interface SessionRuntimeServices {
  history: HistoryReader;              // bounded, cursor-based source pages
  evidence: EvidenceReaderWriter;      // immutable identities + durable coverage
  tasks: DescriptiveTaskState;         // source-backed state, not a proof engine
  requests: InferenceCoordinator;      // all purposes, attempts, settlement
  execution: ExecutionCoordinator;     // effects, jobs, reservations, generations
  context: ContextCompiler;            // resolved contract + purpose + epoch
  continuation: ContinuationCoordinator;
}

interface RuntimeCompatibility {
  productId: "base-context";
  runtimeContractVersion: number;
  storageReadVersions: readonly number[];
  storageWriteVersion: number;
  daemonProtocolVersion: number;
  providerAdapterRevision: string;
}
```

Pass immutable snapshots and stable IDs across boundaries. Cancellation is an explicit signal with owner identity, not a global mutable flag. Version the persistent and cross-process contracts. Internal TypeScript interfaces can evolve atomically within a release; do not reproduce the old plugin ABI negotiation machinery where one source build now owns both sides.

## 4. Product identity is an isolation boundary

### 4.1 Required identity matrix

Create a central `ProductIdentity` and `RuntimePaths` implementation. Audit direct paths, environment parsing, package metadata, help text, process labels, update/download URLs, OAuth configuration, telemetry destinations, kernel bootstrapping, and shell completions.

| Surface | Base Context requirement | Compatibility decision |
|---|---|---|
| Product/command | Base Context / `base-context`. | Do not globally replace `pi` or `prime-agent`; an alias is an explicit user choice. |
| Public npm package | Own namespace, for example `@basemodelai/base-context`. | Example only; verify registry ownership before publication. |
| Internal packages | Own scope or private workspace packages linked from the same source graph. | No accidental runtime resolution to upstream `@earendil-works/pi-*` packages. |
| Repository/version | Own repository metadata, issue links, release version and ancestry manifest. | Start an independent series, such as 0.1.0; do not imply this is upstream 0.9.3. |
| User/project state | Proposed `~/.base-context` and project `.base-context`. | Legacy roots are explicit read/import inputs, not shared writable directories. |
| Environment | Central `BASE_CONTEXT_*` parsing; proposed `BASE_CONTEXT_HOME`. | Empty and relative values require defined validation. Do not inherit old variables implicitly. |
| Daemon identity | `base-context.daemon`, own registry, sockets/pipes, locks and ownership root. | Reject Prime Agent handshakes; never auto-adopt its workers. |
| Runtime installation | Own managed environment and distribution identity, for example `base-context-runtime`. | Keep `import rlm` where needed for program compatibility; no conflicting distributions in one environment. |
| Update/installer | Own authenticated release origin and expected artifact identity. | No fallback to upstream installers, binaries, runtime packages, or update URLs. |
| Traces/sharing | Local by default; explicit approved remote destination and consent. | Do not carry over upstream upload schedules/credentials automatically. |
| Provider identity | Preserve actual provider/model/wire identifiers. | A real Prime Inference adapter does not become a different provider because the product is renamed. |
| Tool/skill names | Preserve existing useful model-facing interfaces during the control phase. | Avoid exposing duplicate old/new schemas that consume tokens or confuse the model. |
| Notices | Retain original notices and add fork attribution. | Branding changes do not delete provenance or third-party obligations. |

The extracted packer probe demonstrates why overriding only package/command names is insufficient. The existing packer still produced `.prime/agent` and retained upstream metadata/dependency keys. [N2]

### 4.2 Daemon and process isolation

Identify a worker by product, installation identity, protocol version, workspace/session identity, runtime generation, and verified process ownership—not a PID or executable-name substring alone. Include a fresh generation nonce for restart fencing; stale owners cannot issue commands to the replacement.

Use product-specific Windows named pipes and Unix sockets. Validate their ownership and directory permissions. A stale PID file is not authorization to kill a live process. Never terminate a Prime Agent worker, read its live lock as your own, or attach to its sessions merely because a path or port matches.

Test both products installed and running concurrently. Base Context upgrade, uninstall, crash repair, daemon shutdown, and runtime cleanup must not alter the other product's installation or active state. Cross-product connections must fail locally with an actionable diagnostic, not fall through to a permissive compatibility path.

### 4.3 Authentication, endpoints, and telemetry

Do not mechanically rename third-party OAuth client IDs, audiences, callback schemes, or API endpoint domains. Inventory every authentication route. Validate whether it is usable by this distribution under the actual provider contract; require explicit credential import or reauthorization. Preserve ordinary API-key support where the adapter is valid. Unvalidated auth paths remain unavailable with an explanation, rather than silently borrowing another product's client identity.

Keep provider credentials scoped to their provider and purpose. Update checks, traces, crash reporting, catalog refresh, and sharing must not opportunistically reuse inference credentials. The source contains trace configuration and credential-fallback paths; this is an audit target, not a claim that every installation currently uploads automatically. [N11]

Trace storage, crash diagnostics, and migrated logs can contain prompts, tool output, secrets, and proprietary code. Default to local restricted storage, redact diagnostic bundles, and make export an explicit action. Importing a legacy outbox must not trigger catch-up uploads to an old destination.

### 4.4 Licensing and distribution

The supplied upstream root license is MIT and retains notices for Mario Zechner and Prime Intellect. Preserve these notices in source and applicable distributed copies; add Base Context's own attribution without replacing the originals. Audit the context source and dependencies separately. Namespace/trademark availability and provider authentication rights are separate checks, not consequences of the source license. [U2, N10]

Test the **actual built artifacts**: modular npm packages, platform binaries, bundled CLI, source archives, and Python wheel/runtime payload. Include license/notice material and an SBOM as appropriate to each artifact. The static staging-list finding is a reason for this gate, not an assertion that a published upstream package violates its license.

## 5. Replace patches with semantic source integrations

### 5.1 Build a disposition ledger before porting

Use the supplied patch inventory as a starting list. Consolidate repeated modular/bundled replacements into logical capabilities. For each capability record: original patch locations, intended symptom/invariant, upstream H equivalent if any, new source owner, disposition, regression test, behavioral risk, and accounting impact.

Allowed dispositions are `PORT_NATIVE`, `ALREADY_PRESENT_PROVEN`, `REPLACE_DESIGN`, `TEMPORARY_GUARD`, and `DROP_WITH_EVIDENCE`. A version bump or matching function name is not evidence of equivalent behavior. No label may disappear without a disposition.

Do not execute the 0.9.1 patcher against H with a relaxed version check. Read its semantics, implement against H's interfaces, and compile the result. Keep the patcher only in the frozen legacy tree or audit fixtures; it must not run in Base Context install/build/start/update paths.

### 5.2 Initial source-port map

| Existing patch/mechanism | Native destination | Required disposition |
|---|---|---|
| Finalized exchange and original/executed arguments | Generic tool execution edge plus session journal | Port once; capture after actual execution and before projection. |
| Purpose-aware model context | Request coordinator and compiler | One path for main inference, summaries, branch summaries, and auxiliaries; different purposes can have different policies. |
| Awaited turn-end control | Turn/execution coordinator | Replace hidden continuation injection with explicit transition outcomes. |
| Compaction/branch hooks | Continuation coordinator | Adapt to H's summary slices and request lineage; one commit owner. |
| Astra catalog/effort recognition | AI catalog and route capability resolver | Remove only proven redundant entries; OpenAI catalog parity does not establish Codex parity. |
| Goal/reminder duplication | Task reducer and sparse frame compiler | Retain the useful effect without redundant user-visible or model-visible prompts. |
| Watcher/backoff/retry changes | Owned execution/job service | Test progress, stall, cancellation, and late completion independently. |
| Daemon ready/resume/attach repairs | Native daemon/runtime services | Preserve symptom tests; do not blindly carry or remove all workarounds. |
| One-child cap | Resource scheduler | Keep a conservative guard until atomic reservation and recovery tests pass. |
| Heap inflation / disabled eviction | History paging, bounded caches, passivation | Replace as the steady-state strategy; temporary override must be explicit and measured. |
| Inference accounting | AI request boundary + receipt ledger | Cover all purposes, attempts, late slices, cancellations, and background work. |
| Refinement/learning suppression | Owned utility-gated job service | Remove private global toggles and disposal-time surprise inference. |
| Exact refs / views / recovery | Native context store/compiler/tool | Preserve IDs and model-facing compatibility where feasible. |
| Public declarations and bundle surgery | Source exports and normal build graph | Delete runtime surgery; generate all artifacts from typed source. |

Source references: [L3–L15, H1–H11]. The native summary service is fork-owned even when its behavior initially matches the inherited host summary. “Preserve host-summary behavior” does not mean depend on a separately installed upstream host.

### 5.3 Mandatory common request boundary

Route every inference attempt through a single metered coordinator before it reaches a provider adapter. Include user turns, children, each compaction slice, branch summaries, refinement, skills/learning inference, retries, transport-generated continuations, and any future classifier. A feature cannot make an unmetered direct SDK call.

Assign a logical operation ID, unique attempt ID, purpose, source snapshot identity, model contract, parent/branch identity, and cancellation owner. Keep provider request IDs and H's semantic-edge lineage where meaningful. Do not equate a successful provider result with a committed checkpoint or completed user task.

Retrying the same logical body preserves the relevant semantic lineage, but each physical attempt receives its own receipt and cost outcome. Late sibling summary success is recorded even if another slice made the aggregate compaction fail. UI rendering and listener disposal cannot suppress receipt settlement. [H1–H3]

### 5.4 Explicit turn transitions

Replace “append an invisible message and hope the loop runs again” behavior with typed outcomes such as `continue`, `wait_for_owned_work`, `checkpoint_then_continue`, `finish`, and `cancelled`. These are internal runtime states, not a new ritual for the model.

A user-visible final response and a pending background job are distinct events. Policy determines whether a job is cancelled, retained as explicit ongoing work, or awaited; no job may silently start extra inference during shutdown. A closed UI cannot transfer ownership by accident.

Compaction requested during streaming, pending tools, or user steering must wait for a compatible boundary or explicitly preserve pending replay dependencies. Never manufacture a tool result to force the state machine forward.

## 6. Harden the source of truth before optimizing it

### 6.1 One canonical history, derived indexes

Do not leave three independent truths: native session messages, a context archive, and a task-state database each claiming to describe what happened. Use one canonical append-only source-event history per session/branch lineage, immutable content-addressed blobs where useful, and transactional derived indexes/materialized views.

The existing retained session log can supply exact locators during migration. Do not duplicate every message into a new blob merely to satisfy an architectural diagram. Locators must remain valid across paging, checkpointing, branching, migration, and retention. Distinguish a source event, a view rendered from that event, and a provider-native opaque continuation item.

An index can lag and be rebuilt. A committed source event cannot silently disappear because an index transaction failed. Persist enough sequence and integrity information to detect missing, duplicated, reordered, or corrupt records. Have one writer/fenced owner per journal, with bounded queues and backpressure.

### 6.2 Fix the short-write assumption

H's `EventLog.appendSync` serializes a payload, calls `writeSync` once, and ignores the returned byte count. In the supplied isolated probe, a simulated short write left 7 bytes of a 74-byte payload while the method returned without error. Calling fsync did not make the unwritten bytes appear. [N3]

Implement a checked full-write routine for the selected append substrate. Handle interrupted writes, partial progress, zero progress, disk full, permission errors, and close/fsync failures. Bound record size and serialization buffers. If an append only partly succeeds, mark the owner as requiring repair; do not acknowledge durability or immediately append unrelated records behind an invalid tail.

A full-write loop alone does not create a cross-process transaction: enforce single-writer/fencing semantics. Do not rely on a PIPE_BUF analogy as a portable regular-file atomicity guarantee. Design framing/checksums/sequence validation and tail repair under exclusive ownership. Distinguish a recoverable torn final frame from corruption in the middle of the retained journal.

Use durable batches rather than fsync on every streamed token. Persist logical effect/request boundaries and completed evidence before publishing references that rely on them. UI token deltas may remain ephemeral. When a directory entry or manifest rename is part of a durability claim, implement the platform-appropriate persistence protocol and test it; document unsupported filesystems rather than claiming universal crash guarantees.

### 6.3 Publication protocol

A valid implementation may use journal segments plus SQLite as a rebuildable index. It must realize this state ordering:

```text
intent/source sequence reserved under owner
    → exact allowed evidence staged and checksummed
    → canonical event/commit durably appended
    → derived index advances atomically to committed sequence
    → reference/checkpoint/result becomes publishable
```

Recovery must distinguish staged-but-uncommitted blobs, committed-but-unindexed events, and incomplete/corrupt tails. Reindexing must be idempotent. Orphan cleanup cannot delete a blob referenced by another branch, active checkpoint, or in-flight committed event. The index must never advertise coverage beyond a verified durable sequence.

Storage engine choices may differ if they satisfy the same tests; do not implement a second custom transactional database unnecessarily. Use SQLite transactions for derived relationships rather than hand-maintained partially updated JSON catalogs. Potentially blocking index work belongs outside the inference/UI event loop.

### 6.4 Tool effects and crash ambiguity

Record tool intent, validated/executed arguments, ownership, and result evidence. Use an external idempotency key where the tool actually supports it. **Exactly-once local settlement is not proof of exactly-once external side effects.** A crash after an external action but before result persistence creates `outcome_unknown` unless reconciliation proves otherwise.

Do not blindly replay unknown non-idempotent actions such as publishing, sending messages, or destructive commands. Reconcile via authoritative external state or ask for the genuinely necessary decision. Ordinary deterministic reads can have a different retry policy. Preserve partial artifacts and cancellation evidence; never turn an interrupted operation into a fabricated success.

### 6.5 Bounded history is native, not cosmetic

Replace whole-history arrays/maps in active session handling with cursor-based pages, a bounded recent tail, and indexed branch ancestry. Page daemon/session catalogs as well as model histories. The source's general event-log replay helper is not a license to read an unbounded main history into memory. [H9, N3]

Measure the whole process tree: main process, daemon, workers, Python kernels, SQLite caches, pending requests, view caches, and diagnostics. A smaller model prompt with an ever-growing daemon heap does not satisfy this specification. Large history must not be decoded merely to render a session list or compute one request's budget.

## 7. Release ownership, dependency isolation, and upstream intake

### 7.1 A source fork must actually use its own source

Audit root dependencies, workspace references, generated package metadata, bundle externals, dynamic imports, kernel bootstrap, runtime downloads, and installer verification. The supplied root still references the upstream coding-agent package, while release packaging rewrites some dependency values without changing upstream keys. A new CLI must not accidentally run upstream code from the registry. [N1–N2]

All owned runtime modules must resolve to the pinned Base Context source graph or its exact release artifacts. Preserve third-party dependency attribution. Do not rename external library identities merely because they contain `prime` or `pi`. Add tests that deliberately make the old upstream packages unavailable and verify the built product still works.

Own the Python distribution and bootstrapped environment. Keeping the Python import path `rlm` avoids gratuitous breakage; installing both old and new distributions providing that path into one environment does not. Use an isolated, versioned environment keyed by runtime contract and source/wheel identity. No upgrade may silently reinstall `prime-agent-runtime` over the fork.

### 7.2 Reproducible catalog and build process

H's AI package build invokes `generate-models`, whose implementation fetches external catalogs. Separate `catalog:refresh` from `build`. Commit or otherwise pin the generated catalog and its provenance; review catalog changes like provider code. A normal source build must not depend on whichever external models happen to exist that day. [N9]

Record lockfile, toolchain, generated sources, runtime wheel, platform target, and source commit in the release manifest. Build once into a staged release, test that release, then publish the exact tested artifacts. Do not patch a bundle after testing its modular source. A fresh install must not fetch an unpinned replacement component from upstream.

Native dependencies and SQLite packaging must work on the declared Node floor, currently inherited as `>=22.8.0`, or an explicit compatibility decision must raise it with a migration notice. Test the actual minimum and supported stable versions. Do not select a new Node API solely because it appears in the latest documentation. [E9]

### 7.3 Independent releases and updates

Maintain your own version/changelog and an ancestry record containing the initial upstream commit and each selected upstream backport. The release must identify itself as Base Context, not an upstream Prime Agent release. Keep release metadata distinct from model-policy and storage-schema versions.

An updater validates product identity, artifact integrity/provenance, platform, and schema compatibility before activation. If your update origin is unavailable, remain on the installed version; never fall back to Prime Agent's “latest.” Publishing is gated on controlled namespaces and credentials. Local build/test work does not require publication or a live update service.

Ship staged installation with rollback of the binary/runtime pair. Do not restart an active session into an incompatible storage writer or steal an active worker's ownership. Plan upgrades at explicit safe boundaries or launch a compatible new worker generation.

### 7.4 Selective upstream intake

Track an `upstream` remote and record a reviewed-through commit in an intake ledger. Periodically inspect security notices, provider deprecations, relevant bugfixes, dependency changes, and release notes. This is a maintenance process to implement, not work this review will perform in the background.

For each candidate, record upstream commit/issue, affected owner, dependency closure, applicability, reproduction test, conflict analysis, and disposition: backported, independently fixed, not applicable, deferred with risk owner, or intentionally rejected. Use cherry-pick provenance where applicable; a manual port still records its origin. Do not cherry-pick a provider file while omitting the types, tests, schema or runtime behavior it requires.

Prefer small upstreamable correctness fixes for shared machinery. Keep Base Context's product-specific compiler/policy code in well-defined modules. Avoid whole-repository formatting or file moves mixed with semantic changes; unnecessary churn makes both your reviews and future intake harder.

The measure is not “number of commits behind upstream.” It is whether relevant risks and capabilities are understood, tested, and owned. Set explicit review/service targets with maintainers for security and breaking provider changes. An unattended fork is not an acceptable steady state.

### 7.5 Support ownership and scope control

Name maintainers or responsible roles for storage/runtime, provider adapters, execution/daemon, model policies/evaluation, packaging/security, and migrations. Publish a tested support matrix. Inherited adapters may be marked best-effort until their contract suite is exercised; “universal” is not a claim that every route was validated.

Do not turn this initiative into an unrelated TUI redesign, a new cloud service, a universal autonomous-agent platform, or a rewrite of every inherited subsystem. Fix faults that threaten integrity, permissions, recovery, accounting, accuracy, latency, or maintainability; keep unrelated scope in separate proposals.

## 8. Migration, rollback, and security

### 8.1 Explicit, non-destructive import

Implement a local migration command with a dry-run/report mode. Proposed interface:

```text
base-context migrate --from-prime-agent <legacy-root> --dry-run
base-context migrate --from-prime-agent <legacy-root> --destination <new-root>
base-context doctor
```

These commands are requirements to implement, not commands known to exist today. The importer must copy/read a stable legacy snapshot, not attach to the old daemon or modify the source in place. If the source is live, obtain a supported stable export/checkpoint or refuse unsafe live copying. Do not use symlinks to share mutable auth, session, archive, index, or worker state.

Write an import manifest with source identity/hashes, schema versions, copied entities, excluded secrets, unresolved references, warnings, and the exact target. Stage the import; validate before atomic activation. Interruption leaves the source untouched and a resumable or safely removable target staging area. Repeated import must not duplicate effects or create conflicting IDs.

### 8.2 Data and reference compatibility

Preserve session/branch history, exact observations, attachments, goals, public notes, artifacts, and legacy reference resolution. Maintain a namespaced ID mapping when collisions or new schemas require it; never silently redirect a reference to a different observation. Imported timestamps are historical metadata, not proof that a kernel or job is still alive.

Import old indexes as rebuildable data or reconstruct them from verified sources. Unknown schema fields must be preserved where safely possible and reported; do not coerce them into a misleading current meaning. An incomplete source is a partial import with explicit coverage gaps, not a clean compaction-ready archive.

Provider-native opaque state is retained only when storage/privacy and replay-family contracts allow it. A public checkpoint provides a portable fallback, not a recreation of hidden reasoning. Cross-provider or incompatible-family migration begins a valid new provider lineage while preserving public evidence and pending-effect outcomes.

### 8.3 Do not import execution authority implicitly

Schedules, heartbeats, pending background jobs, and autonomous triggers are imported **paused**. Old worker IDs/locks/PIDs are historical evidence, not live ownership. Reconcile explicit work before resuming it in a new generation.

Treat imported extensions, skills, repository instructions, and executable snapshots as untrusted inputs until their trust/permissions are re-established. Do not deserialize or execute arbitrary Python state simply to preview a session. A trusted runtime resume is a separate explicit action under a compatible runtime contract.

Block the legacy Prime Context plugin from loading inside the new native harness. Otherwise projection, learning suppression, and continuation could execute twice. Preserve compatible user extensions selectively through a documented API adapter; private monkey patches are unsupported, not silently tolerated.

### 8.4 Credentials and rollback

Secrets are excluded by default. Offer narrowly scoped explicit import or reauthorization, preserving provider separation and file permissions. Never print credentials in migration reports, archive search results, or diagnostics. Archive retention and deletion policies apply to migrated data too.

Keep the legacy installation usable. Binary rollback, schema rollback, and provider-lineage rollback are distinct. Define which schema versions each release can read/write; reject older writers on incompatible state. Recovery may require a read-only export of portable public state rather than downgrading the live journal. Do not delete original evidence or claim an opaque provider state can be reconstructed after loss.

### 8.5 Security boundaries across memory and execution

Evidence recovered from history retains its original authority, workspace/session scope, and permissions. A tool output containing “ignore the user” does not become a trusted skill because it was indexed. Separate untrusted content from control fields in compiler and recovery responses.

Use scoped paths/handles, validate traversal and symlink behavior, bound decompression/output sizes, and protect cross-session searches. A child receives only explicitly granted evidence and execution permissions. Global content deduplication must not reveal another user's or workspace's data through presence checks or reference resolution.

Cache/replay keys include the necessary tenant/credential/permission boundaries without storing secrets in key strings. Provider-side retention and local privacy settings are part of the resolved route contract, not a memory optimization to bypass.

## 9. Preserve the successful behavior while changing its ownership

### 9.1 What must survive the migration

Preserve finalized ordered exchange capture, original/executed argument distinctions, immutable fixed views, exact references, delta dependencies, literal short novel observations, persistent recovered evidence within an epoch, sparse task reminders, bounded frozen skills, and utility-gated auxiliary work. [L4–L12]

The supplied D defaults include `minTextBytes=24576`, `capsuleMaxBytes=6144`, `readMaxBytes=65536`, and a nominal 800-token skill budget. Freeze S's actual values independently. Do not assume equal package versions imply equal settings or behavior. Keep the initial control's byte thresholds; token-aware changes belong to a later measured variant. [L2, L5, L12]

Do not automatically give generic models pointer-only continuity, discard recovered evidence after one response, load a growing catalog of all historical references, or make every task run a summarizer/planner/ranker model. Native ownership is intended to remove work, not introduce a new layer of memory bureaucracy.

### 9.2 Existing context defects remain in scope

| ID | Finding from prior source audit/probes | Native requirement |
|---|---|---|
| D01 | Thirteenth constraint/open item drops the oldest. | Durable truth has no small display cap; display is a separate bounded projection. |
| D02 | Full-text case folding conflates case-sensitive requirements. | Exact literal identity and explicit supersession; no semantic deduplication by lowercasing. |
| D03 | Reference compaction lacks a model-policy gate. | Continuation selected by resolved policy/adapter, not globally. |
| D04 | Reference checkpoint prose grows until fallback. | Bounded candidates with exact coverage; no growing transcript disguised as compaction. |
| D05 | Checkpoint asserts a live kernel without live resource input. | Runtime generation/liveness supplied by the authoritative owner. |
| D06 | Public checkpoint omits native thinking/signature material. | Distinguish public continuity from opaque protocol replay. |
| D07 | Archive paths load/scan global catalogs. | Incremental indexes and bounded reads. |
| D08 | Host retains whole-history arrays/maps. | Native history paging across UI/daemon/SDK as well as inference. |
| D09 | Child cap counts retained structures without atomic pre-await reservation. | Separate active/resident/kernel/inference budgets and fenced ownership. |
| D10 | Benchmark accounting misses non-message usage and treats missing as zero; retry selection can favor performance. | Receipt-based completeness and predeclared attempt accounting. |
| D11 | Same-ID mutation can return stale projection in an isolated function probe. | Guarantee source immutability or include revision; live defect classification requires integration validation. |
| D12 | Off-mode injection and auxiliary shutdown lack clean ownership. | Optimizer-off is behaviorally inert; native safety/accounting remain active. |

These are inherited findings with different confidence levels, not twelve newly run full-system failures. Their precise paths, qualifications, and earlier probe results are recorded in the source register and supporting evidence. [L3–L15, H1–H11, T1]

### 9.3 Separate correctness, migration, and optimization

A corrected event log, case-sensitive task state, or complete usage receipt can change a faulty baseline's output. Record the intentional difference; do not hide it in a “no behavior change” claim. Isolate product identity, semantic ports, integrity fixes, storage scaling, visible context policy, provider features, and parallelism as separate review/benchmark dimensions.

Forking must not make Astra the default policy for all models. The next sections define the shared runtime and model-specific behavior. In them, **native harness summary** means the fork-owned inherited summary implementation, not a separate upstream installation. The name `prime_context` may remain as a compatibility tool name during control comparisons; it does not imply an installed plugin.

## 10. Core contracts and architecture

### 10.1 Information planes

Implement four planes with independent lifetimes:

| Plane | Contents | Lifetime and visibility |
|---|---|---|
| **Evidence** | Exact allowed-to-retain user/public messages, tool exchanges, artifacts, media, provider envelopes, and source locators. | Durable, indexed, access-controlled; normally not all in model context. |
| **Descriptive state** | User requirements, current goals, decisions with evidence, resource generations, job status, artifact lifecycle, unresolved questions. | Durable events plus reduced indexed views; model receives a bounded selection. |
| **Working set** | Stable instructions, current task frame, required replay closure, recent exchanges, selected evidence and skills. | Bounded per provider request; immutable historical views within an epoch. |
| **Provider continuation** | Opaque reasoning/native compaction/stateful response lineage and protocol-specific metadata. | Adapter-controlled; never converted into invented public reasoning. |

An **epoch** is a period with a fixed policy/template identity and stable historical working-set choices. It is not a new source of truth. Rotating epochs changes what is rendered, not what happened.

### 10.2 Non-negotiable invariants

**Archive before substitution.** Never replace an observation or discard a historical visible unit unless its permitted exact source is durably available, or a native provider contract explicitly owns its continuation. A pretty reference is not proof that its target exists.

**Budget the real request.** Provider limits apply to rendered context, protocol items, output reservation, and retained provider state—not merely the bytes Base Context sends on the wire.

**Preserve dependency closure.** Calls, results, required reasoning items, program/caller relationships, media references, and delta baselines must remain valid under the active adapter.

**Do not lose active obligations.** Display limits may hide lower-priority items behind recoverable references; they may not erase authoritative state. Explicit updates have precedence over older versions, without fabricating semantic equivalence.

**Unknown is not false or zero.** Unknown usage, archive coverage, job outcome, runtime liveness, deployment capability, and completion evidence remain explicitly unknown.

**One owner per effect.** Each provider request, compaction, tool execution, learning job, child session, and resource lease has one owner and an idempotent settlement path.

**No model bookkeeping tax.** The model should not need to issue routine `save_memory`, `pin`, `unpin`, `ack_checkpoint`, or state-machine management calls. Ordinary tool use and explicit user input supply most state.

**One continuation owner.** Harness summarization, portable checkpointing, and provider-native compaction cannot independently rewrite the same window at the same time.

**Security survives compaction.** Archive content remains data with its original authority and access scope. Retrieved text does not become a developer instruction or a trusted skill.

### 10.3 Native service boundaries

Use the source ownership and package boundaries in §3. The context compiler, evidence store, descriptive reducer, execution coordinator, and provider adapter are native services constructed together; they are not an independently installed plugin plus a patched host ABI.

Keep the public recovery tool and legacy configuration import compatible where feasible. New internals do not justify breaking every tool action or archive ID. Extension APIs expose scoped operations and committed observations, not mutable ownership. Storage and persistent wire contracts remain versioned even though the internal code now ships atomically.

A request context is an immutable snapshot identified by source sequence, branch/epoch, task revision, resource generations, model contract, policy revision, tool schema and renderer revision. Budgeting, provider rendering and diagnostics must refer to that same snapshot.

## 11. Model profiles and provider capabilities

### 11.1 Resolve behavior and protocol independently

Use the tuple below as an identity, not merely `provider:model`:

```text
runtime contract + provider adapter version + route/auth mode + model identity
+ replay compatibility family + tokenizer/chat-template identity
+ deployed parser/server revision + relevant request configuration
+ behavioral profile revision + tool schema revision
```

A hosted Sol model and a Sol model through a restricted Codex route may share behavior but expose different options. Two Qwen deployments with the same weights but different tool parsers/templates may need different replay adapters. An unknown alias uses a conservative generic profile unless explicitly configured; it must not acquire capabilities because its name contains a familiar substring.

### 11.2 Capability representation

Implement a typed manifest with support status and evidence. The following is an interface contract, not an exhaustive SDK schema:

```ts
type Support =
  | { state: "supported"; evidence: string; testedAdapterRevision: string }
  | { state: "unsupported"; reason: string }
  | { state: "unknown"; reason: string };

interface ResolvedModelContract {
  routeKey: string;
  modelKey: string;
  replayFamily: string | null;
  templateRevision: string;
  profile: "generic-control" | "generic-balanced" | "astra-balanced";
  profileRevision: string;
  limits: {
    contextTokens: number | null;
    maxOutputTokens: number | null;
    tokenCounter: "exact-local" | "provider" | "calibrated-estimate";
  };
  features: {
    explicitCache: Support;
    opaqueReasoning: Support;
    nativeCompaction: Support;
    effortUpdates: Support;
    nativeAsyncTools: Support;
    midTurnSteering: Support;
    programmaticTools: Support;
  };
  compatibilityRulesRevision: string;
}
```

The adapter must also specify supported effort values, assistant phases, permitted replay units, valid message-role placement, stateful retention, media handling, usage normalization, cancellation behavior, and feature-combination predicates. A collection of `true` booleans is insufficient when two individually supported features cannot be combined.

Feature enablement requires all of: documented or explicitly configured support; a compatible route; passing adapter contract tests; compatible active options; and an enabled rollout flag. Unknown means disabled for advanced protocol features, not “try it on a user's paid task.” Do not issue paid capability probes automatically at startup.

### 11.3 Current capability facts that affect the split

These facts were checked against current primary documentation; they are not substitutes for route-level tests:

| Area | Current documented boundary | Design consequence |
|---|---|---|
| Explicit prompt caching | Current OpenAI documentation covers GPT-5.6 and later; the rendered prefix includes more than visible message text. [E1] | Shared adapter feature, including eligible Sol. Stable Base Context text alone is not proof of a hit. |
| Persisted reasoning | GPT-5.6 supports prior-turn reasoning context, with family compatibility constraints. [E2] | Generic/Sol also requires opaque replay awareness. |
| Native compaction | The native endpoint/mode owns its returned continuation representation. [E3] | Preserve canonical native output according to that mode; do not splice arbitrary pieces. |
| Effort updates | The current mid-conversation update mechanism is Astra-only in standard single-agent mode and has compaction/ordering restrictions. [E2] | Advanced Astra adapter feature, not a default generic option. |
| Native async tools | Current Astra async support has tool-type and feature-combination restrictions. [E4] | Separate it from ordinary host-managed background jobs. |
| Mid-turn steering | Current native steering is Astra over Responses WebSocket, not Sol. [E5] | Optional transport feature with durable update tracking. |
| Qwen tool use | Official guidance requires suitable model/chat-template/parser combinations. [E7] | “OpenAI-compatible endpoint” is not a sufficient protocol contract. |
| Self-hosted prefix caching | vLLM APC reuses prefix computation; it does not eliminate generation work. [E8] | Measure prefill and decoding separately, and do not claim direct remote KV control. |

### 11.4 Profile defaults and configuration migration

`generic-control` is the frozen public Sol behavior ported to the native Base Context runtime, including its prompt/skill/compaction choices. Keep it available as a reproducible control, not as an ever-changing alias. Apply unavoidable data-integrity fixes as explicitly labeled variants.

`generic-balanced` starts conservatively: the same fixed-view economics, durable state, better indexed recovery, and harness-summary continuation. It can later use a compact semantic bridge or validated native continuation. Qwen and unknown models enter this family, but do not inherit Sol's unverified prompt tuning or context-window values.

`astra-balanced` uses the same core with a separately versioned instruction/continuity policy. Initially enable only the features supported by the actual route and runtime. Portable checkpoints, native compaction, effort updates, async tools, and steering each have independent flags.

Existing configurations must load without silently activating Astra experiments. Record the resolved profile and capability revision in each session/branch manifest. Configuration overrides may select a behavioral profile, but cannot bypass a protocol incompatibility or invent a context limit. Reject conflicting explicit options with a clear local error before making a provider request.

On model/route/template change, finish or safely pause the current replay group, persist portable public state, resolve the new contract, and begin a new valid lineage when required. Preserve exact historical evidence. Pending tool calls remain owned by their original lineage; settle or cancel them before switching unless an explicit migration contract has been tested. Transfer opaque state only when the adapter explicitly certifies compatibility; otherwise retain it as inaccessible archival material, not as user-visible text.

## 12. Durable evidence and bounded resident memory

### 12.1 Evolve the archive, do not discard it

Keep the existing streaming envelopes, exact observation identities, and finalized-exchange semantics. Replace catalog-wide operations with an embedded index and bounded caches. D already has useful streaming gzip behavior; the issue is not that every append rewrites a giant JSON index. The expensive paths are catalog loading, searching, and rebuilding subject baselines. [L6–L8]

The archive must cover every unit a checkpoint might remove. Large projected tool observations are not sufficient coverage: short literal results, user amendments, public assistant explanations, source/executed argument differences, attachments, and host-generated state events also need durable locations. A stable locator into a retained host log is acceptable; duplicating every byte into a second store is unnecessary. That locator must survive host paging, compaction, branching, and retention operations.

Separate exact raw provider envelopes from portable public evidence. Opaque reasoning items may be stored only under the configured provider/privacy contract; do not expose hidden reasoning through `prime_context` or transform it into fabricated textual memory. Public reasoning summaries, when actually supplied, are ordinary attributed evidence rather than substitutes for the opaque state.

### 12.2 Index and schema

Use one embedded SQLite index for the first implementation. Select a backend that actually works on the supported Node floor, test its packaging, and isolate potentially blocking database work from the agent event loop. Current Node documentation is not proof that every API it describes works on the package's declared `>=22.8.0` minimum. Do not silently raise that floor. WAL deployment constraints must be respected; do not place a shared writable WAL database on an unsupported network filesystem. [L2, E9, E10]

The following tables are logical contracts; merge tables where that improves simplicity without losing semantics:

| Entity | Minimum useful keys and fields |
|---|---|
| `source_event` | Stable ID, session/branch/sequence, source kind/authority, exact locator, content revision/hash, parent relation, durability status. |
| `exchange` | Exchange ID, ordered calls/results, original/executed argument refs, source entry IDs, completion/error state, replay dependencies. |
| `observation` | Observation ID, subject key, resource revision, media kind, exact blob/part locator, length/count metadata, text index reference. |
| `subject_latest` | Scope + subject key → latest eligible observation/revision; update incrementally. |
| `task_event` | Explicit requirement/goal/decision/resource event, source ref, authority, branch, version and supersession relation. |
| `task_view` | Reduced current state with provenance, freshness and uncertainty; rebuildable from events. |
| `epoch` | Profile/adapter/tool revisions, coverage root, selected view IDs, checkpoint identity, commit status. |
| `request_receipt` | Unique attempt identity, ownership tree, purpose, outcome, timing, raw and normalized usage, completeness. |
| `job` | Owner, operation identity, process/kernel generation, lifecycle state, result refs, cancellation/settlement status. |

Maintain indexes for exact IDs, scope/branch/sequence, subject/revision, resource path and symbol, job ownership, and bounded lexical search. Prefer exact ID and path/symbol lookup before semantic search. An optional embedding index is a later experiment, not a prerequisite or a paid per-turn service.

Index raw text in bounded units aligned with semantic or existing envelope boundaries. Avoid requiring a whole multi-gigabyte compressed stream to answer a small exact read. Add chunk locators where existing storage lacks practical seekability. A request for a small range should perform bounded decompression, not merely return a small result after reading everything.

### 12.3 Atomic publication and recovery

For an exchange eligible for projection:

```text
capture original + executed inputs and finalized outputs
    → persist exact allowed-to-retain bytes / stable host locators
    → persist source identities and dependencies
    → atomically publish index entries and coverage watermark
    → acknowledge durable publication
    → allow a fixed projected view to replace the literal representation
```

Use checksums and durable commit markers. Do not publish a reference before its blob is durable. Recovery must distinguish an orphaned durable blob, an indexed complete exchange, and an interrupted partial exchange. Rebuilding a missing index must not require replaying tool side effects or asking the model to reconstruct history.

The index is an acceleration layer, not the only copy of authoritative evidence. Store enough append-only metadata to rebuild it. If index updates lag, exact recent lookup may use a bounded pending segment. A search miss while coverage is incomplete must return `coverage: partial`, not “the event never happened.”

If storage fails, retain the original visible material where it still fits and suspend destructive projection. If neither preservation nor a valid bounded request is possible, surface a storage/continuity failure and pause safely. Never manufacture a successful compacted state containing dangling references.

### 12.4 Bounded hot paths

On each finalized exchange, update only changed subjects, new index rows, and the bounded current working set. Do not reload every observation to reconstruct `baselineBySubject`. Do not scan every session to recall one exact observation. Do not materialize entire branch ancestry just to answer a recent-context request.

Require configurable byte-bounded caches for decoded envelopes, observation metadata, compiled views, and recent source entries. Bounds must include buffers queued for indexing and decompression, not just the final maps. Bound queues by bytes and items; apply backpressure or spill safely before memory grows without limit.

Implement the native history service that pages by stable source IDs/sequence ranges and computes branch ancestry from persisted indexes. H's retained `fileEntries`/maps prevent a genuine whole-process memory bound even after the context compiler is fixed. Migrate hot consumers incrementally; do not retain a hidden second full history to preserve convenience APIs. [H9]

### 12.5 Retention, branching, and security

Scope authorization happens **before** ranking or returning matches. A project-level search must not accidentally reveal another project, a sibling child with narrower permissions, or a prior user's session. Branch inheritance grants only the explicitly inherited source range and permitted shared artifacts; it is not access to every branch.

Garbage collection must trace roots from retained sessions/checkpoints, source locators, active requirements, unresolved jobs, explicit user pins, and any required replay/delta dependencies. Shared immutable blobs can be reference-counted or mark/swept, but partial failure cannot delete a live target. User deletion and privacy policy take precedence over indefinite retention; return an explicit unavailable/redacted tombstone rather than claiming exact recovery remains possible.

Persist provenance and authority alongside content. Tool output containing “ignore earlier instructions” remains tool-output data after recovery. Do not auto-promote arbitrary archived prose into skills or developer messages. Keep secrets out of debug request dumps by default; capture hashes/metadata for cache diagnostics unless explicit secure trace retention is enabled.

## 13. Durable descriptive task and execution state

### 13.1 Replace bounded truth with a bounded rendering

`TaskSnapshotV2` must cease being the sole authoritative record of active constraints. Its current bounds can remain a display policy, but the full state must live in the indexed event store. Existing snapshots should be imported with provenance and an explicit “earlier items may already have been lost” marker; migration cannot recover deleted information without its source history. [L5, T1]

Store requirement identity separately from presentation text. Preserve case-sensitive paths, flags, identifiers, numeric limits, quoted strings, and output filenames exactly. Normalize whitespace for search if useful, but never use a normalized search key to decide authoritative equality.

Supersession requires an explicit source relation or a well-defined structured operation. “Newest similar sentence wins” is not sufficient. When an update is ambiguous, retain both with an unresolved relationship; the model may clarify only when that ambiguity matters to the task.

### 13.2 State authority

Use explicit kinds:

```text
user_requirement      exact source-backed requirement
user_goal_revision    user or authorized workflow revision
observed_fact         tool/provider/runtime result with revision and source
model_hypothesis      tentative interpretation, never promoted automatically
model_plan            proposed future work, not a new user obligation
decision              stated choice with scope, source and rationale reference
artifact_state        observed presence/version/stage of an artifact
open_question         unresolved question with its original source
```

Prefer deterministic extraction of structured events already present in the host over a new LLM extraction call. Natural-language requirements may be indexed and linked without being perfectly parsed. Keep the complete original task and amendments addressable. Do not claim that a heuristic extractor has captured every requirement or that a compact ledger is an exhaustive semantic representation.

A model-authored summary can suggest a state update, but retain its attribution and confidence. Tool evidence may confirm a factual claim, not override a user requirement. Do not permit a summary or learned skill to silently weaken a constraint.

### 13.3 Minimal task frame

Compile a bounded frame containing the current objective, the most relevant active constraints, concrete current artifact/job state, the next unresolved decision, and exact recovery roots. Use actual observations to decide whether a field is present. The following is a proposed wire-neutral example, not a mandatory repetitive prompt:

```text
Task r7: implement export compatibility; preserve public CLI names.
Current: parser change saved at tree 8c2…; focused tests passed before the latest edit.
Open: verify the new flag spelling and finish the requested migration note.
Evidence: task=task:r7, change=obs:218, test=obs:221 (stale after obs:225).
History: prime_context can recover exact requirements, decisions, and results by ref or need.
```

Do not append a full requirements table every turn. Within an epoch, leave prior frame text stable and append a small revision only when something material changes. Rebuild the compact frame at rotation. Separate permanent guardrails from the task-specific state they constrain.

If active requirements exceed the display budget, retain all in storage, expose a bounded index and relevant exact clauses, and explicitly mark that the frame is selective. Deterministic tool-boundary checks may enforce **explicitly structured** requirements, such as a prohibited path. They must not invent broad semantic completion gates.

There is no general guarantee that arbitrary quantities of simultaneously relevant natural-language requirements can be reasoned about with a fixed tiny prompt. For such tasks, use staged retrieval/decomposition or a user-configured larger working set. Never silently discard important requirements to claim a constant-context success.

### 13.4 Resource freshness and lifecycle

Attach facts to a resource generation and revision. A test result is about a particular tree/configuration/dataset stage, not an eternal property of a filename. A Python variable belongs to a kernel generation; a process handle belongs to a process instance; an artifact may belong to initial, outage, or expedited workflow stages.

Before emitting “kernel remains live,” query the execution coordinator's authoritative resource view. Emit one of `live`, `restored`, `restarted`, `absent`, or `unknown`, with generation identity where applicable. Restoring a snapshot is not proof that an external process or file descriptor is live. Bash-only sessions must not receive Python-specific resume claims. [L10, H10, T1]

Record what actually exists and which stage produced it. The development Task24 diagnosis concerns lifecycle assumptions and clean-environment artifact requirements, not demonstrated compaction loss. The new state model should make that class of mistake easier to avoid without imposing a universal staged workflow on unrelated tasks. [L1]

### 13.5 Completion without a proof bureaucracy

The harness may surface a small reminder of explicit unfinished deliverables or stale evidence when the model is about to finish. It must not force extra testing, create new artifacts, or require a checklist that the user did not request. A suggested plan item is not automatically a completion obligation.

Distinguish “not observed” from “failed,” and “passed before a change” from “currently verified.” Keep the model responsible for reasoning about sufficiency; keep the harness responsible for accurate accessible facts. This preserves the public implementation's descriptive-state philosophy while repairing its storage bounds.

## 14. Working-set compiler and stable views

### 14.1 One compiler, multiple rendering policies

Preserve the current shared representation for provider rendering and budgeting. The upgraded compiler consumes a bounded recent event stream, indexed descriptive state, selected fixed views, and adapter-required replay groups. It must not reconstruct an entire historical transcript at every invocation. [L4]

Each visible unit has:

```ts
interface ViewUnit {
  id: string;
  sourceRevision: string;
  kind: "literal" | "fixed-view" | "recovery" | "task-frame" | "replay-group";
  exactSources: readonly string[];
  requiredVisibleDependencies: readonly string[];
  authority: "instruction" | "user" | "assistant-public" | "tool-data";
  tokenEstimate: number;
  immutableWithinEpoch: boolean;
}
```

The implementation may use interned IDs instead of repeated arrays; the contract is dependency correctness, not this exact storage layout. A view is not eligible for inclusion merely because its byte size is small. Its closure, freshness, and decision value matter.

### 14.2 Layout and update policy

Prefer this logical order when the provider format permits it:

```text
stable developer policy + stable tool schema
    → epoch-level task/continuity frame
    → immutable historical views and selected replay closure
    → recent literal exchanges / recovered evidence
    → sparse new task-state changes and current input
```

Keep frequent counters, timestamps, catalog rebuilds, changing goal text, and random ordering out of the stable prefix. Do not rewrite all earlier views each turn to obtain a marginally smaller prompt. Select aggressively at boundaries; append conservatively within an epoch.

Respect actual instruction roles. Recovered evidence is not a developer instruction just because that placement would improve cache layout. On providers with stricter role/template conventions, the adapter must produce a valid equivalent layout, not force this ordering into unsupported message types.

### 14.3 Budget accounting

Define the usable budget from the adapter's known limit, reserved output/reasoning allowance, required protocol closure, tool schema, and a calibrated uncertainty margin. Count the actual serialized template where possible. Track provider-reported prompt usage to calibrate estimates without additional paid calls.

Where reasoning is already included in the completion limit, reserve it once rather than double-counting it. The adapter defines this relationship. Do not use UTF-8 bytes divided by four as a universal tokenizer. CJK text, code, JSON, images, opaque state, and different chat templates require different treatment. Where the exact counter is unavailable, maintain a conservative profile-specific estimate with observed error bounds. Unknown model limits require explicit configuration or a validated registry entry before aggressive packing.

Introduce separate budgets for stable instructions, task continuity, recent work, recovery, and replay obligations. These are allocation controls, not permission to truncate a required replay group. Preserve the control profile's original thresholds for the migration comparison; tune new budgets afterward.

For initial experiments, measure generic semantic-bridge budgets in a small grid such as 256/512/1024 tokens and Astra public-continuity budgets in the same grid, rather than assuming Astra always benefits from the smallest value. Total working-set budgets should be benchmarked at several fractions of the **actual** context window and capped by the chosen latency/cost policy. These are experiment settings, not claimed optimal defaults.

### 14.4 Selection objective

Use a deterministic initial policy before considering learned ranking. Always retain the current user input within the validated input strategy, active protocol closure, explicit safety constraints, and immediately necessary failure evidence. Then prefer relevant current-revision facts, unresolved decisions, and high-likelihood reusable observations.

A useful design objective is:

```text
maximize decision-relevant information retained
  minus expected retrieval latency
  minus expected prefix rewrite / cache-write cost
  minus stale-evidence risk
subject to provider budget, dependency closure, authority, and retention rules
```

This is a policy objective, not a claim that the implementation can measure information value perfectly. Start with explainable rules using active paths, recent tool subjects, explicit task terms, source authority, and freshness. Log selection reasons outside the model context. Avoid a new LLM ranking call per response.

### 14.5 Delta, error, and media correctness

A delta is useful only with its visible or independently recoverable baseline. At rotation, either retain the required baseline closure, materialize the current standalone view from archived exact sources, or present a direct exact recovery reference with a self-contained description. Do not leave a “changed from earlier” message whose earlier state is absent.

Keep decisive error text, exit status, affected file/location, and relevant context in a bounded failure view. Dropping the first actual error while retaining only a generic tail is unacceptable. Distinguish empty success from truncated output and unavailable output. Preserve media type and access instructions; a text caption is not a replacement for exact image evidence when the task requires it.

Treat unknown signed/opaque/protocol fields conservatively. The existing recursive name heuristic is a useful guard, but a typed adapter must own legal transformations. Store unknown raw fields losslessly where retention permits, preserve the entire replay unit, and disable destructive projection when its validity is unknown. [L4]

### 14.6 Compiler cache correctness

Key compiled-view caches by immutable source revisions, epoch, profile, adapter/template, and tool-schema revisions. Entry IDs alone are sufficient only if the host guarantees immutable content for an ID. Enforce that guarantee with tests and development assertions; otherwise include a revision digest. The isolated same-ID mutation probe demonstrates the importance of this contract, not proof of mutation in every live session. [T1]

Budget-only queries must remain read-only: no advancing watermarks, consuming pending selections, changing view assignments, or spawning inference. Provider rendering and preflight budgeting must observe the same committed epoch snapshot.

## 15. Recovery with minimal model effort

### 15.1 Keep one stable recovery tool

Retain existing `prime_context` action compatibility and IDs. Add a bounded batched recovery path without making the tool schema grow with the archive or skill catalog. A model should be able to request exact IDs or express a need in one call; it should not have to list sessions, inspect a catalog, locate an observation, and then read it through four sequential round trips.

Example proposed request:

```json
{
  "action": "recover",
  "items": [
    {"ref": "obs:221", "view": "failure"},
    {"need": "the user's exact compatibility requirement for export", "scope": "task"}
  ],
  "maxTokens": 1200
}
```

The server derives the maximum permitted scope from the current session. Client-supplied scope cannot expand authorization. `maxTokens` is a total-response budget, not a per-item budget that can be multiplied without limit.

### 15.2 Query planning

Use a bounded local plan: exact ID; exact subject/path plus revision; indexed lexical/symbol search; then optional semantic search if configured and justified. Rank within authorized scope, prefer current task/branch, and expose older or conflicting revisions explicitly. Include source kind, freshness, a decisive excerpt, exact ref, and whether more content exists.

The result must distinguish `found`, `not_found_with_complete_coverage`, `partial_coverage`, `not_authorized`, and `unavailable`. A truncated top-k list is not a proof that no other match exists. Return a continuation cursor when useful; cursor identity must include scope and index snapshot so paging does not mix incompatible views.

Avoid dumping full sessions or duplicating the same recovered body through several aliases. Deduplicate by exact content/revision where appropriate while retaining distinct source attributions. Do not merge conflicting records because their text looks similar.

### 15.3 A small amount of selective push

Pure demand retrieval makes models pay attention and round-trip costs to rediscover predictable information. At a checkpoint or explicit task transition, the harness may prefetch a small, deterministic set of high-confidence evidence: the current failing test, a just-referenced requirement, the active artifact's latest version, or an unresolved decision's exact source.

Do not run a general semantic search every turn. Do not auto-inject speculative distant history. Limit prefetch to the recovery budget and record why it was selected. The generic profile may benefit from slightly more explanatory context; Astra may benefit from terser evidence. Measure both rather than equating fewer bytes with better behavior.

### 15.4 Retention within an epoch

Once evidence is returned to the model, retain its visible representation for the rest of the epoch unless an explicit valid rotation occurs. Do not resurrect one-response leases. A recovered passage often becomes useful several reasoning steps later; removing it immediately forces repeated calls and undermines continuity. The historical public implementation specifically moved away from transient recovery. [G2]

At rotation, demote evidence only after preserving exact recovery and selecting the new working set. The next frame may retain a compact source-backed conclusion plus the exact ref, but it must not pretend the detailed body is still visible. Avoid model-facing pin management; automatic selection and optional user pins should suffice.

### 15.5 Evidence handles for large local data

Expose durable handles to large exact results so local tools can filter, slice, count, compare, or join them without routing every byte through the model. Operations must be bounded, authorized, and deterministic where practical. Reuse existing tool/runtime facilities rather than inventing a second unrestricted code-execution service.

Preserve distinctions between a source handle, a materialized filtered artifact, and the displayed excerpt. A query returning ten rows should report whether it scanned the relevant coverage and whether more rows matched. This enables “compute near the data, reason over the result” for Sol, Qwen, and Astra alike; it is not an Astra-only provider feature.

## 16. Continuation: three modes, two policies, one owner

### 16.1 Continuation modes

```ts
type ContinuationPlan =
  | { kind: "harness-summary"; owner: "continuation-coordinator";
      summaryPolicyRevision: string }
  | { kind: "portable-checkpoint"; owner: "continuation-coordinator";
      epochId: string }
  | { kind: "provider-native"; owner: "continuation-coordinator";
      adapterRevision: string; protocolMode: string };
```

All modes have the same commit owner. An adapter supplies native protocol semantics; it does not independently mutate session history. The inherited summary implementation becomes a fork-owned service. A candidate generator cannot publish a new lineage merely because its provider request succeeded.

**Harness-summary:** Initial generic migration default, preserving the successful public baseline's behavior. Exact evidence and durable task state remain recoverable around the summary. Recursively summarized prose is never the source of truth.

**Portable-checkpoint:** Bounded model-neutral public state compiled by Base Context. Either behavioral policy may use it after validation. It preserves exact recoverability and selected semantic continuity, not hidden provider reasoning.

**Provider-native:** Continuation governed by the precise selected adapter mode, potentially preserving opaque state. Eligible Sol routes may use it too. Native output is not automatically a bounded packet and still needs request-budget validation.

Fallback is a deliberate mode transition before commitment, respecting the existing replay state. Do not launch competing compactions, mutate history twice, or keep whichever result is convenient. Charge all attempted work even when no candidate is committed.

### 16.2 Generic continuity policy

Initially select the inherited native summary service rather than D's reference builder. Preserve the baseline's summary and tree/refinement ownership choices in `generic-control`. In `generic-balanced`, combine durable exact evidence with a compact semantic bridge describing what is being solved, important observed conclusions, unresolved uncertainty, and the next actual decision.

Do not flatten the whole conversation into a pointer catalog. Some models need a short explanation of why the retained facts matter, not just IDs. Conversely, do not invoke an extra summary call at every rotation when the existing native harness summary and deterministic state already suffice. Auxiliary inference must be an explicit utility-gated option with measured benefit.

When a bridge is generated, use source-backed state and exact recent evidence, not only the previous bridge. Bound its output and archive its provenance. Repeated summarization of summaries must never become the only remaining representation of an old constraint or decision.

### 16.3 Astra continuity policy

Astra can experiment with a smaller public checkpoint and with compatible native continuation. Neither is assumed universally superior. Keep an independent measured fallback to the safe harness-summary or portable path, as permitted by the current protocol state.

The attached reference builder is not the final architecture: it retains increasingly large historical prose, omits thinking material, and makes an unsupported kernel claim. Replace the implementation rather than merely increasing its token reserve. Its useful idea is exact externalization of recoverable evidence, not reconstruction of an ever-growing transcript. [L10, T1]

### 16.4 Bounded portable checkpoint schema

Persist a full checkpoint record in storage, but render only a bounded packet. The packet references a single coverage/state root instead of enumerating every observation:

```text
checkpoint: cp:41     task-revision: 7     policy: generic-balanced@3
objective: current task, not every historical request
continuity: short source-backed explanation, profile-budgeted
active: relevant exact constraints and unresolved decisions
resources: observed tree/artifact/kernel/job generations
evidence: selected decisive refs and excerpts, not a full history inventory
history-root: hist:session:branch:seq940
recovery: one stable instruction for exact/need-based prime_context access
```

Store full provenance, coverage intervals, replay ownership, source revisions, and selection decisions outside the rendered packet. Do not include all closed work, every source ID, counters that change every turn, repeated policy text, or a chain of all older checkpoint summaries.

A checkpoint cannot certify archive coverage by trusting a generated summary. Coverage is determined from durable source identity and committed ranges. If an old message lacks a durable location, either capture it before replacement or retain it; do not declare it recoverable because a related observation exists.

### 16.5 Atomic checkpoint transaction

Use a per-branch checkpoint transaction:

```text
1. Freeze a candidate source sequence and current epoch/version.
2. Confirm exact archive coverage and resolve required replay dependencies.
3. Snapshot descriptive state and authoritative runtime resource generations.
4. Compile a bounded candidate under the selected policy and adapter.
5. Validate role/protocol ordering, closure, token budget, refs, and authority.
6. Compare-and-swap the branch checkpoint against the frozen sequence/epoch.
7. Commit the new epoch, projection identity, and continuation ownership.
8. Publish the new provider view; retire old hot views only after commitment.
```

Concurrent user input, tool completion, cancellation, or model switching invalidates or extends the candidate through a defined retry path. Do not lose late results between snapshot and commit. A restart must see either the prior committed state or the new committed state, not half a checkpoint.

If a required replay group alone exceeds the usable budget, use the adapter's valid compaction path, defer rotation until the group closes, or fail with an explicit recoverable limit. Never truncate a call/result group or silently submit an oversized request. Decompose future large tool results near their source where possible.

### 16.6 Native continuation rules

Current OpenAI documentation distinguishes native compaction modes: standalone output is a canonical window, while stateful and in-request modes have their own replay/pruning rules. Preserve the whole canonical representation required by the selected mode; do not extract an opaque item and discard surrounding returned items because the compiler prefers fewer tokens. [E3]

The adapter owns encrypted/signed blocks, assistant phases, call/result linkage, and any programmatic tool caller identity. Public checkpoint text must not be substituted into those fields. Store a portable public fallback alongside native state for permitted model/route switches, but do not claim it preserves identical latent reasoning.

Stateful request IDs can reduce client payload size without reducing the provider's retained rendered context. Count and measure the actual continuation. A session using native state is not exempt from context limits, receipt completeness, retention expiry, or recovery testing.

### 16.7 Rotation frequency and accounting

Distinguish **physical working-set rotations**, **LLM summary calls**, and **provider-native compactions**. A cheap deterministic rotation may replace an expensive summarization event, but calling it “zero compactions” would conceal work. Report all three counts, their durations, and subsequent recovery burden.

Use hysteresis so small threshold crossings do not cause repeated rotations. Prefer a coherent completed boundary and keep the old epoch while cached replay is cheap and useful. Rotate earlier when remaining budget, stale context, or predicted future replay cost justifies it. The controller must not sacrifice accuracy to minimize a counter.

## 17. Cache-aware efficiency across both streams

### 17.1 Separate three caches

**Compiler cache** saves local projection work. **Evidence cache** saves disk/index/decompression work. **Provider prefix/KV cache** saves provider-side repeated prefix computation where supported. A hit in the first two is not a provider cache hit. A high provider cache ratio is not proof of low end-to-end latency.

For remote providers, Base Context controls requests and observes receipts; it does not directly allocate or evict GPU KV blocks. For self-hosted deployments, optional server metrics may expose those details. Report only what is actually observable. Keep prefill, decoding, local tool time, retrieval, queueing, and network delays separate. [E1, E8]

### 17.2 Rendered-prefix identity

The adapter must fingerprint all locally controlled settings that can affect rendering: model/template, tools and order, instructions, output schema, effort configuration, relevant provider options, and retained item order. A locally identical hash does not reveal hidden provider instructions or guarantee provider cache residency. Use it to explain avoidable changes, then validate with actual cache-read receipts.

Where supported, place explicit cache boundaries around stable reusable sections and choose the appropriate write/read policy for the expected reuse. Current documentation describes explicit breakpoints and cache-write accounting for eligible Sol as well as Astra. Do not infer that the same request fields work through every Codex or proxy route. [E1]

Do not pad short tasks to reach a cache threshold. Do not issue dummy requests to keep a cache warm. Do not freeze stale task information purely to maintain a prefix. Do not reorder semantically required protocol items to obtain a larger apparent hit.

### 17.3 Keep-versus-rotate economics

Use observed local and provider costs to compare staying in the current epoch with rotating:

```text
stay ≈ expected remaining cached/uncached replay cost
       + expected attention/context-pressure cost

rotate ≈ checkpoint work + new prefix write/prefill cost
         + expected recovery work + uncertainty/continuity penalty
```

The attention and continuity terms are estimated policy penalties, not directly measurable billing. Start with conservative deterministic thresholds and hysteresis; fit simple coefficients only from the benchmark corpus and validate on held-out tasks. Do not add a model call to decide whether a model call should compact.

A larger stable cached working set can outperform a repeatedly rebuilt tiny one. Conversely, carrying cheap cached but irrelevant material can still consume context capacity and create stale-evidence problems. Optimize task completion, not a single token or cache statistic.

### 17.4 Reasoning-context experiments are shared where supported

For eligible providers, compare supported reasoning-context modes only as an isolated experiment. Sol's persisted reasoning is not assumed absent, and retaining all opaque history is not assumed free. Keep exact provider envelopes and public fallback state distinct. The adapter must know which prior items are required, reusable, omitted by the provider, or incompatible with a new family. [E2]

Do not normalize every model to an invented common “reasoning off” value. D contains an auxiliary-learning call configured with `reasoning: "off"`; whether that becomes an invalid provider value depends on host normalization. Test the complete route. Resolve each auxiliary model's supported effort independently of the main model. [L12–L13]

## 18. Execution efficiency before output compression

### 18.1 Avoid generating expensive work

The development evidence identifies tasks where generated tool work, lifecycle mistakes, or extra calls dominated the outcome. Task13's later implementations performed more parsing/normalization passes; Task24 involved missing/staged artifacts; Task27 involved extra calls and process-status detours. These are not all context-management defects. [L1]

Provide concise, reusable procedures that encourage early filtering, bounded reads, incremental updates, and state-aware reuse. Do not solve an expensive full-data transformation merely by summarizing its output more aggressively. Allow tools to return exact artifact handles and small decisive results so models can operate on data without repeatedly serializing it through the prompt.

Cache deterministic derived data only with a valid input/tool/configuration fingerprint. A prior successful command is not reusable after its files, environment, dependencies, or requested stage change. For mutable external data, use explicit freshness policies rather than content-addressing a stale answer forever.

### 18.2 Event-driven jobs instead of polling conversations

Create a shared job registry for long-running Bash/process work, child sessions, and native async calls. The registry owns execution identity, dependency relationships, status, result locations, and cancellation. The model sees a compact handle and receives a result when the next step actually depends on it.

Coalesce identical status reads and wake a waiting agent on meaningful state changes. Preserve D's watcher-folding intent: retain enough recent complete exchanges to distinguish progress from a stall, without feeding a long history of identical polls. A process still running is not automatically a reason to spend another model response. [L3, L17]

Permission failures, invalid handles, and unchanged deterministic failures should produce a clear source-backed error. Do not blindly repeat the same read-only operation or relaunch a job because a compacted transcript omitted its earlier status. Reattempt only after a relevant state change or explicit reason.

### 18.3 Skills as small procedures

Keep the catalog stable during an epoch and bounded in the prompt. Preserve the existing conservative selection behavior during migration. Improve a skill's usefulness before increasing the number of skills loaded. The attached implementation already bounds selection and body sizes; a larger library must not create a larger default prompt. [L12]

A useful procedure card contains a trigger, a small sequence, the critical pitfall, and an exact optional reference. Examples include “filter before parsing large logs,” “validate required generated artifacts in a clean workspace,” and “reuse the tracked job instead of relaunching it.” These are general procedures, not benchmark-specific task answers.

Load a full body only when selected or explicitly invoked. Freeze its version for the epoch, record provenance, and make it recoverable after rotation. Avoid a new tool schema for every skill. Do not infer that a skill's instruction overrides the user's task or the harness's higher-priority safety rules.

### 18.4 Auxiliary inference and learning

Every auxiliary call must have a purpose, owner, budget, model/effort contract, cancellation policy, and request receipt. Use deterministic extraction, indexing, and replay first. A cheap model that causes extra retries or loses requirements is not necessarily cheaper overall.

Separate configuration for bridge generation, learning, and any optional semantic extraction. Do not inherit an expensive main model silently for all three. Do not run automatic learning at every turn, checkpoint, or shutdown. Preserve utility gating, then measure whether learned procedures actually reduce future work on held-out tasks.

Replace fire-and-forget learning and the old private refinement overrides with one native owned job service. On shutdown, either await under an explicit bounded settlement policy or cancel and record the true outcome. Disabling optimization must not re-enable an independent inherited refinement loop and launch late inference. Feature changes are explicit owner transitions; no extension unload or global reset is allowed to create work. [L13]

### 18.5 Off mode and behavioral separation

`context.mode=off` disables automatic context projection, optimized checkpoint selection, context-specific behavioral supplements, and automatic auxiliary/learning work. It must not delete archives or disable baseline durable session logging, permissions, valid provider sequencing, receipts, cancellation, or safe resource limits. Those are product invariants, not optional plugin effects.

The mode switch occurs at a valid boundary and records the new policy/epoch. Do not try to reconstruct already demoted history by submitting the entire archive on the next request. Use a valid native/public continuation and retain explicit recovery access. The independent H control, rather than off mode alone, measures unmodified upstream behavior.

Freeze the legacy short-work/no-extra-verification policy for control experiments, not for all models. New policies should encourage proportionate verification, respect explicit task requirements, and avoid both unnecessary broad tests and unsupported completion claims. Separate behavioral ablations from compiler ablations. [L11]

## 19. Safe children, jobs, and parallelism

### 19.1 What the fork ancestor does and does not establish

H includes changes to semantic request lineage and cancellation traversal, including a visited-set fix for overlapping child membership. Those changes matter, but they do not prove that the old one-resident-child workaround can be removed safely. The existing cap's retained-object count and asynchronous setup path are not a capacity scheduler. [H1, H6–H8, L3]

Keep a conservative effective limit of one child until the new ownership tests pass. Do not relax it merely because the selected model is Astra. Concurrency correctness is shared infrastructure.

### 19.2 Separate resource budgets

Track at least active provider inferences, resident child runtimes/kernels, queued child requests, running external jobs, and buffered result bytes. Exited retained session objects are historical records, not necessarily active capacity consumers. A paused child may consume resident memory while using no inference slot.

Reserve the relevant capacity **before** asynchronous setup. Persist a reservation ID and owner generation; release through one idempotent settlement path after success, setup failure, cancellation, timeout, or crash reconciliation. Do not increment a counter after an awaited spawn; that permits races. Bound pending queues and reject or defer overload with a clear status rather than growing them indefinitely.

Avoid parent/child deadlock: an agent waiting on a child must not monopolize the only inference slot needed by that child. Keep dependency-aware scheduling and fair admission; cap nesting depth and detect cyclic waits. Record waiting as a scheduler state, not as a busy model loop.

Enforce tree-wide limits across worker processes, not separate per-process counters that each permit another full tree. A fenced coordinator owns reservations; after restart, reconcile existing workers before admitting replacements. Stale generations cannot release another owner's slot or publish results as a new child. Expired control leases are not proof that external processes stopped.

Stage a child's result/artifact manifest before notifying the parent. Parent consumption and settlement are idempotent even when delivery is duplicated. Cancellation of a finished intermediate node must still reach live descendants without repeated traversal. H's fix is retained as a regression case, not assumed to cover the entire new scheduler.

### 19.3 Child input and return contracts

Give a child the subtask, relevant explicit constraints, a scoped evidence root, needed current artifacts, and a small selected working set. Do not copy the parent's whole transcript. Resolve the child's own model/route/profile contract independently; a Sol child of an Astra parent is a valid configuration when explicitly selected and benchmarked.

Children return a concise public result, observed artifact changes, unresolved issues, and exact evidence refs. The parent imports only needed evidence. Child assertions remain attributed until supported; a child saying “tests pass” must identify which revision and test result.

Require resource ownership or isolated worktrees for concurrent writes. Parallel read-only investigations can share immutable evidence; conflicting writes cannot be made safe merely by placing two agent names in the prompt. Do not automatically spawn a child for every task. Delegate when expected independent work exceeds setup, duplicated context, and merge cost.

### 19.4 Passivation and restart

Passivate only when the runtime can serialize the required state and there are no unsafe outstanding effects. A live process or kernel may require continued residency, an explicit snapshot protocol, or a clear restart status. Never tell the resumed model that a variable or handle remains live solely because its name is in a checkpoint.

Persist operation identities before side effects. On restart, distinguish never-started, running/attachable, completed, failed, cancelled, and unknown outcomes. Do not replay a non-idempotent tool simply because its result was not committed. Reconcile through runtime/provider status where possible; otherwise expose the uncertainty.

Measure useful speedup under two and then more children separately. Include extra inference, memory, merge work, and failures. The release may retain one-child defaults on routes or environments that have not passed the concurrency gates.

## 20. Astra-specific features without contaminating the generic stream

### 20.1 Behavioral tuning

Current model guidance describes Astra-specific tendencies around clarification, instruction sensitivity, detailed output, delegation, and testing. These justify a separately versioned behavioral policy, not an unsupported claim that the same instructions improve Sol or Qwen. [E6]

Use a small policy focused on completing authorized work, asking only consequential blocking questions, writing the requested artifact rather than unnecessary surrounding prose, and choosing meaningful verification. Preserve user-specified constraints. Audit skills and repository instruction files for contradictory or overbroad guidance rather than adding another long instruction layer to fight them.

Do not equate autonomy with permission for destructive or external side effects. Do not impose “never ask” or “never test” rules. Do not require delegation when the configured child limit is one or when the work cannot be meaningfully separated. Benchmark the behavioral changes independently from compaction.

### 20.2 Effort configuration

Current Astra guidance does not support `none` reasoning effort. Use the adapter's supported values and preserve the baseline effective setting during migration. Any automatic reduction must be an explicit quality-tested experiment. [E6]

For native `configuration_update` items, current documentation restricts it to standard single-agent requests, requires ordered updates, disallows adjacent updates, and excludes automatic compaction/truncation and the standalone compaction endpoint; its explicit in-request compaction path has separate handling. Encode these as compatibility predicates and replay fixtures, not a comment near a request builder. The reported request-level effort is not sufficient to reconstruct the effective mid-conversation setting. [E2]

Track the effective effort timeline in the request manifest and preserve it through supported continuation. Do not rewrite the initial request-level setting on every turn when using this mechanism. On unsupported routes, either keep the fixed setting or use an explicitly supported ordinary configuration change at a new valid boundary.

### 20.3 Native asynchronous tools

Current native async support applies to application-run function/custom tools, not hosted built-ins, and must not be combined with programmatic tool calling; provider-native multi-agent mode has an additional async/parallel restriction. **Provider-native multi-agent mode is not the same thing as Base Context's locally managed child sessions.** [E4]

Use the shared job registry, but let the adapter own protocol delivery. Return completed results on the original call identities; keep waiting/status messages distinct from the actual result. Do not claim a tool has completed merely to let the model continue. Bound pending calls and bytes, handle out-of-order completion, and preserve ownership across cancellation and disconnect.

Enable native async only when useful independent work exists. Otherwise the model may spend more tokens speculating while a tool runs. A synchronous generic tool that starts a durable host job and returns a handle remains a separate, valid mechanism; it does not require Astra's native protocol.

### 20.4 Mid-turn steering

Current native steering accepts user updates on an Astra Responses WebSocket connection. Acceptance queues the update; it does not undo earlier output or cancel tools already started. Queued updates require connection-aware recovery and may await required tool input. [E5]

Persist each submitted user update with a local idempotency identity, provider acknowledgement, and applied/failed/unknown status. Apply task-state revisions only with the correct event ordering. After disconnect, reconcile accepted updates against observed continuations before replaying; do not blindly submit the same instruction twice.

Track automatically created continuation responses as separate metered attempts under the same logical user operation. Preserve completed output and side-effect history. Steering is not a substitute for tool cancellation, artifact rollback, or transaction semantics.

### 20.5 Programmatic tool calling

Treat provider-native programmatic tool calling as a separate capability, including its program/caller linkage and internal execution accounting. Do not confuse it with the inherited local Python/Bash batching or evidence-handle operations. A future eligible Sol adapter may use it; an Astra async adapter must honor the incompatible combination. [E4, E6, E11]

Do not make this feature a dependency of the shared memory runtime. Evaluate it only after ordinary evidence-local execution, fixed views, and receipts are correct.

## 21. Generic/Sol and Qwen deployment requirements

### 21.1 Sol must not become a compatibility afterthought

A preserved Sol control, its original corpus, and its effective provider settings are first-class release artifacts. Run it before and after the source-fork migration. Keep skill selection, short-observation handling, recovery persistence, and native harness compaction stable for that comparison.

Promote shared data-integrity, index, and accounting work to Sol without silently changing its prompts or summary strategy. Then test the semantic bridge, selective prefetch, bounded checkpoint, and eligible cache/native-state improvements individually. The goal is to improve an already efficient path, not force it to mimic Astra.

Do not classify Sol as a “plain text only” model. Its actual route determines whether opaque state, explicit cache options, and native compaction are available. Do not borrow Astra's effort values or novel control items. [E1–E3]

### 21.2 Qwen and other generic models

Implement at least one pinned real generic deployment contract in addition to Sol: exact model revision, tokenizer, chat template, serving stack/version, tool parser, reasoning parser/mode, and context limit. A representative Qwen deployment is appropriate; the official Qwen3 guidance is a template-specific reference, not a claim that Qwen3 is the newest model or that one parser works for all Qwen releases. [E7]

Validate complete tool-call/result cycles, multiple calls, error results, empty text, reasoning fields, continuation after a tool, and compaction-boundary role ordering. Never execute malformed or unvalidated tool arguments. A local deterministic parser repair must still preserve the original model output and pass the tool schema; do not use ambiguous text recovery to authorize side effects.

Do not invent provider token usage or cache savings when the server omits them. Separate API-equivalent cost from measured local compute cost. For self-hosted experiments, record hardware, precision/quantization, parallelism, routing, and server load. Cache behavior and wall-clock numbers are meaningless without that deployment context.

For other models, support the conservative protocol-neutral core where the fork retains a valid adapter. “Universal” means extensible contracts and safe fallbacks, not a promise that every unknown model accepts the same wire format or reaches the same accuracy.

## 22. Measurement and benchmark protocol

### 22.1 Repair accounting before claiming optimization

Instrument the common inference boundary for main responses, children, native summary slices, turn-prefix summaries, branch summaries, refinement, learning, bridge generation, retries, native compaction, and steering-created continuations. Assistant message totals alone are insufficient. The synthetic probe supplied 600 known input tokens across ordinary, summary, and refinement operations; the old parser reported 100. Its missing-usage path also reported zero. [L14, H2–H6, T1]

Do not retroactively invent missing historical usage. Mark those reports incomplete and preserve them. New complete accounting does not make an old baseline's unknown cost comparable to a fully metered candidate.

### 22.2 Request receipt contract

Persist a unique local attempt ID before sending. A provider request ID may arrive later or remain absent. At minimum, record:

```text
identity: local attempt, provider request, logical operation, session/branch,
          root/parent/child ownership, retry ordinal, source sequence
configuration: model, route, adapter, profile, effective effort timeline,
               processing tier, pricing version, tool/template revision
purpose: main / summary / refine / learning / child / native-control / other
outcome: completed / failed / cancelled / interrupted / unknown
usage: raw provider payload + normalized totals + completeness status
cache: reads, writes, uncached input, supported breakdown, prefix metadata
clock: queued, admitted, sent, first event, first content, last event, settled
commit: output committed or rejected; checkpoint/epoch association
```

A cancelled or rejected output can still have a complete billable receipt. An apparently successful assistant message can still have incomplete usage. Keep outcome, usage completeness, and output commitment independent.

Deduplicate aggregate summary usage and constituent slice receipts. Aggregate parent usage and child receipts must not both be charged to root totals. Root-inclusive metrics sum unique attempts in the ownership tree; per-agent own usage stays separate. Preserve unknown amounts rather than filling them with estimates and presenting them as actuals.

### 22.3 Token and price normalization

Each adapter declares whether its input total includes cached reads and writes. Where the fields are confirmed disjoint components of total input, ordinary input is `total - read - write`; where the contract differs, use the appropriate normalization. Invalid or missing relationships produce an accounting error/incomplete record, not a silent clamp to zero. Reasoning tokens already included in output must not be added again. [E1, H5–H6]

A normalized cost function is conceptually:

```text
cost = ordinary_input × applicable_input_rate
     + cache_read × applicable_read_rate
     + cache_write × applicable_write_rate
     + output × applicable_output_rate
     + separately priced tool/other charges
```

All quantities use the adapter's documented semantics and versioned tariffs. Apply context-length tiers per actual request, not cumulative session tokens. Separate provider-reported billable amounts, reproducible API-equivalent cost, and local-serving compute cost. Do not present a Codex subscription comparison as an actual API invoice.

### 22.4 Timing and context metrics

Report user-task wall time and final settlement wall time separately. Break down provider queue/TTFT/decoding where observable, local tool execution, archive/index work, checkpoint work, waiting, and recovery. Do not sum parallel tool durations and call that elapsed time. Report critical-path and aggregate work separately.

Track provider input/output/reasoning breakdown where available, cache reads/writes, maximum and average rendered prompt size, bytes selected versus archived, recovery calls and misses, repeated recovery of the same evidence, rotations, summary calls, native compactions, active/resident children, RSS, archive size, index size, and event-loop stalls.

A short client payload with large provider-retained state must not be reported as a small model context. A lower compaction count achieved by raising the context window is not an equivalent optimization. A cache hit does not eliminate output-generation latency.

### 22.5 Freeze the experimental populations

Maintain these separate controls; a control is a pinned executable artifact, not a moving feature flag:

| Control | Purpose |
|---|---|
| S on its original host/settings/corpus | Reproduce the successful public Sol implementation with its original denominator. |
| H, unmodified, on the matching corpus/model | Measure the current upstream baseline independently of the plugin and fork. |
| B0-S: native source port of S behavior | Isolate fork ownership/identity and necessary 0.9.3 adaptation from model-policy changes. |
| D on its original declared environment, plus B0-D | Separate the supplied experimental Astra candidate from its native source port. |
| B1 integrity/accounting fixes | Expose necessary correctness changes without attributing them to a new memory policy. |
| B2+ single-feature improvements | Attribute indexing, projection, continuity, execution, and policy effects. |
| Pinned Qwen/generic deployment with native Base Context | Validate non-OpenAI semantics and measure against that deployment's own control. |

A rename can change paths, tool output, instructions, model-visible identity, or provider prefix reuse. Golden comparisons must enumerate permitted identity substitutions and intentional correctness differences; do not strip arbitrary text until requests happen to match. Benchmark B0-S and B0-D separately when their behavior differs. An optimizer-off fork is not identical to H because native safety/accounting and product identity remain.

Use exact task/generator/judge hashes, identical allowed tools, permission policies, timeouts, environment, and resource limits within each paired comparison. Do not tune tasks or judges to improve a product score. The supplied Astra corpus and public Sol corpus may differ; label them and rerun controls when crossing corpora.

For model comparisons, record actual model IDs/snapshots, route/auth mode, effective effort, tier, cache policy, and deployment configuration. Do not mix Sol and Astra into one score that can hide deterioration on either.

### 22.6 Retry and selection rules

Use preregistered primary attempts. Do not rerun only a slow or expensive candidate and select its fastest passing retry. The supplied runner's performance-triggered current-only replacement is unsuitable for causal efficiency claims. [L14]

Define invalid infrastructure failures before running: corroborated provider outage/capacity failure, runner corruption, or equivalent conditions. Keep their raw receipts and costs separate. Apply the same invalidation policy to both arms. Valid task failures and timeouts remain in primary accuracy and all-attempt resource totals.

Where retries are part of the product policy, evaluate the complete policy: all attempts, success after retry, total time, and total cost. A selected best-attempt table may be retained as exploratory analysis, clearly labeled, but it cannot replace the primary result.

### 22.7 Statistical interpretation

Use paired randomized ordering and repeated blocks for final comparisons. Report per-task results, total all-task spend, cost per successful task, matched-both-pass efficiency, and uncertainty intervals for paired differences. Matched-both-pass results omit failures by construction; show them alongside unconditional accuracy and spend, not instead of them.

A thirty-task suite with a 30/30 baseline has little room to demonstrate higher accuracy. Add held-out tasks and fault-injection scenarios; do not promise a statistically established accuracy increase from one perfect run. No repeatable new failure on a previously passing task may be waved away because average cost improved.

Record cache-warmth and ordering. Separate cold-start and steady-state measurements where feasible, and do not assume a request key necessarily isolates server cache contents unless the provider documents that behavior. Shared serving load and cache residency can confound timing; report them where observable.

### 22.8 Required ablations

Evaluate identity-only source fork, semantic patch ports, accounting-only changes, data-integrity fixes, indexed storage, compiler changes, recovery/prefetch, semantic bridge, portable checkpoint, eligible native continuation, cache boundaries, behavioral policy, auxiliary model selection, and concurrency as distinguishable variants. Combine only changes with individually understood effects, then test their interactions.

For Astra, separately test effort updates, native async, and steering. For Sol, explicitly test shared native/cache improvements rather than leaving them disabled because the profile is generic. For Qwen, include a template/parser negative test and at least one successful complete tool/recovery/rotation cycle.

### 22.9 Targets, not promised results

The first release target is preserved or improved correctness, complete accounting, safe product isolation, and no systematic Sol regression from the source-fork migration. Seek substantial additional savings on long-horizon and evidence-heavy tasks through less repeated work, not a promised percentage inferred from architecture. Predeclare quantitative promotion margins after control variance is measured; do not choose them after seeing the candidate results.

Report absolute and relative deltas against H, S, and B0 where appropriate. A fork can be worth shipping for integrity and maintainability even before it beats the optimized Sol control on cost; label that milestone honestly instead of conflating product ownership with optimization success.

Bounded-memory targets are more directly testable: no whole-history scan on ordinary append/exact lookup, a configurable cap on decoded hot state, stable maximum working-set size across many epochs, and bounded queue growth under slow storage/provider conditions. Choose latency thresholds on declared hardware and publish the fixtures; do not claim a universal millisecond target independent of archive size and machine.

A feature that helps Astra but hurts Sol can ship behind an Astra-specific profile flag. A feature that helps only large tasks can remain disabled for short tasks. A feature with inconclusive benefit should remain experimental rather than becoming universal through architectural enthusiasm.

## 23. Implementation work packages and promotion gates

### 23.1 How the coding agent must work

Deliver a sequence of reviewable commits and tested artifacts, not one giant rewrite. Each work package identifies the source owner, invariants, changed model-visible behavior, affected persistent contracts, tests actually run, and remaining validation. Keep characterization tests of old defects separate from regression tests of desired behavior.

Use the previous source paths as navigation aids; inspect H before applying an old implementation idea. Interface names and directory suggestions in this document are contracts/concepts, not a requirement to build abstractions with no caller. Reuse a correct existing service instead of adding an equivalent one.

Do not let missing external publication credentials block local development. Do not let an unavailable provider test turn into an unsupported support claim. A release gate may remain unmet while completed local changes are delivered honestly. Critical source integrity work can proceed before exact public S retrieval, but Sol behavior promotion cannot.

### W0 — Freeze controls, audit ownership, and establish a build

**Inputs:** H, D, previous audit artifacts, and the public S source/artifact to retrieve. Verify archive hashes and Git ancestry. Retain original repositories as immutable controls; initialize Base Context from H's actual source history where available.

**Work:** Create baseline manifests, source/build compatibility matrix, patch-disposition ledger, test inventory, license/dependency inventory, and an evidence-status report. Fetch/pin S and produce the missing source diff against D. Install pinned dependencies and run the unmodified supported test/build paths before interpreting later failures as fork regressions. Separate external catalog refresh from ordinary builds when establishing reproducible inputs.

**Exit gate:** H and available original controls are runnable from manifests, or exact environment failures are documented. No Sol-preservation claim until S is frozen. Do not edit benchmark fixtures to make the first control pass.

### W1 — Establish product isolation without optimizing behavior

**Owners:** Product config, release scripts, package manifests/workspaces, daemon protocol/ownership, runtime bootstrap, installer/updater, telemetry/auth configuration.

**Work:** Implement the identity matrix in §4. Preserve provider protocol identifiers and license notices. Own package/runtime resolution; isolate state and workers. Add `doctor` output for product/source/schema/provider contract and all resolved directories, with secrets redacted. Run two-product coexistence fixtures and extracted packer tests against actual built artifacts.

**Exit gate:** Base Context installs/runs locally without mutating Prime Agent; no upstream executable/runtime fallback; no auto-imported auth or upload jobs. All identity changes that can reach model input are listed. This milestone is product isolation, not a token optimization.

### W2 — Port the semantic patch capabilities into source

**Owners:** `packages/agent`, `packages/ai`, coding-agent session/compaction/execution services, source exports.

**Work:** Resolve every logical patch capability from the inventory. Integrate finalized capture, projection purpose, explicit turn control, current compaction slices/lineage, and indispensable daemon/runtime repairs into H source. Build declarations, modular packages, CLI bundle, daemon and SDK from one graph. Keep conservative child limits and model-policy defaults.

**Exit gate:** No Base Context install/build/start/update invokes the legacy patcher or edits another package's generated output. Golden scripted provider exchanges and tool results match the intended control, with enumerated differences. Every dropped workaround has a symptom test or documented evidence.

### W3 — Make source events, effects, and receipts reliable

**Owners:** Session coordinator, event log, execution edge, common inference boundary, receipt ledger.

**Work:** Fix checked-write/durability failures; implement owner fencing, bounded frames, repair/replay validation, and canonical event publication. Capture original/executed inputs exactly once and preserve ordered results/media/errors. Route all inference purposes through receipts. Distinguish unknown tool outcomes from retryable reads. Preserve H's late-slice and semantic-lineage behavior.

**Exit gate:** Fault injection for short writes, zero progress, disk full, partial commits, cancelled streams, late summary slices, and duplicated deliveries passes. No acknowledged reference points to uncommitted data. Missing usage remains unknown. No effect is blindly replayed because its result is absent.

### W4 — Repair durable task state and index exact evidence

**Owners:** Context store/state, archive migration, source journal/index materialization.

**Work:** Separate display limits from task truth. Fix case-sensitive identities and supersession. Import existing snapshots with coverage qualifications. Implement SQLite/index choice compatible with the supported runtime; index exact IDs, source sequences, branch scope, subjects, paths/symbols and resource revisions. Reuse existing envelopes/locators rather than duplicating everything.

**Exit gate:** More than twelve active items survive; amendments and source authority remain correct; exact lookup does not scan all observations; index loss/rebuild does not rerun tools. Search distinguishes partial coverage from no match. Access control and deletion tombstones pass.

### W5 — Bound native hot history and long-session memory

**Owners:** Session manager, daemon catalog, compiler inputs, archive caches, Python/process resource manager.

**Work:** Replace whole-history convenience arrays/maps in hot consumers with bounded pages and branch cursors. Add byte/item budgets for caches, queues, results, decompression and diagnostics. Page session-list consumers. Keep one canonical history rather than a hidden in-memory duplicate. Instrument total process-tree resident memory and event-loop stalls.

**Exit gate:** Declared 10k, 100k and 1m event fixtures, including many epochs/branches, remain within configured decoded-state and queue limits. Ordinary append/exact lookup have no whole-history scan. File/index size may grow; process memory and provider working set must not grow proportionally to retained history. Hardware and platform are recorded.

### W6 — Native compiler, selective recovery, and evidence-local execution

**Owners:** Compiler, recovery tool, artifact/evidence handles, provider render/count interface.

**Work:** Preserve short literal observations and stable views. Implement revision-aware dependency closure, real-request budgeting, bounded selective retrieval and batch reads, stale-test/resource annotations, and deterministic filtering near large data. Cache incrementally. Avoid extra model calls and routine memory-management tools. Keep recovered evidence stable during an epoch.

**Exit gate:** Small tasks do not incur memory rituals or auxiliary requests; large outputs can be sliced/queried without whole materialization; delta/media/error recovery is exact; source changes invalidate correctly. Provider and budget paths consume the same snapshot. Recovery quality and overhead are evaluated independently of new compaction policy.

### W7 — Preserve and improve the generic/Sol stream

**Owners:** Generic policy, inherited native summary service, skills, selective reminder policy.

**Work:** Certify B0-S from frozen S before promoting tuning. Keep generic summary behavior and recovery lifetime initially. Add deterministic state and selective evidence improvements in separate variants; test a concise semantic bridge only when it helps. Validate one pinned non-OpenAI deployment with complete template/parser/usage contracts.

**Exit gate:** Sol's historical denominator is reproduced or deviations are explained, not hidden. No systematic per-task regression is concealed by aggregate savings. Qwen/generic passes valid tool cycles and recovery/rotation fixtures. Sol remains a first-class supported path, not merely a fallback.

### W8 — Implement atomic bounded checkpoints and compatible native continuation

**Owners:** Continuation coordinator, provider adapters, evidence coverage, working-set compiler.

**Work:** Implement the checkpoint transaction, canonical native-mode handling, hysteresis, and portable public fallback. Ensure archive coverage includes short literal history and user amendments. Do not serialize every historical reference or summary into the checkpoint. Preserve pending replay groups and resource generations across rotation.

**Exit gate:** Late user/tool events cannot disappear; crash exposes an old or new complete checkpoint; no dangling refs; no malformed call/result/opaque/native output splicing. Model switching follows a compatible lineage or public fallback. Evaluate portable/native modes separately for each eligible profile, including Sol.

### W9 — Introduce Astra-specific and shared cache capabilities selectively

**Owners:** Astra policy and AI capability manifests/adapters.

**Work:** Independently implement and validate explicit cache controls, opaque replay, native effort configuration, async tools and steering where supported. Put shared capabilities in adapters rather than Astra-only code. Add feature-combination predicates. Do not assume Codex/proxy transports have the public Responses contract. Keep unsupported/unknown advanced features disabled without paid startup probes.

**Exit gate:** Recorded live route tests for each promoted feature, per-model ablations, no unsupported fields or silent effective-effort changes. Account for automatic continuations and cancelled attempts. A feature that helps only Astra or long tasks stays scoped to that case.

### W10 — Replace the one-child workaround with owned scheduling

**Owners:** Execution coordinator, daemon/workers, resource-generation service, child interface.

**Work:** Implement atomic pre-await reservations, tree-wide active/resident/kernel/inference budgets, bounded queues, fairness, cancellation, result commit/delivery, restart fencing, and passivation. Preserve H's cancellation repair. Avoid parent-wait deadlock and unsafe concurrent writes. Stage two-child validation before higher limits.

**Exit gate:** Multi-process fault/concurrency tests pass without leaked slots, double effects, stale generation releases, unbounded resident children or lost results. Measure total cost and useful critical-path speedup. Retain one-child defaults for unvalidated environments; model identity is not authorization to raise concurrency.

### W11 — Deliver non-destructive migration and recovery

**Owners:** Import/export, schema/versioning, runtime restore, auth/config migration, extension compatibility.

**Work:** Implement dry-run, stable-source import, manifests, reference mapping, staged activation, repeated-import idempotency, paused schedules/jobs, opt-in credentials, and explicit trusted runtime resume. Disable legacy plugin double-loading. Define binary/schema/provider-state rollback boundaries.

**Exit gate:** Interrupted migration never modifies source or activates incomplete target state. Prime Agent and Base Context can run separately afterward. Older incompatible writers are rejected; exact evidence is still readable/exportable. No imported schedule, trace outbox, skill, extension or snapshot acquires execution authority silently.

### W12 — Certify releases and model policies

**Owners:** Evaluation, release/security, all runtime owners.

**Work:** Run corrected thirty-task campaigns, held-out tasks, cold/steady-state measurements, scale/fault fixtures, real provider contracts and actual installed-artifact tests. Publish complete receipts/manifests and per-model promotion decisions. Verify all distribution notices, dependency identities, offline catalog inputs, updater origin checks, and platform behavior.

**Exit gate:** No stop-condition failure, no missing accounting presented as complete, and no unsupported support claim. Ship experimental flags separately from defaults. Namespace/publication credentials are required only for publication, not for preparing local tested artifacts.

### W13 — Establish maintained-fork operations

**Owners:** Named maintenance roles, not the model during ordinary user tasks.

**Work:** Deliver upstream-intake ledger/process, security/provider watch procedure, dependency policy, support matrix, schema compatibility policy, delta reports and release rollback instructions. Document frozen plugin support scope and migration path. Prefer sharing minimal generic fixes upstream where useful.

**Exit gate:** Every owned subsystem and deferred risk has an accountable role; relevant upstream changes can be assessed/backported without a full rebase. A release does not require an upstream version match or a re-run of binary string replacements.

### 23.2 Dependencies and defaults

```text
W0 → W1 → W2 → W3 → W4 → W5 → W6
                            ├→ W7 → W8 → W9
                            └→ W10 (after W3 ownership foundation)
W1 + W3 + W4 + W8 → W11
all promoted features + W11 → W12
W13 begins after W0 and is required for ongoing releases
```

The diagram shows logical prerequisites, not a demand for serial execution of every file edit. Storage and scheduler work can proceed independently once their shared ownership contracts are settled. Do not parallelize conflicting edits to the same giant session owner without integration responsibility.

Initial production defaults preserve the validated generic control behavior, use native exact storage and safety, avoid speculative auxiliary calls, and retain conservative concurrency. Each more aggressive compiler/continuation/provider feature earns its default through its own tests and per-model evidence. No “enable all Astra features” switch may bypass compatibility rules.

### 23.3 Review boundaries that prevent a failed rewrite

Do not combine a product rename, wholesale session-manager extraction, new summary prompt, new task fixtures, raised child count, different model effort, and revised price parser in one benchmark arm. Such a result is uninterpretable even if it looks cheaper.

Prefer source changes with an obvious owner and a concrete test. A new cache requires an invalidation contract; a new background job requires ownership and receipts; a new compressed view requires coverage and replay closure; a new automatic behavior requires per-model evaluation; a new persistence format requires migration and crash recovery. These are engineering gates, not additional instructions for the task-solving model.

## 24. Acceptance tests and stop conditions

Each test must identify whether it is offline/unit, fake-provider integration, real-provider contract, or full task benchmark. Passing one layer does not imply the others passed.

### 24.1 Preservation, state, and recovery

| Test | Required result |
|---|---|
| P01 — Exact Sol baseline diff | Pinned S is available; deviations from S are explicitly classified, not guessed from version numbers. |
| P02 — Source-port golden requests | The intended Sol behavior survives native source migration; every visible difference is explained. |
| P03 — Model-independent fixed views | Sol, Astra, and a generic adapter use the same exact sources without cross-profile policy leakage. |
| P04 — Thirteen and one thousand active constraints | No authoritative loss; display remains bounded and omitted items remain recoverable. |
| P05 — Case-sensitive literals | `Foo.txt`, `foo.txt`, flags, quoted values, and numeric limits retain exact identities. |
| P06 — Ambiguous updates | No unjustified supersession; both versions and their sources remain available. |
| P07 — Descriptive state | Model plans do not become user requirements or mandatory completion gates. |
| P08 — Small literal history | Short unprojected messages survive a checkpoint through durable exact locators. |
| P09 — Recovered evidence | Evidence read at turn N remains available at N+1 and later in the same epoch. |
| P10 — Single-call recovery | A known ID and a task-scoped need can be resolved in one bounded batch without list/inspect/read waterfalls. |
| P11 — Retrieval completeness | Partial indexes, deleted sources, permission denial, and true complete misses are distinguishable. |
| P12 — Scope and injection | Cross-project data does not leak; archived instructions remain attributed data. |
| P13 — Freshness | A test result becomes stale after relevant changes; an older resource revision is labeled. |
| P14 — Skills | Selected skills stay versioned and bounded; malicious/untrusted history is not learned as authoritative instruction. |

### 24.2 Compiler, continuation, and provider contracts

| Test | Required result |
|---|---|
| C01 — Generic compaction gate | Generic sessions do not invoke Astra experimental reference policy automatically. |
| C02 — Stable prefix | Unchanged source/profile/template/tool revisions produce stable earlier visible units. |
| C03 — Same-ID mutation | Mutation is rejected by the ABI or invalidates the cached view via revision. |
| C04 — Budget-only purity | Repeated budgeting does not alter epoch, selection, ownership, or inference counts. |
| C05 — Delta closure | Removing a baseline triggers valid materialization/rebasing, not an uninterpretable delta. |
| C06 — Protocol closure | Calls/results, reasoning items, phases, media and program/caller links survive required replay. |
| C07 — Unknown block | An unknown required block is preserved or causes safe fallback; never silently dropped. |
| C08 — Tokenizer diversity | Code, CJK text, JSON, images and provider templates remain within validated budgets. |
| C09 — Huge required group | No truncation of required protocol groups; explicit valid fallback or limit result. |
| C10 — Bounded checkpoints | Hundreds of epochs do not accumulate all prior prose or all prior source IDs in the prompt. |
| C11 — Checkpoint race | Late input/results are included or invalidate the candidate; no lost source events. |
| C12 — Checkpoint crash | Restart observes one committed epoch, never a partially activated checkpoint. |
| C13 — Native canonical output | Each native mode follows its exact returned-window and pruning contract. |
| C14 — Public versus opaque continuity | Public recovery never exposes hidden reasoning or claims equivalent native state. |
| C15 — Model/route switching | Sol→Astra→Qwen switches preserve public task/evidence state without incompatible opaque replay. |
| C16 — Kernel reality | Live, restarted, absent and unknown kernels produce accurate resume text; Bash-only works. |
| C17 — Expired provider state | A documented portable restart path works, or a clear limit is surfaced without invented continuity. |
| C18 — Cache adapter | Eligible Sol and Astra routes receive supported options; unknown routes do not. |

### 24.3 Execution, lifecycle, and new controls

| Test | Required result |
|---|---|
| X01 — Simultaneous child spawns | Capacity is reserved before awaits; configured active/resident limits are never exceeded. |
| X02 — Spawn failure | Reservation is released exactly once; failed child remains diagnosable. |
| X03 — Parent waiting | No deadlock when the child needs the only free inference slot. |
| X04 — Nested cancellation | Overlapping child membership terminates without duplicate cancellation storms or leaked jobs. |
| X05 — Passivation | Live handles/resources are preserved correctly or explicitly invalidated. |
| X06 — Unknown side effect | Restart does not blindly rerun a possibly completed non-idempotent operation. |
| X07 — Parallel writes | Resource ownership/worktree isolation prevents silent overwrite conflicts. |
| X08 — Polling | Unchanged job status does not create an unbounded model conversation. |
| X09 — Shutdown | No unowned learning/refinement inference starts during disposal; receipts settle honestly. |
| X10 — Off mode | No context-specific policy injection, automatic auxiliary inference, or destructive optimization persists; native safety and accounting remain active. |
| X11 — Astra effort rules | Unsupported effort/combination/ordering is rejected before the paid request; no unsupported combination is guessed from model name. |
| X12 — Native async | Results use original identities; out-of-order completion, timeout and cancellation preserve ownership. |
| X13 — Steering | Accepted/pending/applied/failed/disconnected updates are durable and not duplicated. |
| X14 — Mixed-model children | Each child resolves its own contract and receives only authorized relevant evidence. |

### 24.4 Storage, accounting, and release

| Test | Required result |
|---|---|
| R01 — Archive fault injection | No dangling projected refs after disk-full, interrupted write, index failure, or restart. |
| R02 — GC | Referenced raw history, dependencies and active jobs survive; user deletion is respected. |
| R03 — Scale | Ordinary append and direct lookup do not scan all observations at 10k, 100k and 1m declared source-event fixtures. |
| R04 — Hot memory | Total harness/process-tree decoded hot history, caches and queues stay within configured bounds across long history. |
| R05 — Large exact reads | A small selected range does not require unbounded decompression or memory. |
| R06 — All inference purposes | Main, child, summary, refinement, learning, retries and native controls produce receipts. |
| R07 — Deduplication | Parent totals, summary aggregates and detailed attempts are not double-counted. |
| R08 — Unknown usage | Missing usage remains unknown; known zero remains zero. |
| R09 — Late settlement | Failed overall summary/cancelled operation can retain consumed usage without committing its output. |
| R10 — Pricing | Per-request cache/read/write/output and applicable tiers are normalized correctly. |
| R11 — Retry fairness | No performance-triggered current-only replacement in primary results. |
| R12 — Packaging | Modular SDK, declarations, daemon and CLI bundle derive from one tested source graph; no post-build or installed-dependency patching. |
| R13 — Real providers | Each promoted route passes live tool/recovery/continuation tests with recorded settings. |
| R14 — Accuracy | No repeatable new task failure is concealed by aggregate efficiency or a different model's gains. |

### 24.5 Fork ownership, isolation, and crash safety

These tests supplement the sixty core tests above. They are required tests to implement/run, not results claimed by this review.

| Test | Required result |
|---|---|
| F01 — Ancestry | Release manifest names the exact H ancestor, selected upstream ports and owned source commit. |
| F02 — Patch retirement | No install, build, start, update or repair path executes the legacy patcher or modifies nested upstream distributions. |
| F03 — Dependency isolation | Fresh installation resolves all owned modules to the fork; making upstream coding-agent packages unavailable does not break runtime resolution. |
| F04 — Native surface parity | Interactive, headless, SDK/RPC and daemon modes use the same capture, compiler, permission and receipt owners. |
| F05 — Identity matrix | Every runtime path, environment key, socket/pipe, update source, package identity and help link matches the declared product policy. |
| F06 — Two-product coexistence | Install/run/update/uninstall Base Context without changing Prime Agent files, daemons, auth, archives or command resolution. |
| F07 — Cross-product handshake | Base Context rejects an upstream daemon identity without adopting, signalling or killing its workers. |
| F08 — Worker fencing | A stale PID/owner generation cannot issue commands, publish results or release capacity belonging to a replacement. |
| F09 — Runtime bootstrap | Managed Python environment contains the owned pinned distribution; `rlm` imports work without upstream fallback or conflicting distributions. |
| F10 — Environment parsing | Unset, empty, relative, Unicode and whitespace-containing path values follow explicit rules; no accidental current-directory state root. |
| F11 — Update isolation | Upstream URL redirects, wrong product metadata, invalid integrity and incompatible schemas cannot replace the installed product. |
| F12 — Catalog determinism | Normal builds consume pinned catalogs; network changes do not alter the model list without an explicit reviewed refresh. |
| F13 — Real artifact notices | Every distributed package/binary/runtime payload contains the applicable license and attribution material; verify archives, not only the source tree. |
| F14 — No surprise network export | Startup/import/shutdown does not send traces, outbox jobs or secrets to an inherited destination. |
| F15 — Auth contract | Unvalidated client identities/routes are not silently reused; explicit credential import/reauthorization is scoped and redacted. |
| F16 — Dry-run migration | Reports proposed changes and coverage without changing the source, target active state or live worker ownership. |
| F17 — Interrupted import | Source stays untouched; partial target is not activated; retry resumes or safely restages without duplicate events. |
| F18 — Legacy reference mapping | Old observation/task/artifact references resolve to the same exact evidence or an explicit unavailable tombstone. |
| F19 — Paused imports | Schedules, heartbeats, pending autonomous jobs and trace outboxes remain inert until authorized resumption. |
| F20 — Trusted restore | Preview/import never executes an extension, skill or executable Python snapshot; trusted resume is explicit and version-checked. |
| F21 — No dual context engine | Legacy Prime Context cannot double-register projection, continuation or refinement behavior inside the native harness. |
| F22 — Schema rollback | Older incompatible writers are rejected; supported read/export paths preserve source evidence without reinterpreting incompatible native state. |
| F23 — Short writes | All intended bytes are persisted before success; injected partial writes require further checked progress or an explicit failed append. |
| F24 — Zero-progress writes | No infinite retry loop; append fails, ownership enters repair state and no dangling durable reference is published. |
| F25 — Torn-tail repair | Exclusive repair handles a torn final frame; corruption in the middle is detected rather than silently discarded. |
| F26 — Journal/index gap | A crash after source commit but before indexing replays idempotently; index coverage never exceeds durable source coverage. |
| F27 — Bounded serialization | Oversized frames, decompression bombs and slow indexing cannot create unbounded buffers or block cancellation indefinitely. |
| F28 — Canonical source | Task state, evidence views and receipts reconcile to committed source identities, not three independently writable histories. |
| F29 — Effect ambiguity | Crash after an external effect but before receipt leaves an explicit unknown outcome; non-idempotent work is not blindly repeated. |
| F30 — Late checkpoint events | Concurrent user amendments, tool results and cancellation are retained in the new tail or invalidate the candidate; none are lost. |
| F31 — Independent epoch ownership | Summary, portable and native generators cannot each commit competing windows; rejected/late candidates are still metered. |
| F32 — Multi-process budgets | Concurrent spawn attempts across workers cannot exceed tree-wide limits; expired control leases do not imply external jobs stopped. |
| F33 — Child result publication | Parent receives only committed results; duplicate delivery and restart do not duplicate effects or lose artifact provenance. |
| F34 — Parent/child workspace safety | Concurrent writers are isolated or serialized; importing a child's changes reports conflicts rather than overwriting them. |
| F35 — UI disconnection | Detach/reconnect cannot orphan inference, suppress receipts, trigger duplicate execution or lose task ownership. |
| F36 — Optimizer mode transition | Turning optimization off never disables safety/accounting or expands the whole archive into one request. |
| F37 — Small-task overhead | No mandatory memory-management calls, extra summarizer/ranker requests or history scan for tasks needing no compaction. |
| F38 — Platform/runtime floor | Declared OS/Node/Python versions pass artifact, path, pipe, durability and cancellation contracts, or are explicitly unsupported. |
| F39 — Upstream intake | A sample backport records origin/dependency closure, passes targeted regressions and does not require a full upstream rebase. |
| F40 — Published claims | Each default/support/performance claim maps to a pinned artifact and executed test/report; prior probes are not labelled as new full-system validation. |

### 24.6 Long-horizon scenarios beyond the thirty tasks

Build deterministic replay/fault fixtures and a smaller set of live task scenarios: many old constraints with a late amendment; a case-sensitive API requirement recovered after ten rotations; large evolving files with delta baselines; an early decisive failure revisited much later; conflicting resource revisions; kernel restart during a task; child cancellation while a result is committing; switching models after a native checkpoint; and a long log-analysis task where the decisive evidence is sparse.

Include tasks where the correct action is to recover evidence, where recovery is unnecessary, and where an overly aggressive prefetch distracts the model. Include small tasks with no compaction so overhead regressions are visible. A design that excels only after creating artificial memory pressure is not necessarily a better everyday harness.

### 24.7 Stop and rollback conditions

Stop promotion on cross-product state mutation, unsafe imports, acknowledged incomplete writes, unowned effects, dangling references, lost explicit requirements, malformed replay, unsupported provider fields, cross-scope leakage, duplicate side effects, unbounded hot memory, incomplete accounting presented as complete, or a reproducible accuracy regression. Disable the offending feature/profile rather than masking it with a larger context window or selected reruns.

Keep committed archives readable after rollback. A previous release may ignore newer optional metadata, but it must not overwrite it or reinterpret an incompatible checkpoint as valid. Rollback should select a compatible public-state continuation or refuse safely with a clear migration message.

## 25. Required implementation deliverables and definition of done

Deliver the Base Context source fork with preserved ancestry, independently named distribution, native context runtime, owned provider/execution/receipt boundaries, exact storage and migrations, and one reproducible build graph. Do not deliver another version-gated plugin patch as the main product.

The implementation handoff must contain the patch-disposition ledger; identity/dependency/auth/telemetry audit; frozen H/D/S controls and manifests; model-policy and capability manifests; schema/import/rollback tools; regression/fault/scale/provider fixtures; corrected benchmark runner; installed-artifact checks; licensing/SBOM materials; and per-model evaluation reports with missing validation stated explicitly. Include short decision records for changed defaults and nontrivial persistent contracts.

Release documentation must distinguish product version, source ancestry, runtime/storage/daemon contracts, behavioral policy, and provider route support. List native features as validated, unsupported, unknown or experimental. A model name in a catalog is not certification of every feature through every route. Publish the differences among the preserved Sol control, generic improvements and Astra experiments.

A functional first release is complete only when the new product can be installed independently, run without the old plugin or upstream package fallback, import supported legacy data non-destructively, preserve exact evidence and task state, meter all inference, and pass the applicable protocol/lifecycle/isolation gates. More aggressive optimization defaults additionally require per-model benchmark evidence.

Do not make end users manage source ledgers, epochs, dependency closures, or ownership reservations. Do not make the task-solving model issue routine save/pin/ack commands. It should normally see the task, the useful current evidence and one stable recovery interface; the harness handles durability, selection, validity, freshness and accounting.

The architectural objective remains ambitious but specific: **arbitrarily long retained evidence history with bounded active model context and bounded decoded hot state, cheap targeted recovery, minimal repeated work, and independently validated behavior across model generations.** A maintained source fork makes the necessary ownership practical; the tests and benchmarks determine whether each proposed optimization earns its place.

## 26. Source register and reproducible audit evidence

Source tags below distinguish supplied local code from public documentation. Local line ranges refer to the supplied snapshots and may move after editing. Use identifiers as well as line numbers when locating code. External pages are mutable; recheck exact capability contracts before shipping an adapter. URLs are recorded as source identifiers, not as proof that every linked source file was successfully downloaded.

### 26.1 Supplied Prime Context source

Paths are relative to the extracted `prime-context/` root.

| Tag | Location | Evidence used |
|---|---|---|
| L1 | `EXPERT-REVIEW.md:1–109`; included benchmark evidence/results and `PRIME_AGENT_0.9.1_MIGRATION.md` | Candidate identity, frozen/corrected populations, Task13/24/27 diagnoses, accounting corrections, omitted raw runs. |
| L2 | `package.json`; `src/prime-agent-0.9.1.d.ts:1–83` | Package/dependency/Node versions and assumed patched host API. |
| L3 | `scripts/patch-prime-agent.mjs:5–118`, `122–489`, `497–532`, `533–2065`, bundled counterparts from approximately `2864`, goal/backoff `5271–5794`, usage `5849–5984`, final writes `5990–5998` | Version rejection, catalog/daemon patches, child cap, host hooks, usage integration and patch atomicity risks. |
| L4 | `src/projection.ts:267–572`, `871–1003`, `1127–1200`; `src/index.ts:1724–1746`, provider-context integration around `2136` | Fixed views, opaque-field guards, dependency closure, same-ID cache behavior, model-change epoch and ungated compaction hook. |
| L5 | `src/state.ts:53–62`, `216–405`; `src/context.ts:93–243`; `src/runtime.ts` | Display/source bounds, exact requirement handling, default config and task-frame rendering. |
| L6 | `src/envelope.ts:48–110`, `340–428` | Existing streaming envelope/source behavior. |
| L7 | `src/archive.ts` around `680`, `871–931`, `955`, `1006`, `2067`, `2644–2990`, `3141` | Catalog retention/search, publication, exact parts, baseline scan, clear semantics. |
| L8 | `src/exchange.ts`; `src/intent.ts`; `src/broker.ts` | Finalized/original/executed capture, conservative intent classification and exact/delta decisions. |
| L9 | `src/tool.ts:230` onward; `src/archive.ts` recovery functions | Existing tool actions, bounded response handling, exact recovery. |
| L10 | `src/compaction.ts:12–160`, particularly `40–43`, `110–129`; `src/index.ts:1737–1746` | Growing public-history builder, unconditional kernel claim, thinking/signature omission, generic hook exposure. |
| L11 | `src/policy.ts:1–36`; `src/index.ts:979–983` | Current behavior supplement and off-mode ownership issue. |
| L12 | `src/skills.ts`; `src/auxiliary.ts:467–530`; `src/index.ts` skill supplement around `985`, learning invocation around `2385–2410`; `src/learn.ts` | Bounded/frozen skills, utility gating, model/effort selection. |
| L13 | `src/index.ts:2421–2468` plus startup/refinement override paths | Fire-and-forget learning and disposal/refinement ownership. |
| L14 | `benchmarks/python-realworld-30/benchlib.py:385–451`; `run.py:615`, `680–714`, `1140–1178` | Message-only accounting, auxiliary merges, unknown-zero handling and performance retry selection. |
| L15 | `review/experiments/tool-wall-time.patch` and handoff status | Unadopted timing experiment; not part of the selected product. |
| L16 | `benchmarks/python-realworld-30/README.md:16–24`, task fixtures and runner | Tool/environment/corpus differences; run manifest must resolve historical prose discrepancies. |
| L17 | `src/workflow.ts` and associated `src/index.ts` integration | Exact-repeat/stall tracking and recovery behavior. |

### 26.2 Supplied Prime Agent source

Paths are relative to the extracted `prime-agent-main/` root.

| Tag | Location | Evidence used |
|---|---|---|
| H1 | `packages/coding-agent/CHANGELOG.md:3–26`; `src/core/semantic-edges.ts` within that package | Actual 0.9.3 changes and semantic lineage. |
| H2 | `packages/coding-agent/src/core/compaction/compaction.ts:34–36`, `98–108`, `516–567`, `682–821` | Summary slices, return shape, runner and aggregate usage. |
| H3 | `packages/coding-agent/src/core/agent-session.ts:7560–7655` | Native compaction ownership and request settlement. |
| H4 | `packages/ai/src/models.generated.ts:8566–8589`, `8704–8937`; `models.ts:38–45`; coding-agent `src/core/model-registry.ts` around `382` | Native OpenAI/static Codex catalog distinction and fast-mode/discovery checks. |
| H5 | `packages/ai/src/providers/openai-responses-shared.ts:472–490`; `openai-responses.ts` from `227`; `openai-codex-responses.ts` from `336` | Existing usage normalization and distinct provider request paths. |
| H6 | `packages/coding-agent/src/core/agent-session.ts:1039–1054`, `11947` onward; `src/core/usage.ts` | Own versus child-attributed usage and preserved context accounting. |
| H7 | `packages/coding-agent/src/core/agent-session.ts:10395–10474`, `10550–10640` | Child cancellation traversal, retained membership and spawn registration. |
| H8 | `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts:1116–1154`, around `1446`, `5054–5060`, `5877–5878` | Eviction/readiness/snapshot behaviors requiring individual regression tests. |
| H9 | `packages/coding-agent/src/core/session-manager.ts:1140–1150`, `1793–1812` | Whole-history arrays/maps and branch/context construction. |
| H10 | coding-agent `src/core/kernel/repl-manager.ts`, `state-snapshot.ts`; `prime-agent-runtime/src/rlm/repl.py`; coding-agent changelog `23`, `34–95` | Runtime generations, snapshot/process behavior and correct release attribution. |
| H11 | `packages/coding-agent/src/core/extensions/types.ts`; `packages/agent/src/agent-loop.ts` | Public extension/loop contract to reconcile with patched declarations. |

### 26.3 Public Prime Context material recorded by the prior review

**G1 — Repository README and public benchmark presentation.** `https://github.com/BaseModelAI/prime-context` — public behavior and reported three-arm results. Recorded as accessible in the earlier universal review; this fork revision did not retrieve the exact public TypeScript tree. Reported results are not independently verified measurements.

**G2 — Public changelog.** `https://raw.githubusercontent.com/BaseModelAI/prime-context/main/CHANGELOG.md` — evolution away from lossy plugin folds and transient recovery, later fixed-view/skill/task-state refinements.

**G3 — Public package and migration metadata.** `https://raw.githubusercontent.com/BaseModelAI/prime-context/main/package.json` and `https://raw.githubusercontent.com/BaseModelAI/prime-context/main/PRIME_AGENT_0.9.1_MIGRATION.md` — previously observed dependency target and earlier ABI migration; reverify the pinned source during W0.

**G4 — Public history.** `https://github.com/BaseModelAI/prime-context/commits/main/` — previously observed release identities. Retrieve and verify `8fd60de83cb9b0506c7a4d1b13014e9316a151e4` as the recorded S control; do not use moving `main` during implementation comparisons. Runtime TypeScript source at this revision was not obtained in either review; this remains a required implementation gate.

### 26.4 External primary technical documentation

| Tag | Source identifier | Used for |
|---|---|---|
| E1 | `https://developers.openai.com/api/docs/guides/prompt-caching` | Rendered-prefix semantics, shared eligible Sol/Astra caching, explicit options, usage accounting. |
| E2 | `https://developers.openai.com/api/docs/guides/reasoning` | Persisted reasoning compatibility, effort-update ordering and restrictions. |
| E3 | `https://developers.openai.com/api/docs/guides/compaction` | Native continuation ownership and mode-specific canonical-window rules. |
| E4 | `https://developers.openai.com/api/docs/guides/async-tool-calling` | Application tool ownership and feature-combination restrictions. |
| E5 | `https://developers.openai.com/api/docs/guides/steering` | Astra WebSocket steering, queued updates and disconnect behavior. |
| E6 | `https://developers.openai.com/api/docs/guides/latest-model` | Current Astra behavioral differences and supported effort/route limitations. |
| E7 | `https://qwen.readthedocs.io/en/latest/framework/function_call.html` | Deployment/template-specific tool-use requirements; representative Qwen3 reference. |
| E8 | `https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/` | Prefix reuse versus decoding work. |
| E9 | `https://nodejs.org/api/sqlite.html` | SQLite API reference; actual Node minimum still requires testing. |
| E10 | `https://www.sqlite.org/wal.html` | Local WAL deployment and concurrency constraints. |
| E11 | `https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling` | Separate provider-native programmatic execution contract. |

No fixed live price table is embedded in this implementation contract. The implementing agent must record the applicable tariff and provider contract revision in benchmark manifests rather than inherit historical Astra rates for Sol or another route.

### 26.5 T1 — Earlier reproduced probes retained as evidence

The earlier universal-audit archive is included unchanged inside the new evidence bundle. Its probes were previously run using Node 22.16.0, globally available TypeScript 5.8.3 for isolated transpilation, and Python for the supplied benchmark parser. They did not install or execute a complete provider-connected harness.

| Probe | Observed result | Limit of conclusion |
|---|---|---|
| Active-state overflow | Thirteen constraints/open items leave twelve; oldest disappears. | Direct source-function behavior, not a measured downstream accuracy loss. |
| Case folding | `Preserve Foo.txt.` is superseded by `Preserve foo.txt.`. | Demonstrates unsafe text-wide equivalence for case-sensitive requirements. |
| Reference prose growth | 10/100/200 synthetic historical messages yield 2,797/24,217/48,117-byte summaries; 300 yields fallback at the fixture's reserve. | Demonstrates nonconstant packet growth; not a live model context benchmark. |
| Same-ID mutation | A changed message with the same cache identity returns the prior content. | Integration bug only if mutation is legal without invalidation. |
| Accounting | 600 known input tokens across three operations become 100 in the parser; missing usage becomes zero. | Synthetic event test, not reconstructed historical billing. |
| Version gate | A 0.9.3 package header is rejected as not 0.9.1. | Tests the gate, not every later patch replacement. |
| Model policy gate | The reference-compaction hook contains no model/profile guard. | Static inspection, not an end-to-end profile test. |
| Kernel claim | Public checkpoint says the Python kernel remains live without runtime input. | Demonstrates an unsupported assertion, not an actual observed restart. |
| Thinking/signature omission | Synthetic thinking and call signatures are omitted while the checkpoint succeeds. | Public history is not native replay; no malformed provider request was demonstrated. |
| Unknown provider block | Builder returns `undefined` for an unknown assistant block. | Confirms this fallback fixture works. |

The synthetic opaque/thinking markers are invented test strings, not real model private reasoning. Characterization probes deliberately assert the current defective behavior; after fixing the implementation, convert them into regression tests for the new desired behavior rather than preserving the defect to keep a test green.

### 26.6 N — New fork-specific source audit and probes

The new evidence bundle contains the scripts, observed JSON, patch-label CSV, input hashes and source-access failure record. The tests inspect supplied source or execute extracted dependency-light functions; they do not install or publish Base Context.

| Tag | Source / evidence file | Use and qualification |
|---|---|---|
| N1 | `audit_fork_surface.py`, `fork-surface-audit.json`, `patch-label-inventory.csv`; D `scripts/patch-prime-agent.mjs` | 5,998 lines, 391 label occurrences, 32 distinct literal targets. Dynamic bundle targets omitted from the count; not 391 independent defects. |
| N2 | `rename_characterization.mjs`, `rename-characterization.json`; H `scripts/pack-prime-agent-release.mjs`, especially `createReleasePackageJson` around 170–199 | Executed extracted packer functions with a new package/bin. Retained state root, repository metadata and upstream dependency keys; no real tarball built. |
| N3 | `eventlog_short_write_probe.mjs`, `eventlog-short-write.json`; H `packages/coding-agent/src/core/event-log.ts:119–140`, repair/replay around 70–111 and 143–181 | Injected 7-byte write of 74-byte event returned success. Source ignores write return. Isolated fault injection, not an observed operating-system incident or complete storage integration test. |
| N4 | `network-fetch-results.json`; hashes of supplied archives and prior specs | Container retrieval failures and provenance boundary. Exact public S source remains unavailable; prior observed pin requires W0 verification. |
| N5 | H `packages/coding-agent/src/config.ts:331`, `489–525`, `604–619`; release packer around 170–199 | Product/update/state/share identity surfaces, including dynamic naming alongside hardcoded defaults. |
| N6 | H `packages/coding-agent/src/modes/daemon/daemon-protocol.ts:55`; `daemon-supervisor-ownership.ts:19`, `320`; `daemon-supervisor.ts` near 653 | Daemon namespace, supervisor ownership root, environment and Windows pipe identity. |
| N7 | H root `package.json:53` and `packages/{ai,agent,coding-agent,tui}/package.json` | Upstream package references and inherited workspace/public identities requiring owned resolution. |
| N8 | H `prime-agent-runtime/pyproject.toml:1–19`; `packages/coding-agent/src/core/kernel/bootstrap.ts:16` and bootstrap implementation | Python distribution name/import boundary and runtime installation identity. |
| N9 | H `packages/ai/package.json:68`; `packages/ai/scripts/generate-models.ts` around 663, 757, 831, 890 | Ordinary build invokes catalog generation with external fetches; separate refresh from pinned build. |
| N10 | H `LICENSE`; `scripts/pack-prime-agent-release.mjs` function `copyPackageContents` | Source MIT notices and explicit staging list lacking `LICENSE`. Published artifact omission was not demonstrated. |
| N11 | H `packages/coding-agent/src/core/agent-traces.ts` around 843 onward; related trace/outbox configuration | Trace/auth fallback paths to audit for fork isolation. Not a claim that trace export is always enabled. |

New probe results:

```text
Patch inventory: 5998 lines / 391 label occurrences / 32 literal targets
Rename probe: new package and binary; old .prime/agent + upstream dependency keys
Short-write injection: returnedWithoutError=true; writes=1; fsyncs=1
                       actualBytes=7; expectedBytes=74; complete newline=false
```

These characterization scripts intentionally assert the supplied old behavior. Convert them into corrected regression tests in the fork; do not preserve the defect just to keep characterization green. The source-function probes use temporary local files and remove them afterward. They make no provider calls.

### 26.7 U — Upstream primary sources checked for this decision

| Tag | Source identifier | Use |
|---|---|---|
| U1 | `https://github.com/PrimeIntellect-ai/prime-agent/releases` | v0.9.3 release/commit identity and specific lineage, cancellation, passivation and settlement changes. Checked 6 September 2026; mutable page, pin source before porting. |
| U2 | `https://github.com/PrimeIntellect-ai/prime-agent/blob/main/LICENSE`; `https://opensource.org/license/mit` | Root MIT license/notice obligations; no namespace, trademark or provider-client authorization conclusion. |
| U3 | `https://github.com/PrimeIntellect-ai/prime-agent/issues` | Open issue categories as regression seeds, not proof each remains broken in H. |
| U4 | `https://github.com/PrimeIntellect-ai/prime-agent/issues/1384` | Transcript/compaction/autonomous-recovery tracker; reproduce specific symptoms before marking a fork fix. |

Provider documentation E1–E11 is a dated capability reference, not a promise of support through every proxy/Codex/auth route. Recheck exact wire contracts and supported feature combinations when implementing and before promotion. A source fork does not eliminate provider version drift.

## Final implementation directive

Build Base Context as a maintained source-owned product fork of H. Port useful Prime Context semantics once, retire compiled-output patching, isolate the product completely, and harden durable execution before changing memory policy. Preserve Sol's successful control, improve the shared exact/indexed runtime, and let Astra-specific behavior evolve independently under validated adapter contracts. Own updates deliberately, measure all work, and promote only the improvements that demonstrate their value without hiding regressions.
