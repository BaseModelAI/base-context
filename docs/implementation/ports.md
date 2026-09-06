# W0/W2 semantic port inventory

Status: source audit and implementation plan. No runtime files changed by this audit. No live provider calls, benchmarks, installs into the legacy checkout, or publication were run. All 1,634 lines of `base-context-harness-spec.md` were read. The unavailable code-review-graph connection required the permitted file/Git fallback.

## 1. Freeze the right controls

| Control | Exact identity and consequence |
|---|---|
| Supplied H archive | Spec ZIP commit `9c54a35dac3a2ad17910074d66664859ea175666` is **v0.9.2**, not v0.9.3. Retain the verified archive as a separate input. |
| Fork ancestor / actual H | `915c78f42c248b08238dd27fcd4bcab32c60beab`, actual v0.9.3. Three commits follow the supplied ZIP: `47f94a0e3` (Astra Codex catalog/discovery), `a062ed221` (client versions), `915c78f42` (release). This is the warranted source-identity correction for the user's requested v0.9.3. |
| S | `8fd60de83cb9b0506c7a4d1b13014e9316a151e4`; available in legacy Git and pinned under `.work/controls/S`. Exact source is no longer unavailable. Source availability is not a reproduced benchmark or an independently checked published npm artifact. |
| Supplied D handoff | `ee83ff8` / `astra-v3-pc-round04-quit`; keep distinct from the current authoritative checkout. |
| Current D | `a9ae11c7b6ccc85a74cb31f7996db81c89dd0e58`, package 9.2.0, host/dependencies/patcher target 0.9.1. Current source and current benchmark definitions are authoritative user inputs, not interchangeable with S. Legacy tracked files were untouched. |
| B0-S / B0-D | Separate native ports on actual H. Enumerate identity substitutions, 0.9.3 adaptations, and deliberate correctness changes. Off mode is not an unmodified H control. |

Before closing W0, retain pinned executable controls, lockfiles/toolchains, generated catalogs, schemas/prompts/skills, provider route/effort/tier/cache settings, pricing snapshots, fixtures/judges, and known accounting defects. Parent reports actual H `npm run check` and source/bundle compilation passed; this audit did not run them. Historical bills with missing usage remain incomplete.

### Exact S → current D difference

Only eight files differ under `src`, `scripts`, `test`, and package manifests: `scripts/package-smoke.mjs`, `scripts/patch-prime-agent.mjs`, `src/{compaction,index,policy,state}.ts`, `test/{extension,policy}.test.ts`. Neither package manifest nor lockfile differs in this comparison.

- **Continuation:** S's `session_before_compact` hook returns `undefined`. D imports and unconditionally selects `buildReferenceCompaction` when optimization/archive are active. It has no Sol/Astra policy gate. D also restores task snapshots from reference-compaction details. Never register this D hook as `generic-control`.
- **Shutdown:** D preserves automatic-refinement suppression for `session_shutdown(reason="quit")`; S resets it. Label this necessary lifecycle difference instead of calling it unchanged Sol behavior.
- **Behavior:** current D adds `Use each tool's documented timeout units and process lifetime; do not assume detached processes survive across calls.` This is the only tracked `src` difference between `ee83ff8` and current D. Keep it a distinct policy revision. Do not claim the intermediate wall-time feedback experiment is in current runtime source.
- **Host patches:** D adds Astra direct/Codex selectors, fast-mode/discovery changes, default goal backoff unless positive progress occurs, native summary usage, and refinement response usage. S already has the foundational finalized-exchange, fixed-view, projection, backoff, and skill mechanisms.
- **Verified equal defaults:** S and current D both use `minTextBytes=24576`, `capsuleMaxBytes=6144`, `readMaxBytes=65536`, `skillBudgetTokens=800`, utility-gated auxiliary/learning modes. Skills retain at most 24 pairs, select at most two, and bound a body to 350 tokens. Preserve these byte thresholds for B0 comparisons. Do not promote the shared 12-item task-truth cap as correct behavior.
- **Corpus:** `benchmarks/python-realworld-30` differs in 232 files, including all 30 `TASK.md` files and many judges/scenarios. Current definitions must not overwrite the original S denominator. Retain both populations. Re-run paired controls if crossing corpora; never reuse a score under changed judges.

`generic-control` must use frozen S prompts/skills/recovery lifetime and fork-owned native harness summaries. `generic-balanced` starts there, with separately identified integrity/index changes. `astra-balanced` gets independent continuation and instruction policies. The old reference builder is an experiment to replace, not the shared memory architecture. Missing live route evidence keeps advanced features disabled.

Latest campaign instruction: use isolated medium-effort 4–6-task samples only at earlier applicable gates. Full 30-task campaigns for both model classes belong only in final phases. This audit ran neither. Corroborated provider capacity failures invalidate runs and do not consume retries; never replace a valid slow attempt for better performance.

## 2. Patch inventory and source dispositions

The current and handoff D patcher are identical: **5,998 lines, 391 literal `name` occurrences, 32 distinct literal `applyPatches` targets**, plus dynamically selected bundles. S has 5,632 patcher lines. The count includes four embedded model display-name fields, so it is not 391 independent patches or bugs.

[`patch-dispositions.csv`](patch-dispositions.csv) accounts for all 391 occurrences. It records original line/target, S/D membership, logical capability, intended disposition, source owner, upstream evidence, required regression, risk, and accounting effect. The two computed dispatch `name` expressions at lines 5902/5967 only expand already listed shared definitions into modular/bundled targets; they introduce no new semantic labels. The repeated goal patch at line 5842 likewise applies to two targets.

**These are audited dispositions, not a claim that ports or tests passed.** `ALREADY_PRESENT_PROVEN` is limited to the source-equivalent catalog records and superseding discovery implementation, not provider support. Bundled and declaration replacements follow their semantic owner; they must become ordinary source builds, never additional patch implementations.

| ID | Logical capability | Disposition | Native implementation action |
|---|---|---|---|
| P01 | Astra catalogs and effort values | `ALREADY_PRESENT_PROVEN` | Keep actual H direct and Codex Astra records and effort mappings; pin catalog inputs. Do not reinsert duplicates. |
| P02 | Astra fast-mode eligibility | `PORT_NATIVE` | H `supportsFastMode` still excludes Astra. Port only the exact supported route predicate; separate capability/tier validation. |
| P03 | Codex discovery client version | `ALREADY_PRESENT_PROVEN` | Keep H discovery client `0.153.4`; do not downgrade to D patch value `0.153.0`. |
| P04 | Daemon resume and early hello | `PORT_NATIVE` | Port fresh resume `launchEnv` and early hello while commands stay readiness-gated. Use W1 product-fenced daemon identity. |
| P05 | Snapshot transfer ownership and timeouts | `PORT_NATIVE` | Port attach timeout at both call sites, progress-based snapshot timeout, invalidation tombstones, and encoded-buffer duplicate handling. Preserve bounded cancellation. |
| P06 | Worker heap and passivation workarounds | `REPLACE_DESIGN` | Replace 16 GiB heap inflation and `candidates=[]` eviction suppression with paging/bounded caches and safe passivation. Keep child passivation dedupe intent; do not copy blanket eviction disable. |
| P07 | Conservative child limit | `TEMPORARY_GUARD` | Keep effective one-child guard. Do not use retained object counts as final scheduler; reserve before asynchronous setup and retain H cancellation fix. |
| P08 | Finalized ordered exchange capture | `PORT_NATIVE` | Extend generic execution edge to capture original input, validated/executed input, finalized middleware result, selected execution mode, and source order. Persist before projecting. |
| P09 | Awaited turn-end transitions | `REPLACE_DESIGN` | Replace hidden listener-returned continuation messages with typed transition results. One session/execution owner persists transitions; extensions observe. |
| P10 | Finalized direct user Bash capture | `PORT_NATIVE` | Capture direct/pending/extension/cancelled/error user Bash after persistence with exact entry ID, full-output locator and truncation/exit metadata. |
| P11 | Exact message-to-entry identities | `PORT_NATIVE` | Bind raw/custom/outcome messages to immutable source IDs; remap conversion and invalidate refs on arbitrary transforms. Do not infer IDs from array position. |
| P12 | Purpose-aware shared projection and cache identity | `PORT_NATIVE` | Build one native purpose-aware compiler path: provider, budget, compaction, branch-summary, refinement. Preserve conversion/image order and projection identity. |
| P13 | Projected native compaction preparation | `PORT_NATIVE` | Select compaction cuts from projected per-entry cost but retain raw file-operation extraction and complete replay groups; adapt H current summary return types. |
| P14 | Projected branch summary groups | `PORT_NATIVE` | Project branch summaries using complete call/result groups and branch scope; keep default tree summary rather than a second extension compactor. |
| P15 | Rendered budget and context-usage anchor | `PORT_NATIVE` | Count messages + system + tools under same snapshot; preserve pure budget queries and same-epoch usage anchor. Occupancy is not billed input plus output. |
| P16 | Refinement projection, prompt overhead and ownership | `REPLACE_DESIGN` | Keep one projected review/plan snapshot; own utility-gated refinement/learning jobs and disabled prompt overhead. Replace private overrides and disposal surprises. |
| P17 | Goal watcher and continuation backoff | `REPLACE_DESIGN` | Preserve S watcher backoff separately from D positive-progress default. Move waiting/reset/interruption into job/turn owner; avoid model polling. |
| P18 | Compaction attempt usage | `REPLACE_DESIGN` | Retain H `SummarySlice`, `SummaryCallRunner`, per-slice semantic lineage and late settlement. Replace D result-only callback accounting with physical-attempt receipts. |
| P19 | Refinement attempt usage | `REPLACE_DESIGN` | Meter review/plan responses before parse/rejection through the same request owner. Keep historical refinement metadata readable without using it as new authoritative totals. |

### Important H adaptation details

- `packages/agent/src/agent-loop.ts:883` already finalizes middleware results and has `prepared.args`; its `FinalizedToolCallOutcome` does not expose executed input. `turn_end` at 344/364 only exposes the assistant/result list. Use this existing edge instead of another executor.
- H has no `model_context`, `entryRefs`, `projectionIdentity`, `emitTurnEnd`, `setAutomaticRefinementEnabled`, or `user_bash_end` contract. A renamed extension cannot supply the missing ownership.
- `compaction.ts:34,682–777` already has summary slices, call runner and aggregate usage. `agent-session.ts:7597–7663` owns semantic slice settlement and checkpoint commitment. Preserve those fixes. A late successful slice can still be billable after sibling failure; semantic-edge success is not the authoritative accounting receipt.
- `session-manager.ts:1147–1148` still retains `fileEntries` and `byId`; native `buildSessionContext` uses them. Plugin-only archive bounds do not satisfy W5. Avoid growing another full message map while implementing entry identities.
- An existing daemon timeout constant or passivation helper is not proof that the patch's affected path is fixed. Keep focused symptom fixtures before dropping each workaround.

## 3. Context modules not represented by patch labels

W2 must integrate these source mechanisms, not just the host hook names. Preserve compatibility names/IDs during control comparisons, but construct them as native services.

| Current source | Native destination and dependency |
|---|---|
| `exchange.ts`, `intent.ts` | `context/events` and execution finalization. Reuse typed part extraction, conservative classification, original/executed distinction and final-output association. No early observer may substitute a result before final middleware. |
| `archive.ts`, `envelope.ts` | `context/store`. Keep existing streaming gzip/chunk envelopes, observation/part IDs and exact locators. W3 adds durable publication; W4 replaces catalog-wide load/search/baseline reconstruction with SQLite indexes; W5 bounds decoded caches/queues. Do not duplicate every retained native message. |
| `broker.ts`, `capsule.ts`, `projection.ts` | `context/compiler`. Port fixed immutable views, exact/delta decisions, error/media preservation, short novel literal results, and opaque-block fallback. Later add source-revision cache keys, real-request budget and dependency closure. Budget-only calls stay read-only. |
| `state.ts`, `runtime.ts`, `context.ts`, `workflow.ts` | `context/state`, sparse frame compiler, job observations. Keep explicit goal/task selection and sparse stable reminders. W4 separates display bounds from durable truth, fixes case-folding equality, preserves authority and resource generations. Model plans are not user requirements. |
| `tool.ts`, `commands.ts` | Native recovery tool and CLI adapters. Preserve `prime_context` actions/IDs and bounded response behavior; add authorized batched recovery/index scope later. Do not copy host-version checks or expose duplicate renamed tools. |
| `skills.ts` | Native policy/skill service. Preserve bounded, selected, epoch-frozen skills; move `.prime/agent` roots via W1 paths. Existing loader/frontmatter APIs must resolve to fork source. |
| `auxiliary.ts`, `learn.ts` | Owned auxiliary job service + common request coordinator. These make direct completion calls today. Keep utility gates and independent model settings; all requests need purpose, budget, cancellation, effort contract and receipt. No automatic new ranker/scout/learning step. |
| `compaction.ts` | D-only reference checkpoint experiment. Do not copy as generic default. Replace growing prose/ID enumeration, asserted live kernel, incomplete literal coverage and omitted opaque state with W8 bounded atomic continuation. |
| `index.ts` | Split its actual lifecycle responsibilities among the above owners and one session integration point. Do not copy the 2,000+-line extension entry point as the new native runtime. |
| `prime-agent-0.9.1.d.ts` | Delete ambient patched-host ABI in the fork. Define real owned source interfaces and generated exports. Legacy checkout retains it unchanged. |

Order at the integration seam: **execute/finalize → commit exact source → indexed coverage → immutable view selection → render/count same snapshot → metered attempt → owned continuation commit**. Storage failure retains literal material where valid, or pauses; it must not publish a pretty dangling reference.

## 4. Ownership split for follow-up implementation

| Worker / accountable role | Exclusive file ownership | Contract / merge dependency |
|---|---|---|
| Product/release owner (W1) | Product identity/path modules, package/release/bootstrap/config and installer/updater files | Source-only dependencies, isolated runtime/state/auth/telemetry, pinned catalogs. Coordinate daemon identity fields with execution owner. No context-policy changes. |
| Generic execution-edge worker (W2 P08/P09) | `packages/agent/src/{agent-loop,agent,types}.ts` and their tests | Typed finalized exchange + turn transition service contract. No coding-agent imports or storage implementation. Send types first. |
| **Session integrator** (single writer) | `core/agent-session.ts`, `core/sdk.ts`, `core/messages.ts`, public exports and extension adapter seams | Wires all service contracts once across interactive/headless/RPC/daemon. Owns merge responsibility for giant session file; other workers send focused required changes rather than edit it concurrently. |
| Evidence/state worker (W3–W5) | `context/{events,store,state}`, event log, session-manager history interfaces and tests | Canonical source sequence, durable publication, source IDs, pages, resource/authority state. Agree append/read contracts before compiler changes. |
| Compiler/recovery worker (W2 P11/P12/P15; W6) | `context/{compiler,recovery}`, native recovery tool and tests | Consume immutable bounded history/source refs. Preserve S fixed views/thresholds; no provider/SQLite ownership or new inference. Coordinate `messages.ts` changes through integrator. |
| Continuation/accounting worker (W2 P13/P14/P16/P18/P19; W3/W8) | `core/compaction/*`, owned continuation/refinement/job modules and context telemetry | Preserve H slice lineage; one request owner and checkpoint owner; provide session integration patch to integrator. Native, portable, summary modes share commit ownership. |
| Provider/capability worker (W2 P01–P03; W9) | `packages/ai` adapters/catalog/count/usage contracts, model-registry capability seam | Keep wire identifiers; unknown advanced options off; all direct completion/stream paths enter common receipt boundary. Independent of behavioral profile. Coordinate catalog build isolation with release owner. |
| Daemon/scheduler worker (W2 P04–P07/P17; W10) | `modes/daemon`, `modes/agent-connection`, execution reservations/jobs and generation services | Safe ready/resume/attach/passivation first; keep one-child guard until atomic multi-process budgets. Send child-session edits to session integrator. |
| Policy/evaluation owner (W0/W7/W12) | Separate generic/Astra profile data, frozen control manifests, corrected runner and reports | S versus D source/corpus diff; preserve S summary policy and recovery lifetime. Do not alter task/judge definitions to improve results. No early full campaign. |

Do not start all workers on the same source owner. W0 → W1 → W2 establishes coherent construction; W3 durable effects/receipts precede destructive storage/compiler changes. W10 can run beside W4–W6 after common ownership contracts exist. Migration depends on W1/W3/W4/W8. W13 maintenance roles start now, not after publication.

## 5. Minimal next acceptance work

1. Port native execution finalization and source refs with a scripted fake-provider/tool exchange: normalized input, middleware-rewritten final result, parallel source order; include failed/cancelled edge. Reuse `packages/agent/test/agent-loop.test.ts` and legacy finalized-exchange fixtures.
2. Port shared compiler and summary preparation using legacy `extension.test.ts` fixed-view/budget/recovery fixtures plus H `compaction.test.ts`, `context-tree.test.ts`, and `suite/agent-session-compaction.test.ts`. Assert literal/provider golden differences explicitly; do not normalize arbitrary text to force equality.
3. Preserve H `agent-session-semantic-edges.test.ts` late-slice/cancellation cases. Add actual physical-attempt receipt assertions when W3 lands; aggregate assistant totals cannot close that gate.
4. Adapt legacy `package-smoke.mjs` semantic fixtures into source/built-artifact checks. Drop text-replacement/idempotent-patcher assertions from the new product, while preserving them in the frozen controls. Ensure CLI bundle, declarations, SDK and daemon come from one source graph with no installed-output surgery.
5. Keep tests marked **existing**, **ported**, **not yet implemented**, or **executed**. This report and CSV are not executed-test evidence. Full spec P/C/X/R/F gates, fault/scale coverage and final provider/benchmark validation remain required for their respective phases.

Raw read-only comparisons are in `.work/port-audit/`. No legacy patcher was executed, even in check mode. No newly named product should load the old Prime Context extension; otherwise projection, continuation and learning suppression run twice.
