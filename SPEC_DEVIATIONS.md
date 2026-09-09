# SPEC_DEVIATIONS

## Scope and executive summary

**Contract:** `base-context-harness-spec.md`, all 1,634 lines. **Implementation snapshot:** `cefb478fcd2ec43ac0290b281afa16bcb5070f39` (W26). All implementation line anchors below refer to that immutable snapshot, not the changing worktree. This is a source-and-existing-evidence audit. It did not run tests, builds, imports, installers, providers, model discovery, credential probes, or benchmarks. The code-review graph was unavailable; targeted immutable Git source inspection was used instead. This document is the only audit file written.

**Conclusion:** the snapshot is a substantial native source fork, but it is not the completed harness or a certified release. Native request/effect ownership, checked canonical journal storage, indexed history, scoped task authority, and several bounded readers are real. W26 also ships **actual native TaskFrame converter injection, stable sparse frame revisions, and ViewUnit/dependency metadata**. These are not merely external drafts. However, real provider-budgeted selection, complete committed epochs, and native selective recovery are unfinished. The ViewUnit closure helper is not yet the provider selection path.

There are also source-confirmed deviations, not just missing test evidence: unchecked active recovery writes; absent effective one-child admission and tree-wide scheduling; unbounded saved-catalog and skill paths; automatic inference that can start during disposal; the unconditional Python-survival prompt; incomplete optimizer-off ownership; unsafe unknown-replay/default capability handling; upstream install/support instructions; updater activation gaps; and an advertised public export with no source implementation. Keep these distinct from unrun provider, platform, release, and performance gates.

The map below accounts for every numbered normative subsection, W0–W13, the final directive, and **all 100 acceptance IDs**: P01–P14, C01–C18, X01–X14, R01–R14, and F01–F40. Coverage of a requirement is not satisfaction of it. No compliance percentage or new memory/performance threshold is supported.

### Status and priority keys

- **O — implemented + observed:** only the named component and executed evidence scope. Historical observations do not certify the entire W26 product.
- **U — implementation-only / unverified:** source exists; the required execution or artifact evidence is absent.
- **P — partial:** some required behavior exists; implementation or acceptance remains incomplete.
- **M — missing:** the required product contract/path or its complete acceptance is absent. A narrower primitive is credited where present.
- **D — actual deviation:** inspected source conflicts with a requirement. This does not assert an observed production incident.
- **A — approved user override:** intentional and authorized; not a gap.

Mixed labels preserve component credit without declaring a whole requirement passed. **P0** means an immediate prerequisite or safety blocker for the affected operation. **P1** means a high-priority implementation/release gap. **P2** means a bounded follow-up. These are work priorities, not measured risk scores.

### Binding user overrides

1. Exact Sol `gpt-5.6-sol` and Astra `gpt-6-astra` use the **SAME existing host OpenAI subscription**. **API keys are NOT a blocker.** Existing-login reuse is instance-scoped authorization, not global OAuth-client validation.
2. **NO live benchmarks, including early samples, until TaskFrame injection, ViewUnit dependency closure, model-aware token budgets, stable epochs and selective recovery are finished.** W26's injection and helper work does not close the remaining gate.
3. Preserve a stable KV prefix and place the most-changing material at the tail. Do not rewrite earlier views on every turn.
4. H0.9.3 is approved. Keep actual H, supplied historical H, S, and D identities separate.
5. Publication still requires approval.
6. A confirmed provider capacity invalidation does not consume a valid failure retry. Retain invalidated attempts; do not judge them as model failures.

Subscription implementations must retain the exact Codex provider/API/official endpoint, read-only instance permission, and no refresh, credential copying, shared writes, token environment/argv, token-as-key aliases, or proxy `StreamFn`. This audit did not open credentials. Entitlement, freshness, and live capacity remain unknown by design.

### Source abbreviations

`CORE/` = `packages/coding-agent/src/core/`; `CA/` = `packages/coding-agent/src/`; `DM/` = `packages/coding-agent/src/modes/daemon/`; `AI/` = `packages/ai/src/`; `AG/` = `packages/agent/src/`; `PY/` = `prime-agent-runtime/src/rlm/`; `TEST/` = `packages/coding-agent/test/`; `IMP/` = `docs/implementation/`; `BENCH/` = `benchmarks/python-realworld-30/`. Evidence IDs E01–E15 are defined near the end. Finding IDs G01–G20 provide shared source anchors for the coverage tables.

## Prioritized deviations and bounded TODOs

| ID / priority | Status and gap | Snapshot evidence and qualification | Bounded next action |
|---|---|---|---|
| **G01 / P0** | **D:** active recovery durability is not fixed globally. | `DM/command-recovery-journal.ts:174–180,201–208`, `DM/worker-recovery-journal.ts:95–112`, `CORE/orphan-process-journal.ts:34–47` ignore write counts or omit compaction persistence. Recovery loaders skip malformed middle rows (`command:128–171`, `worker:24–55`). Actual callers: supervisor `804,1888–1919,4083–4086`, daemon-mode `617–618`. Checked canonical owner and E01–E02 remain credited. | Reuse existing checked/framed owner behavior on these active writes. Fail explicitly on no progress/corruption and retain unknown outcomes; do not add another journal framework. |
| **G02 / P0** | **D/M:** no effective conservative one-child guard or independent tree-wide capacity scheduler. | `CORE/agent-session.ts:9986–9990,11225–11374,11658–11663` checks depth/name, awaits resolution before tracking; inline `10294–10339`; runtime `334–388`; `DM/daemon-mode.ts:2612–2626,2702–2769`. `runtimeOpenGuard:2711` checks cancellation, not quota. Durable spawn ACK and environment scope are not reservations. | Enforce the one-child admission default on actual native paths until owned scheduling is ready. Add pre-await tree reservations and separate inference/resident/kernel/job/queue/result budgets, with idempotent settlement and parent-wait slot release. Preserve baseline semantics; do not silently delete delegation. |
| **G03 / P0** | **D/P/M:** source caps and ViewUnit helpers are not model-aware provider selection. | `CORE/canonical-context.ts:23–27,82–163,208–224,293–359` has real injection and source admission; `view-units.ts:49–67,75–138` has closure metadata/helper, null token estimates, no provider selector caller. `compaction/compaction.ts:182–278` uses chars/4 and fixed media heuristics; the user-image branch counts text only. E09 observes seven distinct scoped W26 cases. | Use one captured adapter/template snapshot for actual serialized input, tools, media, retained state and output reservations. Connect mandatory-first budgeted selection to certified dependency closure and whole-group fallback/refusal. Preserve shipped stable frame slots. |
| **G04 / P0** | **M/P:** complete committed epochs, portable/native checkpoints, and native selective recovery are absent. | `CORE/agent-session.ts:8110–8124,8209–8230` and `session-manager.ts:2602–2625` append ordinary summaries without expected-epoch CAS. `CORE/tools/index.ts:47–56` exposes ipython, not native `prime_context`; history index reads are internal substrate. `canonical-context.ts:141–148` is a summary frame reset, not recovered-view epoch ownership. | Finish one source-backed epoch/continuation owner, atomic candidate validation/publication and late-event handling. Add the stable bounded batch recovery API, explicit coverage outcomes, and retained recovered views within an epoch. Reuse existing indexes/readers; no second truth store. |
| **G05 / P1** | **M/P/D:** unresolved profiles/capabilities/replay families; unsafe unknown-item and unknown-route defaults. | `CORE/inference-coordinator.ts:70–87` emits `native-default/unvalidated`; request-events `22–40` disclaims a full input contract. `AI/providers/openai-responses-shared.ts:165–210,332–355` handles known types only; transform-messages `85–108,154–170` applies lossy/incomplete-history transformations without the specified resolved replay contract. Responses `46–57,228–239` defaults optional long-retention support on unknown custom routes. | Resolve policy separately from provider/API/auth/endpoint/template/replay identity. Preserve required unknown canonical items or refuse/fallback safely. Keep unsupported advanced fields off. Add explicit generic-control/generic-balanced/Astra profiles and compatible model-switch/public fallback. No live malformed request or private-reasoning disclosure is claimed. |
| **G06 / P1** | **D/M:** false kernel-survival assertion and incomplete resource freshness. | `CORE/compaction/compaction.ts:459–460,510` unconditionally promises variables/imports/helpers survive. Later `agent-session.ts:7912–7939` checks a running kernel, but no authoritative live/restored/restarted/absent/unknown generation view is provided. Task resource fields lack full generation/test/artifact freshness (`task-state.ts:87–113`). | Remove the promise and derive runtime/freshness facts from authoritative generations, including Bash-only and unknown state. Keep the W26 finding; the later prompt-only fix is listed separately below. |
| **G07 / P1** | **D/M/P:** disposal can start new automatic inference; true off mode and independent auxiliary configuration are missing. | `CORE/agent-session.ts:4388–4398` drains before `_disposing=true`; `4424–4431` drains existing work, but `4498–4513,4520–4543` can start new due refinement. Conditions include persisted root, enabled policy, interval and cooldown. Settings `946–959` default it on. Reviewer/planner inherit main model/effort (`8708–8729,8923–8939`). No `context.mode` contract at settings `131–180,869–879`. | Stop new automatic inference during disposal; settle already-owned work under an explicit bounded policy. Add a valid-boundary optimizer switch and separate auxiliary model/effort/budgets. Keep logging, receipts, permissions, cancellation, limits and public recovery on. |
| **G08 / P1** | **D/P:** aggregate hot memory is not bounded by the implemented component limits. | Native Manager clears full maps (`CORE/session-manager.ts:1628–1638`), but saved catalogs fully list/scan: `DM/daemon-catalog-process.ts:138–175,441–475`, saved-session-catalog `21–44`, Manager `1029–1135,1182–1213`. Unchanged size/mtime avoids scans; changed/uncached native **and** legacy journals still scan to EOF and accumulate maps/arrays. Journal reader has a per-frame, not total-file, cap. `PY/bash.py:48` live handles and aggregate/transient caches are outside the narrow caps. E04–E07 are not whole-harness memory proof. | Page saved catalogs from indexed summary deltas; cap aggregate cache/admission/pending/job buffers. Retain applied Manager, W21 state and W23 tree bounds. Later assess the complete process tree at the authorized scope; do not invent an RSS threshold. |
| **G09 / P1** | **D/P:** skill catalogs/bodies and selected versions are not bounded/frozen as required. | `CORE/skills.ts:443–473` adds every visible description/location; per-name/description limits are not a catalog budget. `system-prompt.ts:66–72,87–92,169–172` wires it. `agent-session.ts:5637–5652` reads full selected SKILL.md without a total body cap/version pin. Harness overview bounds do not fix external skills. | Bound selected catalog/body bytes/items and freeze selected versions within implemented epochs. Keep instructions attributed and optional exact recovery available. Do not infer malicious-history learning safety from persistence fixtures. |
| **G10 / P1** | **P/M:** archive publication, scoped retention/GC and unresolved-effect recovery are incomplete. | Source-before-index and bounded exact parts are real (`CORE/session-manager.ts:2100–2143,2393–2479`; history-index-worker `447–579,823–845,1519–1572`). Per-session deletion (`session-file-actions.ts:54–76`) is not root-tracing GC/tombstones. `AG/agent-loop.ts:1012–1087,1148–1176` records intent/results and cancellation unknowns; supervisor `4082–4164` holds uncertain work, but Manager `3391–3408` has no complete per-tool unresolved-intent reconciliation. | Complete publication/retention relationships using the same committed source IDs. Expose unresolved effects as unknown, reconcile only via real status/idempotency, and add explicit scope/deletion/availability outcomes before public recovery. |
| **G11 / P1** | **D/P/M:** shared workspace/job/result ownership and explicit turn outcomes are unfinished. | Child inputs are concise but lack complete scoped evidence/result manifests (`CORE/agent-session.ts:11465–11515`). Runtime `340–359` and daemon-mode `2623–2638` share CWD; file-mutation-queue `4–38` covers same-process native edits only. Bash handles and child status dedup are not one job registry. `AG/agent-loop.ts:538–557` still continues based on nonempty continuation messages. | Isolate or centrally serialize conflicting cross-process/Bash/Python writes. Join existing job identities/status/wakeup ownership, commit attributed child results before publication, and use explicit continue/wait/checkpoint/finish outcomes. Preserve existing cancellation/passivation fixes. |
| **G12 / P1** | **M/P:** no complete product migration and rollback workflow. | `CA/cli/public-command.ts:101–141` has no migrate command. `CA/migrations.ts:21–73,247–256` updates owned startup settings/auth, not legacy roots. `CORE/session-manager.ts:3826–3920` supplies bounded retained-journal copy; future-version and legacy-writer guards exist (`3741–3742,3786–3787,1966–1975`). No full entity/reference mapping, paused authority, trusted restore or dual-plugin pre-load fence is implemented. | Build the explicit non-destructive staged import on the retained-copy primitive: dry-run/live-source refusal or stable export, exact reference/coverage mapping, paused schedules/jobs/outboxes, opt-in credentials/trusted snapshots, compatible read/export and rollback. Refuse legacy dual context registration before execution. |
| **G13 / P1** | **D/P:** user-facing installation/support identity is still upstream; doctor/docs are stale. | `README.md:56–68,79–85` directs upstream installer/commands. `SECURITY.md:7,25`, `CONTRIBUTING.md:1–13` route ownership/support upstream. `CA/cli/product-doctor.ts:46` says native context is not implemented; `IMP/product-isolation.md:13–15` says protocol9 while actual daemon protocol is11 (`DM/daemon-protocol.ts:57–60`). Native identity/runtime paths themselves are isolated. | Replace harmful install/control/security/support guidance with approved owned routes or explicit unavailable instructions. Update existing doctor/contract metadata. Preserve legal upstream attribution and real provider wire identities. |
| **G14 / P1** | **D/P:** update validation, activation/rollback and public build surfaces are incomplete. | `CA/utils/version-check.ts:102–157` accepts arbitrary absolute artifact URLs/default redirects and only optional product metadata; no complete integrity/platform/schema check. Package-manager-cli `441–456` can continue owned-package installation after lookup failure; config `155–200` installs in place. No upstream namespace fallback is claimed. Coding-agent package `16–19` advertises `./hooks`, but snapshot has no `src/core/hooks/` source or generator. | Require the configured origin/product/compatibility contract before activation and retain the installed pair on lookup failure. Stage/rollback binary and runtime together. Remove the obsolete hooks export/alias or supply its intended source; later exercise exact installed imports. Installer download checks are not updater certification. |
| **G15 / P1** | **P/U/M:** current release/artifact/platform evidence is insufficient. | Owned packages/build/catalog split and notice staging exist. Build-base-context `16–32` records commit/dirty; packer `324–332` lacks complete runtime/storage/platform/toolchain contract. GitHub workflow `build-binaries.yml:123–190,229–238` has a staged path, but npm publish/release scripts rebuild. E10 is W25 four-package packing, not extraction/installed bootstrap. Windows/network filesystem gates are unrun. | Use an exact tested release stage with pinned inputs and actual public-surface/runtime/license/compatibility evidence. Fix the npm post-test rebuild path. Declare unsupported/unverified platforms honestly; publication remains separately approval-gated. |
| **G16 / P1** | **P/M:** native Sol preservation, a pinned generic deployment, and advanced Astra contracts are not certified. | Frozen controls/ports are documented; coordinator has only native-default. Ordinary known opaque replay, effort, Codex transport continuation and local parallel tools exist; they are not native compaction, async, steering, PTC or mid-turn effort protocols. No exact Sol/Astra or pinned Qwen deployment campaign exists. E11 is offline external setup only. | Finish the common five-feature prerequisites and explicit frozen generic-control first. Keep each advanced capability disabled/unpromoted until exact route/profile combinations and compatible fallback exist. Later run only authorized, separately attributed comparisons/ablations. |
| **G17 / P1** | **P/D:** receipt coverage/metadata and native runner capacity authority are incomplete. | Native request/attempt owners and receipt-only parser are real (`CORE/inference-coordinator.ts:301–408`; `AI/utils/provider-attempts.ts:63–87,121–167,233–267`; `BENCH/benchlib.py:552–574`). Legacy assistant usage is observational. But `BENCH/run.py:75–88,880` can invalidate a native run from an RPC-only capacity marker. Receipt input/profile/epoch/commit/effort metadata remains incomplete (`request-events.ts:22–66`). | Preserve physical attempt authority and every attempt's known/unknown work. Align native runner invalidation with native receipt authority; retain RPC markers as observations rather than silently widening authority. Complete required metadata/commit associations without a second accounting store. |
| **G18 / P1/P2** | **P/M:** final experimental populations, statistics, tariffs and ablations are not complete. | First capacity-valid primary and retained retry policy exist (`BENCH/run.py:982–1017`). Fixed ordered waves/concurrent arms (`1559–1567`) are not randomized repeated blocks. Catalog cost is explicitly an estimate (`benchlib.py:392–440`), not a bill. There is no authorized final campaign or per-model promotion report. | Keep the first valid primary immutable, one optional failure diagnostic, and capacity-invalidated attempts outside valid retries. Pin route/tariff/population/cache/timing conditions and expose unknowns. Implement the specified analysis only after the user gate; no early samples or winner selection. |
| **G19 / P1/P2** | **P/M:** maintained-fork operations and truthful disposition/support claims are incomplete. | `IMP/patch-dispositions.csv:1–392` covers391 occurrences but all rows remain `AUDITED_SOURCE_NOT_IMPLEMENTED`; source ports now exist. `IMP/ports.md` records ancestry, not a reviewed-through intake/sample backport or owned support matrix. Upstream support routing remains in root docs. | Update the existing dispositions with actual owner/evidence status. Name approved support/security/subsystem responsibilities and support scope. Record a bounded selective backport with dependency closure and relevant evidence when undertaken; do not invent owners, cadence, or new review machinery. |
| **G20 / P1/P2** | **O/P/M:** exact descriptive task state is improved, but broad facts and full acceptance remain incomplete. | `CORE/task-state.ts:284–320,370–444`, reducer `53–119`, reader `20–79` retain qualified exact authority, proposals and explicit ambiguity; E08/E09 exercise these pieces. The frame is a selective rendering, not a last-N truth store. Runtime artifact/test/job/resource-generation producers and 1,000 admitted constraints with real recovery are not established. | Preserve exact equality/supersession and source authority through the completed epoch/recovery path. Project only existing authoritative runtime facts with revisions. Show relevant stale/unfinished obligations without mandatory plans, proof packets, or routine model save/pin/ack work. |

## Complete normative subsection map

Each parent chapter is covered by all of its listed subsections. Chapter25 and the final directive have no numbered subsections and are covered explicitly after the table. References to G findings include the bounded action above.

| Spec subsection / line | Status | Finding and limit | Source / evidence |
|---|---|---|---|
| **1.1 Binding decision** (L16) | U/A | Owned maintained-fork source replaces product patch surgery; H0.9.3 is approved. Independent installation and complete semantic ports remain open. | G15,G19; E09–E11 |
| **1.2 Why a fork is warranted here** (L26) | P | Native ownership is warranted and real; finished bounded-harness, maintained-product and task efficiency goals are not established. | G03–G04,G08,G19 |
| **1.3 Alternatives and rejection criteria** (L34) | U/A | Owned maintained-fork source replaces product patch surgery; H0.9.3 is approved. Independent installation and complete semantic ports remain open. | G15,G19; E09–E11 |
| **1.4 What success means** (L46) | P | Native ownership is warranted and real; finished bounded-harness, maintained-product and task efficiency goals are not established. | G03–G04,G08,G19 |
| **2.1 Freeze these distinct baselines** (L56) | P/A | Separate H/S/D freezes and ancestry corrections exist; executable-control/provider/pricing certification is not setup metadata. Historical source-availability claims are superseded only to the supported scope. | IMP/baselines.json:5–46,334–345; IMP/ports.md:8–26; E11 |
| **2.2 What this revision actually verified** (L77) | P/A | Separate H/S/D freezes and ancestry corrections exist; executable-control/provider/pricing certification is not setup metadata. Historical source-availability claims are superseded only to the supported scope. | IMP/baselines.json:5–46,334–345; IMP/ports.md:8–26; E11 |
| **2.3 New fork-specific findings** (L85) | P | 391 occurrences have source dispositions, not391 defects or completed ports. Preserve inherited, source-only, historical and newly observed evidence classes. | G19; IMP/patch-dispositions.csv:1–392 |
| **2.4 How to classify inherited issues** (L96) | P | 391 occurrences have source dispositions, not391 defects or completed ports. Preserve inherited, source-only, historical and newly observed evidence classes. | G19; IMP/patch-dispositions.csv:1–392 |
| **3.1 Keep the useful monorepo boundaries** (L106) | U/D | Four-package owned graph and extension aliases are real; the advertised hooks surface is dangling. Proposed directory names are not separate required abstractions. | G14–G15; packages/agent/package.json:19–21; CORE/extensions/bundled-modules.ts:11–38 |
| **3.2 Ownership matrix** (L136) | P | Actual native compiler/exchange/request services are wired, not merely optional extension inventory. Full model/epoch/recovery and typed continuation/execution ownership remains incomplete. | G03–G05,G11,G17; CORE/agent-session.ts:1309–1352,1405–1412 |
| **3.3 One native runtime, multiple optional extensions** (L151) | P | Actual native compiler/exchange/request services are wired, not merely optional extension inventory. Full model/epoch/recovery and typed continuation/execution ownership remains incomplete. | G03–G05,G11,G17; CORE/agent-session.ts:1309–1352,1405–1412 |
| **3.4 Native service contracts** (L159) | P | Actual native compiler/exchange/request services are wired, not merely optional extension inventory. Full model/epoch/recovery and typed continuation/execution ownership remains incomplete. | G03–G05,G11,G17; CORE/agent-session.ts:1309–1352,1405–1412 |
| **4.1 Required identity matrix** (L188) | P/D | Native identity/state/environment/doctor dispatch exists; upstream user instructions and stale doctor/protocol descriptions violate the identity contract. | G13; CA/product-identity.ts:13–33; runtime-paths.ts:21–89 |
| **4.2 Daemon and process isolation** (L210) | P/U | Product/home/install-scoped daemon identities and foreign-product rejection exist. Earlier protocol8 coexistence does not certify current protocol11 or Windows. | DM/daemon-client.ts:473–481; daemon-socket.ts:286–309; daemon-supervisor-ownership.ts:39–51,200–221,436–453,614–626; E12 |
| **4.3 Authentication, endpoints, and telemetry** (L218) | O/P/A | Dummy offline tests establish scoped read-only subscription behavior, not entitlement. Dedicated trace/telemetry credentials and opt-in endpoints exist; full startup/import/shutdown egress evidence is absent. | E13; CORE/auth-storage.ts:283–311,923–946; provider-contracts.ts:10–55; agent-traces.ts:838–856,909–921,1149–1151; telemetry.ts:326–335,414–424 |
| **4.4 Licensing and distribution** (L226) | P | Source notices and staging are real; old four-tarball listings are not complete current binary/runtime/wheel/source-archive/SBOM certification or namespace/auth rights. | G15; LICENSE:3–15; NOTICE:1–12; E10 |
| **5.1 Build a disposition ledger before porting** (L234) | P | Disposition coverage exists, but all rows retain planning status despite actual ports. Close logical capabilities against real ownership/evidence. | G19 |
| **5.2 Initial source-port map** (L242) | P | Finalized original/executed capture, exact refs, TaskFrame and ViewUnit ports are real; full S fixed-view/recovery/utility behavior is not yet preserved natively. | G03–G04,G16,G20; AG/agent-loop.ts:1148–1177 |
| **5.3 Mandatory common request boundary** (L263) | P | Native main/child/summary/refinement/branch requests use the owned coordinator. Full receipt fields, committed-output associations and actual-purpose coverage remain incomplete. | G17; CORE/agent-session.ts:1405–1412,8034,8715,8939,9389,12448 |
| **5.4 Explicit turn transitions** (L271) | P/D | Await/cancellation exists, but nonempty continuation-message arrays still drive looping instead of the specified typed turn outcome. | G11; CORE/agent-session.ts:3747–3783 |
| **6.1 One canonical history, derived indexes** (L281) | P | Native history is canonical and task/evidence/receipt refs derive from it; complete archive/epoch/job/retention relationships remain open. | G10,G17,G20; E01–E04 |
| **6.2 Fix the short-write assumption** (L289) | O/D | Checked/framed canonical owner is observed; active recovery/orphan writes and middle-corruption handling still deviate. Windows directory fsync is explicitly a no-op, not certified durability. | G01; CORE/journal-io.ts:8–44; journal-frame.ts:37–106; E01–E02 |
| **6.3 Publication protocol** (L299) | P | Source ACK precedes native publication and derived index coverage; full projected-reference/blob/checkpoint activation and rollback are not complete. | G10; CORE/session-history-index.ts:276–322; E02–E04 |
| **6.4 Tool effects and crash ambiguity** (L315) | P | Intent-before-effect, cancellation unknowns and supervisor no-replay holds exist. Complete per-effect restart reconciliation and durable recovery writes remain open. | G01,G10; E02,E04,E12 |
| **6.5 Bounded history is native, not cosmetic** (L321) | O/P/D | Activated Manager/indexed context owners and refusal bounds exist; saved catalogs still scan native and legacy histories and retain uncapped scalar reductions/queues. | G08; E04–E07 |
| **7.1 A source fork must actually use its own source** (L329) | P/D | Owned modules/runtime payload and no upstream runtime fallback are implemented; public hooks export is absent and current installed-surface evidence is missing. | G14–G15; CORE/kernel/bootstrap.ts:54,623–641,671–694 |
| **7.2 Reproducible catalog and build process** (L337) | P | Catalog refresh is separated from pinned normal builds. Full release inputs and exact tested npm publication are incomplete; a separate staged binary workflow does exist. | G15; packages/ai/package.json:67–69; AI/models.generated.ts:1–6 |
| **7.3 Independent releases and updates** (L345) | D/P | Owned namespace alone does not validate artifact origin/redirect/identity/schema or supply fail-stay activation and paired rollback. | G14–G15 |
| **7.4 Selective upstream intake** (L353) | M/D | Ancestry notes are not maintained-fork intake, sample backport, owned roles or support policy. Security/contribution routing still points upstream. | G13,G19 |
| **7.5 Support ownership and scope control** (L363) | M/D | Ancestry notes are not maintained-fork intake, sample backport, owned roles or support policy. Security/contribution routing still points upstream. | G13,G19 |
| **8.1 Explicit, non-destructive import** (L371) | P/M | Bounded retained-journal copy exists; no product dry-run/stable-live-source/staged entity import command. Startup migrations are owned-root settings work only. | G12 |
| **8.2 Data and reference compatibility** (L385) | P | Retained entry/parent handling is narrower than complete archive/attachment/task/artifact reference mapping, tombstones, coverage and compatible replay. | G12; CORE/session-manager.ts:3855–3919 |
| **8.3 Do not import execution authority implicitly** (L393) | M/P | No complete paused-import authority/trusted-resume workflow or explicit pre-load legacy context blocker. This is not an observed plugin double execution. | G12; CORE/extensions/loader.ts:329–355,381+ |
| **8.4 Credentials and rollback** (L401) | P | Scoped auth, future-session refusal and legacy-writer safeguards exist; binary/schema/provider-lineage rollback and credential import are incomplete. | G12; E13 |
| **8.5 Security boundaries across memory and execution** (L407) | P | Source-qualified task authority and runtime path fences exist; full recovery/child grants and cross-tenant cache/access validation do not follow from them. | G10,G12,G20; CA/runtime-paths.ts:50–65 |
| **9.1 What must survive the migration** (L417) | P | Useful native capture/state/views are ported; frozen S recovery lifetime/fixed-view/skill policy equivalence remains incomplete. | G03–G04,G09,G16; IMP/ports.md:20–29 |
| **9.2 Existing context defects remain in scope** (L425) | P/D | All twelve inherited findings remain individually classified below; they are not twelve newly executed full-system failures. | Inherited D01–D12 map below |
| **9.3 Separate correctness, migration, and optimization** (L444) | P/A | S/D differences are recorded, but no full resolved policy comparison exists. Deferring benchmarks under the user gate is correct, not missing permission to use the subscription. | G16–G18; IMP/ports.md:20–29 |
| **10.1 Information planes** (L452) | P | Evidence, descriptive state, request-local views and provider state exist as narrower planes; committed epochs/versioned continuation ownership remain incomplete. | G04,G10,G20 |
| **10.2 Non-negotiable invariants** (L465) | P/D | Native source/effect authority is real; whole invariants fail on budgeting, lifecycle, replay, concurrency and remaining unbounded paths. | G01–G11 |
| **10.3 Native service boundaries** (L485) | P | Captured source/branch frontiers exist, not one immutable epoch/task/resource/profile/template/policy/tool/render contract shared with the provider budget. | G03–G05,G17; CORE/request-events.ts:5–40 |
| **11.1 Resolve behavior and protocol independently** (L495) | M/P | Metadata lacks a resolved policy/protocol tuple, tri-state support and feature-combination/replay/template predicates. Unknown advanced features must stay disabled. | G05,G16 |
| **11.2 Capability representation** (L508) | M/P | Metadata lacks a resolved policy/protocol tuple, tri-state support and feature-combination/replay/template predicates. Unknown advanced features must stay disabled. | G05,G16 |
| **11.3 Current capability facts that affect the split** (L547) | U/P | Known Responses/Codex opaque replay, transport state and cache options exist. Public Responses is not Codex, nor certification of required targets or Astra advanced features. | G05,G16; AI/providers/openai-codex-responses.ts:1135–1217 |
| **11.4 Profile defaults and configuration migration** (L562) | M/P | Explicit generic-control/generic-balanced/Astra profile revisions, configuration migration and typed compatible switching are absent. | G05,G16; CORE/agent-session.ts:7667–7695 |
| **12.1 Evolve the archive, do not discard it** (L576) | O/P | Exact raw source locators include short/user/tool/argument events and bounded parts. Complete typed public recovery/migrated envelopes/privacy/retention mappings remain incomplete. | G10,G12; E03–E04 |
| **12.2 Index and schema** (L584) | P | Real derived SQLite/WAL worker, scoped lexical candidates and exact part reads exist. Full job/epoch/subject/resource semantic relationships and current packaged platform contracts remain incomplete. | CORE/history-index-worker.ts:42–141,715–845,1519–1572; G10,G15; E02–E03 |
| **12.3 Atomic publication and recovery** (L606) | P | Verified source coverage and partial-index refusal exist; complete projected/checkpoint publication fault/rollback boundary remains open. | G10; E02–E04 |
| **12.4 Bounded hot paths** (L625) | O/P/D | Applied W21 state/W23 request-tree and native index/Manager bounds are real. Catalog, aggregate admission and transient/whole-process coverage remain incomplete. | G08; CORE/context-tree.ts:40–103; E05–E07 |
| **12.5 Retention, branching, and security** (L633) | P/M | Branch filtering/source authority exists; cross-project/child grant and root-tracing retention/deletion-tombstone contracts are incomplete. | G10,G12; CORE/history-index-worker.ts:722–750,765–845,1519–1572 |
| **13.1 Replace bounded truth with a bounded rendering** (L643) | O/P | Exact source-backed truth is separate from bounded rendering; complete branch reads refuse rather than silently delete. Full1000-constraint native recovery acceptance is absent. | G20; E08–E09 |
| **13.2 State authority** (L651) | O/P | Input/goal authority and proposal restrictions are real. Defined kinds alone do not wire artifact/test/job/resource-generation facts. | G20; CORE/task-state.ts:8–20,284–320,370–444 |
| **13.3 Minimal task frame** (L670) | O/P | W26 actually injects selective TaskFrames through native conversion and preserves sparse revision slots. Byte limits are not full provider selection/epoch/recovery budgets. | G03,G20; CORE/messages.ts:500–514; E09 |
| **13.4 Resource freshness and lifecycle** (L688) | D/M | Unconditional summary liveness conflicts with generation-aware resource reality; broad stale test/artifact/job facts remain unwired. | G06 |
| **13.5 Completion without a proof bureaucracy** (L696) | P | Descriptive authority avoids mandatory model plans; freshness-aware relevant completion reminders are incomplete. No new proof/checklist bureaucracy is required. | G20; CORE/task-frame.ts:114–115 |
| **14.1 One compiler, multiple rendering policies** (L704) | O/P | Real source-backed ViewUnit metadata and helper closure exist; full context is retained/refused rather than adapter-budget-selected. | G03; E09 |
| **14.2 Layout and update policy** (L725) | O/P/A | Stable source-position frame revisions exist and stable KV prefix/most-changing tail is binding. Full versioned epoch/tool/template/policy layout is not done. | G03,G05; E09 |
| **14.3 Budget accounting** (L741) | D/M | Chars/4 and incomplete media accounting are not serialized provider/template/tool/state/output budgeting with calibrated uncertainty. | G03 |
| **14.4 Selection objective** (L751) | P/M | Task kind/recency ranking exists, not full mandatory-first dependency/freshness/failure/path-value selection or diagnostic reasons. | G03; CORE/task-frame.ts:70–79,127–154 |
| **14.5 Delta, error, and media correctness** (L767) | P/D | Synthetic dependency closure and known blocks exist; delta baseline materialization, decisive failure/media recovery and unknown required replay safety remain incomplete. | G03,G05; E09 |
| **14.6 Compiler cache correctness** (L775) | P | Revision cache/hydration/detached clones exist; full epoch/profile/adapter/template/tool identity and real budget-only purity remain incomplete. | G03–G05; CORE/canonical-context.ts:165–203,245–246,360–365 |
| **15.1 Keep one stable recovery tool** (L783) | M/P | Internal bounded source/index reads are substrate, not stable model-facing batch recovery, planning/dedup/cursors and all coverage/access outcomes. | G04,G10 |
| **15.2 Query planning** (L802) | M/P | Internal bounded source/index reads are substrate, not stable model-facing batch recovery, planning/dedup/cursors and all coverage/access outcomes. | G04,G10 |
| **15.3 A small amount of selective push** (L810) | M/P | No implemented selective prefetch budget/reason or committed-epoch lifetime for recovered views. A summary frame reset is not recovery retention. | G04 |
| **15.4 Retention within an epoch** (L816) | M/P | No implemented selective prefetch budget/reason or committed-epoch lifetime for recovered views. A summary frame reset is not recovery retention. | G04 |
| **15.5 Evidence handles for large local data** (L822) | P/M | Exact handles and slices exist, not model-accessible evidence-local filter/count/join results with scanned/more-match coverage. Reuse current local execution, not another service. | G04,G10; CORE/history-index.ts:203–206,261–275 |
| **16.1 Continuation modes** (L830) | P/M | One inherited summary publisher and attempted-summary accounting exist; three-mode ContinuationPlan/epoch ownership does not. | G04,G17; CORE/agent-session.ts:8110–8230 |
| **16.2 Generic continuity policy** (L852) | P | Fork-owned inherited summary is current, not D reference-builder default. Frozen generic-control and separately measured balanced bridge remain incomplete. | G04,G16; CORE/compaction/compaction.ts:596–666,695–769 |
| **16.3 Astra continuity policy** (L860) | P/M/D | No distinct Astra portable/native continuity policy or measured fallback; inherited W26 summary still makes the false Python promise. | G04,G06,G16 |
| **16.4 Bounded portable checkpoint schema** (L866) | M | TaskFrame is not a bounded portable checkpoint schema. Source journal atomicity is not complete epoch coverage/resource/budget/CAS/late-event transaction acceptance. | G04 |
| **16.5 Atomic checkpoint transaction** (L885) | M | TaskFrame is not a bounded portable checkpoint schema. Source journal atomicity is not complete epoch coverage/resource/budget/CAS/late-event transaction acceptance. | G04 |
| **16.6 Native continuation rules** (L904) | P/M | Known opaque replay and Codex previous_response_id transport delta exist, not promoted standalone/stateful/in-request native-compaction canonical windows or public fallback. | G04–G05; AI/providers/openai-codex-responses.ts:1064–1115,1199–1217 |
| **16.7 Rotation frequency and accounting** (L912) | P/M | Summary attempt accounting exists; separate rotation/summary/native events and cost-aware hysteresis are absent with the complete epoch controller. | G04,G17–G18 |
| **17.1 Separate three caches** (L920) | P | Local view cache, transport delta and provider cache-read counters are distinct. No whole-path task timing/cost or physical KV-residency conclusion follows. | G18; CORE/canonical-context.ts:165–203; AI/providers/openai-responses-shared.ts:280–310 |
| **17.2 Rendered-prefix identity** (L926) | P/U/D | Prefix pieces exist; full rendered identity and evidenced advanced-cache route gating are incomplete. Optional unknown-route retention defaults are unsafe under the required contract. | G03,G05; E09 |
| **17.3 Keep-versus-rotate economics** (L934) | M | No keep-versus-rotate economic controller beyond a reserve threshold. Use deterministic conservative hysteresis before fitting allowed campaign observations. | G04,G18; CORE/compaction/compaction.ts:215–218 |
| **17.4 Reasoning-context experiments are shared where supported** (L950) | P/M | Known opaque replay and ordinary effort mapping exist; replay-family compatibility, fallback and isolated shared reasoning-context experiments are not certified. | G05,G16; AI/models.ts:67–96 |
| **18.1 Avoid generating expensive work** (L958) | P/U | Evidence-local/nonblocking procedure guidance and source handles exist, not measured work reuse or a valid deterministic execution cache. | CORE/prompts/rlm.ts:19–53; canonical-payload-parts.ts:80–119; G18 |
| **18.2 Event-driven jobs instead of polling conversations** (L966) | P/M | Bash handles and child update dedup exist, not one bounded job/wakeup/result owner across Bash/children/native async or watcher folding. | G08,G11; PY/bash.py:109–117,236–264,522–548 |
| **18.3 Skills as small procedures** (L974) | D/P | Full skill catalogs/bodies and missing immutable selected versions violate bounded/frozen skill requirements. | G09 |
| **18.4 Auxiliary inference and learning** (L982) | D/P | Native auxiliary receipts are real; main-model inheritance, disposal-started automatic work and missing separate job/configuration budgets remain. | G07,G17 |
| **18.5 Off mode and behavioral separation** (L990) | M/D | Compaction.enabled is not context.mode=off. Behavioral/skill injection and auto refinement remain separate; native safety owners should remain on. | G07 |
| **19.1 What the fork ancestor does and does not establish** (L1000) | D/M | Ancestor lifecycle fixes and durable spawn ACK do not supply the mandatory one-child guard or pre-await independent tree-wide scheduler. | G02; E12 |
| **19.2 Separate resource budgets** (L1006) | D/M | Ancestor lifecycle fixes and durable spawn ACK do not supply the mandatory one-child guard or pre-await independent tree-wide scheduler. | G02; E12 |
| **19.3 Child input and return contracts** (L1018) | P/D | Concise child task/model selection and completion attribution exist; scoped evidence/result manifests and cross-process workspace safety are incomplete. | G11 |
| **19.4 Passivation and restart** (L1026) | P | Idle passivation/rechecks, restore diagnostics and uncertain-work holds exist. Unified per-operation restart/live-handle guarantees and parallel speedup/cost evidence do not. | CORE/session-action-store.ts:373–401; DM/daemon-mode.ts:2772–2855; CORE/kernel/state-snapshot.ts:6–35; G02,G06,G11; E12 |
| **20.1 Behavioral tuning** (L1036) | M | No separately versioned, benchmark-isolated Astra behavioral policy. Do not leak it into generic control or impose routine delegation/artifacts/tests. | G05,G16 |
| **20.2 Effort configuration** (L1044) | P/M | Ordinary mapping is not a native effort timeline/update ordering/combination contract. No claim that required Astra actually received unsupported none/off values. | G05,G16; AI/models.ts:67–96; AI/providers/openai-responses.ts:258–272 |
| **20.3 Native asynchronous tools** (L1052) | M/P | Local parallel tools are not provider-native async pending/original-ID/out-of-order/disconnect ownership. Keep advanced feature off. | G11,G16; AG/agent-loop.ts:850–905 |
| **20.4 Mid-turn steering** (L1060) | M/P | Host turn-boundary queues and Codex response.create are not Astra update submit/ack/apply/reconcile or automatic continuation accounting. | G16–G17; CORE/agent-session.ts:7994–8001; AI/providers/openai-codex-responses.ts:1171–1196 |
| **20.5 Programmatic tool calling** (L1068) | M | Local Python/Bash batching is not provider-native PTC/program/caller linkage and compatibility. Optional and independent of common memory. | G16; AI/providers/openai-responses-shared.ts:189–208,259–267 |
| **21.1 Sol must not become a compatibility afterthought** (L1076) | P/M/A | Frozen S assets and inherited summary exist; native generic-control parity/golden requests/campaign do not. Exact existing-subscription targets are authorized, not certified. | G16,G18; E11,E13 |
| **21.2 Qwen and other generic models** (L1084) | P/M | Generic adapter flags/tool validation exist, not a pinned real model/tokenizer/template/server/parser/context/hardware deployment contract or acceptance. | G16; AI/providers/openai-completions.ts:668–676; AG/agent-loop.ts:975 |
| **22.1 Repair accounting before claiming optimization** (L1096) | P | Real source-bound physical attempts and normalized completeness exist; complete contract/permission/prefix/epoch/commit/effort metadata and all actual-purpose coverage remain open. | G17; E14 |
| **22.2 Request receipt contract** (L1102) | P | Real source-bound physical attempts and normalized completeness exist; complete contract/permission/prefix/epoch/commit/effort metadata and all actual-purpose coverage remain open. | G17; E14 |
| **22.3 Token and price normalization** (L1123) | P | Numeric usage validation and explicitly estimated catalog costs exist, not versioned route tariffs/tier/other-charge/local-compute or invoice certification. | G18; AI/utils/provider-attempts.ts:121–167 |
| **22.4 Timing and context metrics** (L1139) | P | Attempt/setup/agent/judge/lifecycle clocks exist; archive metrics can be null. No full settlement critical path/context/whole-tree memory/queue/stall measurement. | G18; BENCH/run.py:869–877,900–935 |
| **22.5 Freeze the experimental populations** (L1147) | P/A | H/S/D identities and exact H/current target route are pinned; complete executable B0-S/B0-D/generic/single-feature populations are not certified. | G16,G18; E11 |
| **22.6 Retry and selection rules** (L1167) | O/P/D/A | Synthetic first-valid/failure-retry fairness is observed; native parser is receipt-only, but live runner RPC-only capacity authority still differs. Confirmed invalidations never spend valid retry. | G17–G18; E14 |
| **22.7 Statistical interpretation** (L1175) | M/A | No final randomized repeated-block/held-out/uncertainty or required ablation campaign. Deferral is required by the user gate, not a reason to run early samples. | G18 |
| **22.8 Required ablations** (L1183) | M/A | No final randomized repeated-block/held-out/uncertainty or required ablation campaign. Deferral is required by the user gate, not a reason to run early samples. | G18 |
| **22.9 Targets, not promised results** (L1189) | P/A | Targets are not promised results; no new promotion margin or speed/cost/accuracy percentage is supportable. | G03,G16,G18 |
| **23.1 How the coding agent must work** (L1201) | P | Source-owned native work and narrow existing observations are real; remaining product features must be built directly, not replaced with a proof/review framework. | G01–G20; E01–E14 |
| **23.2 Dependencies and defaults** (L1321) | P/D/A | Logical dependencies permit independent edits, not conflicting ownership or premature promotion. Spec defaults are not met by current child admission/automatic auxiliary paths; five-feature benchmark gate remains binding. | G02,G07,G16; W0–W13 table |
| **23.3 Review boundaries that prevent a failed rewrite** (L1336) | P | Separate source correctness/control/policy/provider/concurrency dimensions. No new campaign exists from which to infer isolated effects; each new feature still needs its specified owner/validity contract. | G16–G19 |
| **24.1 Preservation, state, and recovery** (L1346) | P/D/M | All individual acceptance IDs are mapped below. Narrow observed components do not close whole requirements or current-snapshot certification. | Acceptance map; E01–E14 |
| **24.2 Compiler, continuation, and provider contracts** (L1365) | P/D/M | All individual acceptance IDs are mapped below. Narrow observed components do not close whole requirements or current-snapshot certification. | Acceptance map; E01–E14 |
| **24.3 Execution, lifecycle, and new controls** (L1388) | P/D/M | All individual acceptance IDs are mapped below. Narrow observed components do not close whole requirements or current-snapshot certification. | Acceptance map; E01–E14 |
| **24.4 Storage, accounting, and release** (L1407) | P/D/M | All individual acceptance IDs are mapped below. Narrow observed components do not close whole requirements or current-snapshot certification. | Acceptance map; E01–E14 |
| **24.5 Fork ownership, isolation, and crash safety** (L1426) | P/D/M | All individual acceptance IDs are mapped below. Narrow observed components do not close whole requirements or current-snapshot certification. | Acceptance map; E01–E14 |
| **24.6 Long-horizon scenarios beyond the thirty tasks** (L1473) | M/P | Short synthetic state/closure cases exist, not ten rotations, sparse decisive recovery, conflicting generations, kernel restart, child-result race, native-switch and no-compaction long-horizon acceptance. | G03–G06,G11,G16,G18; E08–E09 |
| **24.7 Stop and rollback conditions** (L1479) | P/D | Hold promotion for source-supported violations and missing owners; no paid invalid request, live data loss or accuracy regression is invented. Compatible archive/read/export rollback is not complete checkpoint rollback. | G01–G18 |
| **26.1 Supplied Prime Context source** (L1503) | U/P/A | Historical source register, prior T1/N probes and dated URLs are not new validation. Separate frozen-source corrections, supplied evidence, current implementation and mutable external contracts. No external page was revalidated in this audit. | Spec:1499–1630; IMP/baselines.json:12–38; E01–E15 |
| **26.2 Supplied Prime Agent source** (L1527) | U/P/A | Historical source register, prior T1/N probes and dated URLs are not new validation. Separate frozen-source corrections, supplied evidence, current implementation and mutable external contracts. No external page was revalidated in this audit. | Spec:1499–1630; IMP/baselines.json:12–38; E01–E15 |
| **26.3 Public Prime Context material recorded by the prior review** (L1545) | U/P/A | Historical source register, prior T1/N probes and dated URLs are not new validation. Separate frozen-source corrections, supplied evidence, current implementation and mutable external contracts. No external page was revalidated in this audit. | Spec:1499–1630; IMP/baselines.json:12–38; E01–E15 |
| **26.4 External primary technical documentation** (L1555) | U/P/A | Historical source register, prior T1/N probes and dated URLs are not new validation. Separate frozen-source corrections, supplied evidence, current implementation and mutable external contracts. No external page was revalidated in this audit. | Spec:1499–1630; IMP/baselines.json:12–38; E01–E15 |
| **26.5 T1 — Earlier reproduced probes retained as evidence** (L1573) | U/P/A | Historical source register, prior T1/N probes and dated URLs are not new validation. Separate frozen-source corrections, supplied evidence, current implementation and mutable external contracts. No external page was revalidated in this audit. | Spec:1499–1630; IMP/baselines.json:12–38; E01–E15 |
| **26.6 N — New fork-specific source audit and probes** (L1592) | U/P/A | Historical source register, prior T1/N probes and dated URLs are not new validation. Separate frozen-source corrections, supplied evidence, current implementation and mutable external contracts. No external page was revalidated in this audit. | Spec:1499–1630; IMP/baselines.json:12–38; E01–E15 |
| **26.7 U — Upstream primary sources checked for this decision** (L1621) | U/P/A | Historical source register, prior T1/N probes and dated URLs are not new validation. Separate frozen-source corrections, supplied evidence, current implementation and mutable external contracts. No external page was revalidated in this audit. | Spec:1499–1630; IMP/baselines.json:12–38; E01–E15 |

**§25, all paragraphs (L1485–1497): P/M.** The functional first release is not done. Native source ownership, exact storage and scoped auth exist; full migration, update/rollback, continuation/recovery, receipt contracts, installed artifacts, model policies/campaigns and maintained operations remain incomplete (G01–G20). The user-facing result must remain task/evidence/recovery, not source-ledger or save/pin/ack management. Source ancestry, product version, runtime/storage/daemon contracts and behavioral/provider support must be distinguished.

**Final implementation directive (L1632–1634): P/A.** The maintained source fork and retirement of product patch surgery are real. Complete product isolation, preserved Sol behavior, all-work accounting, owned updates and evidence-based per-model promotion are not complete. All approved overrides and the benchmark/publication holds remain binding. The introductory title/decision framing (L1–13) is an objective, not an achieved performance claim.

### Inherited defect inventory in §9.2

These retain the confidence limits of the original observations. They are not twelve new runtime failures.

| ID | W26 disposition |
|---|---|
| D01 | O/P: source-backed truth and bounded rendering replace small truth caps; full1000 native recovery gate remains open (G20). |
| D02 | O/P: exact case/flags and explicit/ambiguous supersession are covered in scoped state fixtures; retain through recovery/rotation (G20). |
| D03 | P/M: inherited summary remains, but resolved profile/adapter continuation gate is missing (G05,G16). |
| D04 | M: no complete bounded portable checkpoint/coverage transaction; TaskFrame is not that packet (G04). |
| D05 | D: unconditional W26 Python promise remains despite narrower later runtime checks (G06). |
| D06 | P/M: known opaque replay exists; public/native compatibility and required unknown-item fallback remain incomplete (G05). |
| D07 | P/D: incremental indexes are real; saved native/legacy catalogs still scan and retain unbounded reductions (G08). |
| D08 | O/P/D: owned Manager clears full maps and bounded consumers exist; catalog/aggregate/whole-harness gaps remain (G08). |
| D09 | D/M: no effective one-child admission or independent pre-await tree scheduler (G02). |
| D10 | O/P/D: native receipt parser, honest legacy unknowns and first-valid policy are corrected; complete metadata/physical coverage and runner capacity authority remain open (G17–G18). |
| D11 | P: revision-aware cache and detached clones exist; helper mutation is not evidence of a current live same-ID storage defect (G03,G05). |
| D12 | D/M: disposal-started automatic work and absent optimizer-off boundary remain (G07). |

## W0–W13 workstream and exit-gate map

| Workstream / spec line | Status | Shipped scope and remaining exit gate |
|---|---|---|
| W0 — Freeze controls, audit ownership, establish a build (1209) | P/A | Separate H/S/D pins,391 dispositions, source build and offline setup exist. Exact executable control/model/tariff/platform inputs and complete artifact baseline remain unverified. H0.9.3 is approved (G15–G19; E09–E13). |
| W1 — Product isolation (1217) | P/D | Owned identity/runtime/auth/daemon graph exists; harmful upstream docs, stale contract reporting, hooks export, updater and current installed coexistence gates remain (G13–G15). |
| W2 — Semantic source ports (1225) | P | Native capture/coordinator/TaskFrame/ViewUnit ownership exists. Complete S semantic parity, explicit turn outcomes and disposition closure do not (G03–G05,G11,G16,G19). |
| W3 — Reliable source/effects/receipts (1233) | O/P/D | Canonical owner/index/intent/receipt work is real; unchecked active recovery writes and complete unresolved-effect/publication contracts remain (G01,G10,G17; E01–E04). |
| W4 — Durable state/exact index (1241) | O/P | Qualified exact state, indexed sources and refusal semantics exist. Full runtime facts,1000 admitted obligations and native recovery/retention acceptance remain (G10,G20; E03,E08–E09). |
| W5 — Native history/hot memory (1249) | O/P/D | Activated indexed Manager and applied W21/W23 bounds exist. Saved catalogs/aggregate buffers and current whole-harness scale/platform evidence remain open. Old473 measurements are real storage-only observations (G08; E04–E07). |
| W6 — Compiler/recovery/evidence-local execution (1257) | O/P/M | W26 native TaskFrame injection/stable revisions and ViewUnit helpers are shipped. Real provider budgets/selection, stable epochs, selective/batched recovery and evidence-local coverage outputs are not complete (G03–G04). |
| W7 — Generic/Sol preservation (1265) | P/M | Frozen S external layout and inherited native summary exist, not certified native generic-control/golden requests, pinned generic deployment or campaign (G16; E11). |
| W8 — Atomic checkpoints/native continuation (1273) | M/P | Ordinary summary/accounting and Codex transport continuation are substrate, not complete atomic epochs, canonical native modes or switching/expiry fallback (G04–G05). |
| W9 — Astra/shared cache features (1281) | P/M | Ordinary known replay/cache/effort source exists. Advanced effort/async/steering/PTC predicates and exact-route feature/ablation evidence remain absent. No blanket enablement (G05,G16). |
| W10 — Owned scheduling (1289) | M/D/P | Ancestor cancellation/passivation is credited; effective conservative child admission, independent reservations, workspace/result contracts and parallel performance gates are not complete (G02,G11). |
| W11 — Non-destructive migration/recovery (1297) | M/P | Retained-journal copy/future-version guards exist. Product dry-run/staging/reference mapping/paused authority/trusted resume/rollback do not (G12). |
| W12 — Release/model-policy certification (1305) | M/P/A | Source checks/builds and older packing are not current installed release/provider/platform/campaign certification. All live benchmarks remain barred until five prerequisites finish; publication needs approval (G15–G18). |
| W13 — Maintained-fork operations (1313) | M/P/D | Ancestry/disposition notes exist, not owned support/security roles, reviewed-through intake/sample backport, support/rollback operations. Upstream user-routing docs are an actual deviation (G13,G19). |

## Complete acceptance-ID coverage

Each row names the exact spec acceptance ID. The status is scoped by its note and the linked finding/evidence; no row silently turns a source check or historical helper test into a full W26 acceptance pass.

| ID — acceptance | Status | Assessment / remaining gate | Sources and evidence |
|---|---|---|---|
| **P01 — Exact Sol baseline diff** (spec:1350) | P/M | Frozen source/control metadata exists; native Sol golden-request and exact baseline certification is missing. | G16,G19; E11 |
| **P02 — Source-port golden requests** (spec:1351) | P/M | Frozen source/control metadata exists; native Sol golden-request and exact baseline certification is missing. | G16,G19; E11 |
| **P03 — Model-independent fixed views** (spec:1352) | P | Native fixed-view metadata is real; cross-profile adapter-certified selection is unfinished. | G03,G05; E09 |
| **P04 — Thirteen and one thousand active constraints** (spec:1353) | P | Qualified short fixtures exist, not 1,000 admitted obligations with bounded rendering and model recovery. | G20; E08,E09 |
| **P05 — Case-sensitive literals** (spec:1354) | O/P | Exact case, ambiguous updates and proposal authority observed in reducer/admission fixtures; full recovery/rotation acceptance remains partial. | G20; E08,E09 |
| **P06 — Ambiguous updates** (spec:1355) | O/P | Exact case, ambiguous updates and proposal authority observed in reducer/admission fixtures; full recovery/rotation acceptance remains partial. | G20; E08,E09 |
| **P07 — Descriptive state** (spec:1356) | O/P | Exact case, ambiguous updates and proposal authority observed in reducer/admission fixtures; full recovery/rotation acceptance remains partial. | G20; E08,E09 |
| **P08 — Small literal history** (spec:1357) | P | Exact short-source locators exist; recovery after atomic checkpoint replacement is not implemented end to end. | G04,G10; E03,E09 |
| **P09 — Recovered evidence** (spec:1358) | M | No native same-epoch recovery lifetime or single-call bounded recovery interface; internal readers are substrate only. | G04 |
| **P10 — Single-call recovery** (spec:1359) | M | No native same-epoch recovery lifetime or single-call bounded recovery interface; internal readers are substrate only. | G04 |
| **P11 — Retrieval completeness** (spec:1360) | P | Branch qualification and partial-index outcomes exist; complete access/deletion/injection-safe recovery contract is unfinished. | G04,G10,G12; E03,E08,E09 |
| **P12 — Scope and injection** (spec:1361) | P | Branch qualification and partial-index outcomes exist; complete access/deletion/injection-safe recovery contract is unfinished. | G04,G10,G12; E03,E08,E09 |
| **P13 — Freshness** (spec:1362) | P/M | Source revisions exist; automatic artifact/test/job/kernel freshness acceptance is missing. | G06,G20 |
| **P14 — Skills** (spec:1363) | D/P | Catalog/body/version limits are absent on actual paths; no malicious-history learning acceptance is established. | G09 |
| **C01 — Generic compaction gate** (spec:1369) | P | Inherited native summary exists; explicit frozen generic-control/continuation profile gate is missing. | G05,G16 |
| **C02 — Stable prefix** (spec:1370) | O/P/A | Sparse frame slots observed; complete template/tool/profile/epoch prefix contract remains partial. Stable-prefix/tail override applies. | G03,G05; E09 |
| **C03 — Same-ID mutation** (spec:1371) | P | Revision-aware cache and detached views exist; arbitrary same-ID canonical mutation/full identity acceptance is not established. | G03,G05; E09 |
| **C04 — Budget-only purity** (spec:1372) | P/U | Read-only usage estimation is not a finished non-mutating provider-budget preflight over a committed epoch. | G03,G04 |
| **C05 — Delta closure** (spec:1373) | P | Synthetic dependency closure/refusal helper observed; actual provider delta materialization/rebase is missing. | G03; E09 |
| **C06 — Protocol closure** (spec:1374) | P | Known replay groups exist; complete adapter-certified protocol/native-program closure is unfinished. | G05 |
| **C07 — Unknown block** (spec:1375) | D/M | Unknown required output items lack lossless preservation or explicit safe refusal/fallback; no malformed live request was observed. | G05 |
| **C08 — Tokenizer diversity** (spec:1376) | D/M | Universal chars/4 and user-image omission are not model/template/media-aware budgets or diversity acceptance. | G03 |
| **C09 — Huge required group** (spec:1377) | P/M | Source-byte/group helper refusals exist; real provider required-group budget fallback remains missing. | G03 |
| **C10 — Bounded checkpoints** (spec:1378) | M | No complete bounded checkpoint/epoch transaction, late-event race or checkpoint-crash acceptance. | G04 |
| **C11 — Checkpoint race** (spec:1379) | M | No complete bounded checkpoint/epoch transaction, late-event race or checkpoint-crash acceptance. | G04 |
| **C12 — Checkpoint crash** (spec:1380) | M | No complete bounded checkpoint/epoch transaction, late-event race or checkpoint-crash acceptance. | G04 |
| **C13 — Native canonical output** (spec:1381) | M | Codex transport continuation is not canonical output handling for promoted native-compaction modes. | G04,G05 |
| **C14 — Public versus opaque continuity** (spec:1382) | P | Known opaque replay exists; public/opaque continuity and privacy-safe compatible fallback remain incomplete. | G05 |
| **C15 — Model/route switching** (spec:1383) | M/P | Ordinary model switching/local continuation reset is not compatible-lineage or expired-state recovery acceptance. | G04,G05 |
| **C16 — Kernel reality** (spec:1384) | D/M | W26 summary promises kernel survival without authoritative generation input; later fix is outside this snapshot. | G06 |
| **C17 — Expired provider state** (spec:1385) | M/P | Ordinary model switching/local continuation reset is not compatible-lineage or expired-state recovery acceptance. | G04,G05 |
| **C18 — Cache adapter** (spec:1386) | P/U/D | Optional cache fields/transport state exist; unknown-route gating gap and exact target wire/cache evidence remain. | G05,G16 |
| **X01 — Simultaneous child spawns** (spec:1392) | M/D | No pre-await tree-wide capacity reservation/settlement or parent-wait slot contract; existing setup cleanup is narrower. | G02 |
| **X02 — Spawn failure** (spec:1393) | M/D | No pre-await tree-wide capacity reservation/settlement or parent-wait slot contract; existing setup cleanup is narrower. | G02 |
| **X03 — Parent waiting** (spec:1394) | M/D | No pre-await tree-wide capacity reservation/settlement or parent-wait slot contract; existing setup cleanup is narrower. | G02 |
| **X04 — Nested cancellation** (spec:1395) | P | Visited-set nested cancellation exists; complete new scheduler/job acceptance is not established. | G02,G11; E06 |
| **X05 — Passivation** (spec:1396) | P | Idle passivation predicates exist; real kernel/live-handle restart and scheduler ownership acceptance are incomplete. | G11; E06 |
| **X06 — Unknown side effect** (spec:1397) | P | Intent/result storage and recovery holds exist; residual journal durability and per-effect unknown reconciliation remain. | G01,G10 |
| **X07 — Parallel writes** (spec:1398) | D | Children share CWD; same-process native edit queue is not cross-worker/Bash/Python resource ownership. | G11 |
| **X08 — Polling** (spec:1399) | P/M | Event-driven Bash handles and deduped child updates exist; unified wait/wakeup/watcher policy is missing. | G11 |
| **X09 — Shutdown** (spec:1400) | D | Disposal can start new due automatic refinement under documented conditions, not merely drain existing work. | G07 |
| **X10 — Off mode** (spec:1401) | M/D | No complete optimizer-off transition, behavioral/auxiliary switch and preserved public recovery contract. | G07 |
| **X11 — Astra effort rules** (spec:1402) | P/M | Ordinary effort mapping exists; exact Astra update values/order/combination timeline is missing. | G05,G16 |
| **X12 — Native async** (spec:1403) | M/P | Local parallel tools and turn-boundary queues are not native async or provider steering protocols. | G05,G16 |
| **X13 — Steering** (spec:1404) | M/P | Local parallel tools and turn-boundary queues are not native async or provider steering protocols. | G05,G16 |
| **X14 — Mixed-model children** (spec:1405) | P | Independent child model lookup exists; complete child contract, scoped evidence and mixed-model certification are absent. | G02,G05,G11,G16 |
| **R01 — Archive fault injection** (spec:1411) | P | Helper/actor/index faults observed historically; not all active journals or full projected archive publication. | G01,G10; E01,E02,E03 |
| **R02 — GC** (spec:1412) | M | Per-session deletion is not retained-root GC or explicit tombstone semantics. | G10 |
| **R03 — Scale** (spec:1413) | O/P | Actual 10k/100k/1m storage-subset measurements exist at old473; W26 full scale acceptance remains incomplete. | G08; E07 |
| **R04 — Hot memory** (spec:1414) | P/M | Applied component bounds and storage-group RSS are not whole-harness/process-tree hot-memory certification. | G08; E04,E05,E07 |
| **R05 — Large exact reads** (spec:1415) | O/P | Bounded canonical source-fragment reads observed; legacy compressed-envelope/bomb acceptance remains incomplete. | G10; E03 |
| **R06 — All inference purposes** (spec:1416) | P | Native main/auxiliary owners exist; fake purpose-enum tests do not establish every actual promoted provider purpose. | G17; E13 |
| **R07 — Deduplication** (spec:1417) | O/P | Synthetic parser observations establish deduplication and unknown preservation, not complete actual root-child billing/usage. | G17; E13 |
| **R08 — Unknown usage** (spec:1418) | O/P | Synthetic parser observations establish deduplication and unknown preservation, not complete actual root-child billing/usage. | G17; E13 |
| **R09 — Late settlement** (spec:1419) | P/U | Settlement ownership exists; full output-commit/epoch associations and real late settlement acceptance remain incomplete. | G17 |
| **R10 — Pricing** (spec:1420) | P | Normalization checks/catalog estimates exist; versioned route tariffs, tiers and billed/other-charge evidence do not. | G17,G18 |
| **R11 — Retry fairness** (spec:1421) | O/P/D/A | First-valid primary/retained retries observed synthetically; native RPC-only capacity invalidation remains a distinct source issue. Capacity override applies. | G17,G18; E13 |
| **R12 — Packaging** (spec:1422) | P/D | Owned build graph exists; hooks export is dangling and current installed SDK/declaration/daemon/bundle certification is absent. | G14,G15; E10,E14 |
| **R13 — Real providers** (spec:1423) | M/A | Real provider and accuracy campaigns are missing and correctly deferred. Setup/dummy auth/faux tests are not these gates. | G16,G18; E11,E12,E13 |
| **R14 — Accuracy** (spec:1424) | M/A | Real provider and accuracy campaigns are missing and correctly deferred. Setup/dummy auth/faux tests are not these gates. | G16,G18; E11,E12,E13 |
| **F01 — Ancestry** (spec:1432) | P/A | Actual approved H ancestry and source identity recorded; complete selected-port/staged-release contract is not certified. | G19; E14 |
| **F02 — Patch retirement** (spec:1433) | U | No legacy patcher on inspected native build/install paths; all installed lifecycle paths have not been exercised at W26. | G15,G19 |
| **F03 — Dependency isolation** (spec:1434) | P/D | Owned dependencies/extension aliases exist; advertised hooks export lacks source, and installed isolation is unverified. | G14,G15; E10 |
| **F04 — Native surface parity** (spec:1435) | P | Native owners really wire through SDK/session; all shipped-mode provider/permission/service parity is not established. | G03,G04,G17; E04,E09 |
| **F05 — Identity matrix** (spec:1436) | D/P | Native product identity is real, but W26 README/support routes and doctor/protocol descriptions are wrong or stale. | G13 |
| **F06 — Two-product coexistence** (spec:1437) | P/M | Older installed coexistence is scoped to an earlier checkpoint; no current install/update/uninstall coexistence evidence. | G13,G15; E15 |
| **F07 — Cross-product handshake** (spec:1438) | U | Foreign-product rejection is in source; synthetic socket fixture/old coexistence is not current installed protocol11 proof. | G13,G15 |
| **F08 — Worker fencing** (spec:1439) | P | Daemon token/generation/start fencing exists, not complete new scheduler/result/capacity lifecycle acceptance. | G02,G11; E06 |
| **F09 — Runtime bootstrap** (spec:1440) | P | Owned bundled runtime bootstrap/refusal exists; pack listings are not current installed Python/kernel/pair compatibility. | G15; E10 |
| **F10 — Environment parsing** (spec:1441) | U | Explicit path parsing/legacy alias fences exist; complete Unicode/whitespace/platform artifact cases are unverified. | G13,G15 |
| **F11 — Update isolation** (spec:1442) | D | Updater origin/redirect/identity/compatibility and fail-stay/pair-rollback requirements are not met globally. | G14 |
| **F12 — Catalog determinism** (spec:1443) | U/P | Catalog generation is separate and source is pinned; final refresh provenance/network-variation artifact evidence is incomplete. | G15; E14 |
| **F13 — Real artifact notices** (spec:1444) | P | Notices appear in older four-package pack listings; no complete current extracted/binary/wheel/source/SBOM gate. | G15; E10 |
| **F14 — No surprise network export** (spec:1445) | U/P | Dedicated opt-in export source exists; no actual complete startup/import/shutdown no-export evidence, and importer is absent. | G12,G13 |
| **F15 — Auth contract** (spec:1446) | O/P/A | Read-only instance-only existing subscription observed with dummy OAuth; not login/refresh/entitlement/wire certification. API keys are not a blocker. | G13,G16; E12 |
| **F16 — Dry-run migration** (spec:1447) | M/P | Product dry-run/staged interrupted import is missing; bounded retained-journal copy is narrower infrastructure. | G12 |
| **F17 — Interrupted import** (spec:1448) | M/P | Product dry-run/staged interrupted import is missing; bounded retained-journal copy is narrower infrastructure. | G12 |
| **F18 — Legacy reference mapping** (spec:1449) | P | Retained journal IDs/parents preserved in copy; complete observation/task/artifact/attachment mapping/tombstones are absent. | G12 |
| **F19 — Paused imports** (spec:1450) | M | No product paused-import contract for schedules, heartbeats, jobs and outboxes. | G12 |
| **F20 — Trusted restore** (spec:1451) | P/M | JSON journal copying does not execute snapshots; full trusted preview/import/resume contract is missing. | G12 |
| **F21 — No dual context engine** (spec:1452) | M | No explicit legacy context-engine rejection before extension factory execution; no observed double execution is claimed. | G12 |
| **F22 — Schema rollback** (spec:1453) | P | Future-version/legacy-writer guards and read-only paths exist, not complete installed schema/provider-lineage rollback. | G12 |
| **F23 — Short writes** (spec:1454) | D/O | Checked canonical subset observed, but activated recovery/orphan writes and corruption handling still violate global requirements. | G01; E01,E02 |
| **F24 — Zero-progress writes** (spec:1455) | D/O | Checked canonical subset observed, but activated recovery/orphan writes and corruption handling still violate global requirements. | G01; E01,E02 |
| **F25 — Torn-tail repair** (spec:1456) | D/O | Checked canonical subset observed, but activated recovery/orphan writes and corruption handling still violate global requirements. | G01; E01,E02 |
| **F26 — Journal/index gap** (spec:1457) | P | Source/index coverage recovery exists; all projection/checkpoint publication fault acceptance remains incomplete. | G10; E02,E03 |
| **F27 — Bounded serialization** (spec:1458) | P/D | Frame/queue admission exists; recovery/catalog/skill/aggregate/transient paths remain outside complete bounds. | G01,G08,G09 |
| **F28 — Canonical source** (spec:1459) | P | Task/evidence/receipt entries share native source identities; complete archive/epoch/job reconciliation remains missing. | G04,G10,G17,G20 |
| **F29 — Effect ambiguity** (spec:1460) | P | Cancellation unknowns/recovery holds exist; durable per-tool crash reconciliation remains incomplete. | G01,G10 |
| **F30 — Late checkpoint events** (spec:1461) | M | Captured reads and one summary append path are not complete atomic epoch ownership and late-event handling. | G04 |
| **F31 — Independent epoch ownership** (spec:1462) | M | Captured reads and one summary append path are not complete atomic epoch ownership and late-event handling. | G04 |
| **F32 — Multi-process budgets** (spec:1463) | M | No independent multi-process tree-wide capacity scheduler; expired ownership is not proof external work stopped. | G02 |
| **F33 — Child result publication** (spec:1464) | P | Durable spawn/status/usage exist; complete committed child artifact/result publication and deduped parent consumption are absent. | G02,G11 |
| **F34 — Parent/child workspace safety** (spec:1465) | D | Shared-CWD workers lack complete concurrent-write isolation or centralized ownership. | G11 |
| **F35 — UI disconnection** (spec:1466) | P | Inherited disconnect/replay suppression exists; weak recovery writes and incomplete full native lifecycle remain. | G01,G11,G17; E06 |
| **F36 — Optimizer mode transition** (spec:1467) | M/D | Optimizer transition cannot be certified by toggling compaction alone. | G07 |
| **F37 — Small-task overhead** (spec:1468) | P/M | No mandatory paid ranker in compiler, but automatic work/catalog paths and small-task overhead evidence remain unresolved. | G07,G08,G18 |
| **F38 — Platform/runtime floor** (spec:1469) | P/M | Older Linux/Node22.8 storage observations are real; current installed OS/Python/kernel/Windows/network-FS gates are not. | G15; E02,E07,E10 |
| **F39 — Upstream intake** (spec:1470) | M | Ancestry correction is not a reviewed-through selective intake/sample backport with dependency closure and executed regression. | G19 |
| **F40 — Published claims** (spec:1471) | D/P/M | Incorrect/stale user claims plus missing current release/model/platform evidence; no publication approval. | G13,G15,G16,G18,G19 |

## Existing evidence register and limits

All entries below were retained before this audit. Reading them is not rerunning them. Source inspection establishes wiring or a source-level conflict, not an executed failure. Parent-reported outcomes are labelled. Older checkpoints, external controls, installed artifacts, local faux streams and real provider calls are separate evidence populations.

| Evidence | Retained location and observation | Limit |
|---|---|---|
| **E01 — historical journal helpers** | `.work/logs/w3-journal-close-errors.log` (17 cases across helper/sink/flush), `w3-journal-frame-codec.log` (2). `TEST/journal-io.test.ts:13–39` injects partial/EINTR/zero/ENOSPC; journal-frame `9–36` exercises codec. | Historical helper scope, not physical disk-full or all production writers. G01 active recovery writes remain outside it. |
| **E02 — canonical owner processes** | `.work/logs/w3-session-journal-owner-process-tests.log`, `w3-session-journal-owner-physical-identity-tests.log`: the same two evolving cases with actual Node22.8 actor IPC, large upload, identity exclusion, torn repair/corruption and POSIX owner death. `TEST/session-journal-owner.test.ts:88–178,294–310`. | Not four distinct cases. POSIX signal portion skips Windows. Not complete checkpoint/effect/whole-system crash certification. |
| **E03 — historical index/source reads** | `.work/w4-payload-index-e7vmatjj/test.log`, `.work/w5-bounded-history-1ojk305l/test.log` and handoffs: same evolving two index cases, bounded parts and branch/query restrictions. Current source `CORE/canonical-payload-parts.ts:6,80–119`; history-index-worker `1519–1572` reads bounded exact parts. | Old schemas5/8 observations do not certify every later assertion or current schema15. Not migrated compressed-envelope/public recovery acceptance. |
| **E04 — activated native Manager/SDK** | `.work/w19-manager-residency-consumers-handoff.json`, `.work/w19-residency-consumers-yhzory8u/runtime/logs/test.log` (runtime PID3071053, two cases); `.work/w19-indexed-manager-backend-handoff.json`, `.work/logs/w19-indexed-manager-existing-two-tests.log` (Manager PID3071791, two cases). The later offline-replay happy retry is the same case. | Real native storage IPC/Manager binding and local faux SDK/fork behavior, not provider wire, kernel, current release or all lifecycle paths. Handoff build claims are Parent-reported where not independently logged. |
| **E05 — applied per-store/request bounds** | `.work/logs/w21-harness-state-ts-existing-two-tests.log`, `w21-harness-state-python-existing-two-setup-retry.log`, `w23-tree-request-existing-two-tests.log`: two selected cases each execution. Source: `CORE/refinement/refinement.ts:297–442,475–540`, `PY/harness.py:26–29,214–244,349–352`, `CORE/context-tree.ts:40–103`. | These patches ARE applied at W26. Per-image/request/queue limits are not aggregate RSS, concurrent-request, transient heap or Python-cache bounds. Initial Python environment setup failure is not a runtime case. |
| **E06 — historical process/lifecycle work** | `.work/w3-index-process-o13_rrub/output.log` includes actual ownership/recovery process work, but that invocation had39 passes/4 failures. `.work/w3-index-faux3-7sgwaval/output.log` and `.work/w3-index-final-test-results.json` record separate corrective/aggregate results. `.work/logs/w5-native-session-execution-binding-tests.log` and `w2-central-execution-tests.log` include narrow local-faux intent/result ownership cases. | Do not relabel an aggregate as one current green164-case run. Process ownership/cancellation observations are not tree-wide capacity, real external effects, kernel or provider certification. |
| **E07 — actual historical storage scale measurements** | `.work/native-memory-gates-prep-2uxkj_vk/measurement-results.json`, `frozen-commands.json`, `runs/{10000,100000,1000000}`. Actual runs at `473c85ffcf51d80adf742e5eecebdbd34f8eb53d`, PIDs3092731/3094076/3095197, exit0:64 measured appends and64 exact reads per size. | These measurements DID run; the prep directory name does not mean unexecuted. Synthetic512-byte users/off-branch siblings/context markers are not model epochs. RSS covers storage actor/index/source-loader group only, not whole Agent/daemon/provider/kernel/children. No numeric pass threshold is inferred. |
| **E08 — task state** | `.work/logs/w24-task-reducer-two-tests.log`, `w24-captured-task-reader-two-tests.log`; same evolving suite. `TEST/task-state-reducer.test.ts:26–136` exercises qualified requirements, amendment/case, proposal/ambiguity/legacy partial/refusal. | Short synthetic structured cases, not1,000 admitted native obligations or long-horizon model recovery. Exact reducer semantics are nevertheless real source progress. |
| **E09 — W26 TaskFrame/ViewUnits** | `.work/logs/w26-view-unit-two-tests.log`, `w26-view-source-index-existing-two-tests.log`, `w26-taskframe-compiler-existing-two-tests.log`, `w26-taskframe-compiler-existing-happy-retry.log`, `w26-taskframe-native-existing-input-test.log`. **Seven distinct cases:**2 view helpers+2 indexed sources+2 compiler+1 actual native SDK/local-faux input case. | Initial compiler execution had1 pass/1 fail due an incorrect expanded-user authority expectation; corrected same happy case reran. It is not an eighth case. Compiler uses actual `convertToLlm` and two stable revisions; native input fixture preserves admitted task text. No provider or kernel; helper closure is not provider selection. |
| **E10 — W25 four-package packing** | `.work/w26-subscription-candidate-066kpvy4/pack-command.txt`, `logs/pack.log`: offline `npm pack --ignore-scripts` of four core packages using W25 outputs, with notices in listings. | Not W26 extracted archives, installed SDK/bootstrap, platform binary, wheel, full license/SBOM or release certification. A directory named w26 does not change source provenance. |
| **E11 — separate external frozen controls** | `.work/ds-frozen-layouts-gcnind2s/D/hosts.json`, `S/hosts.json` and their SETUP/receipts identify separate0.9.1 hosts/9.2.0 plugins and pinned Node22.22.1 layouts. Frozen H/D/S source assets and `IMP/baselines.json`/`ports.md` distinguish controls and ancestry. | Offline copy/patcher/layout completion only. No CLI/SDK/kernel/provider/model/entitlement or baseline/campaign certification. External Astra configuration is not static catalog, price or physical-profile proof. |
| **E12 — existing-subscription auth** | `.work/logs/w25-subscription-auth-existing-two-tests.log`:2 passed/56 skipped. `TEST/auth-storage.test.ts:912–994`, provider-contracts `37+` use dummy/read-only backends. Actual source: `CORE/auth-storage.ts:283–311,923–946`, provider-contracts `10–55`, model-registry `1022–1035,1310+`; SDK `31–35,302–307`. | Instance-only existing subscription is implemented, with no refresh/key fallback and exact Codex endpoint gates. No real credentials were inspected and no wire entitlement was established. Normal/global OAuth restrictions remain; API keys are not the blocker. |
| **E13 — accounting/runner fixtures** | `.work/logs/w25-subscription-benchmark-existing-two-tests.log`, `w25-benchmark-existing-happy-real-sandbox.log`. `BENCH/test_harness.py:103–201` uses synthetic receipts/mocked RPC and a real isolated Python workspace/dummy-host-file exclusion branch. | Two existing primary/accounting/capacity cases, plus same happy rerun; not new cases, a provider or a native kernel. Earlier sandbox repeat did not exercise the newly added branch. Native parse authority is fixed; G17 live runner path remains distinct. |
| **E14 — W26 static/build association** | `.work/logs/w26-taskframe-view-units-full-check.log` reports1029 files/no fixes and static checks. `w26-clean-taskframe-view-units-build.log` reaches bundle; commit/push logs and `.work/namespace-state.json` `w26_current` retain source/build association and Parent-reported successful outcomes. | No audit rerun. Fullcheck/build/normal hooks/clean commit/push are not installed-artifact, protocol, provider, kernel, platform or campaign gates. |
| **E15 — older installed/coexistence evidence** | `.work/namespace-state.json` older `installed_coexistence`/versioned receipts and `IMP/product-isolation.md:47–54`; Parent-reported installed lifecycle work belongs an earlier protocol checkpoint. | Not W26 protocol11 installation/update/uninstall/Windows certification. Windows and network-filesystem gates remain UNRUN per Parent; no newer whole-harness evidence was supplied. |

Additional bounded-source evidence is not a hidden whole-process guarantee. Examples include journal/Manager queues32 items/64MiB; index32 items/4MiB and2MiB request cap; native full materializers16,384 entries/64MiB; tree requests256 nodes/4MiB metadata/16,384 directory entries;64KiB exact parts; SQLite's requested2MiB pager cache. These are implementation admission settings, **not** RSS thresholds or guarantees about total transient heap, aggregate caches, kernels or the process tree.

## Post-W26 changes — not retroactive compliance

Parent reports later live work. It does not alter any W26 finding above:

- The compaction prompt's unconditional Python-survival statement was removed. `.work/logs/w27-compaction-runtime-note-existing-two-tests.log` reportedly passed the same two initial/update prompt cases (PID3188059, exit0;26 filtered). This is a prompt correction, not resource-generation or kernel-liveness completion. It was not committed/fullchecked at the earlier report.
- Parent later reported W27 budget code applied, three AI cases and typecheck passed. This audit did not inspect or certify that later integration. External token-budget drafts and concurrent epoch work are also outside the frozen snapshot.
- Parent reported live README install/management guidance, SECURITY and CONTRIBUTING ownership corrected, with explicit pre-release/unpublished state, owned repository routes and retained upstream acknowledgement. No installer/URL execution, platform/usability or release certification was claimed. W26's original documentation deviations remain in this audit.

No later message supplies the missing complete W26 epoch/recovery, whole-harness memory, exact live provider, installed release or campaign evidence.

## Current prerequisite implementation — W28/W29

This update does not change the immutable W26 findings or line anchors above.
Scope remains frozen to the five benchmark prerequisites; unrelated findings remain deferred.

- **TaskFrame:** native source-qualified frames remain in provider context. W29 stores frozen frame text/anchors in source-backed epoch checkpoints and reconstructs them on same-journal reopen. This does not complete authoritative resource generations.
- **ViewUnit closure/selection:** W28 applies complete replay/dependency closure to real compiler output. W29 selects historical plain assistant literals in the actual native OpenAI Responses request after one payload hook. Current users, latest assistant, TaskFrames, fixed views and genuine recovery units remain mandatory. Exact V1/legacy reply identities are supported; retained generated IDs may not shift. Tool-bearing, Codex and opaque projections remain unsupported/intact-or-refused.
- **Model-aware budgets:** actual serialization uses an explicit route/model/profile and conservative estimates. Selection and admission share one captured evaluator across the checkpoint wait; ordinary receipt observations still feed future requests. No tokenizer, live cost/accuracy or deployment certification is implied.
- **Committed epochs:** the existing compaction owner ACKs qualified source recipes, frozen TaskFrames and actual representation identity before adoption/send. Same-source CAS, restart reconstruction, stable service-request prefixes and ordinary-summary continuation have focused offline working paths. Cross-file/fork/import rebuilds, full replay/resource boundaries and ordinary-summary recovery retention remain open. Ownership/RPC schema32 rejects older source readers; protocol11 remains unchanged.
- **Selective recovery:** native `prime_context` and active-cell `rlm.prime_context` return bounded selected source data in the actual finalized tool output. W29 qualifies only the selected executor entering the authorized reader. Forged markers/custom replacements cannot qualify; retained imports lose recovery-kind admission. This is producer provenance, not success, authority promotion or resource freshness.

The five-feature benchmark gate is **still closed**. Once all five features work,
run all 30 tasks at low effort, then medium effort, with the same existing session ChatGPT
subscription and exact `gpt-5.6-sol` / `gpt-6-astra`. No live benchmark, model/auth/readiness
probe or publication was performed for this milestone.

## Current prerequisite implementation — W30

The current source extends the five-feature paths with actual official Responses/Codex tool
mapping, conservative replay permission, full-logical cached accounting, ordinary-summary
recovery retention, and explicit destination epoch rebuilding. One compaction owner still
commits recipes and summaries. Imports rebuild lowered TaskFrames and drop copied replay
permission. Copied original usage is preserved; rebuild controls omit duplicated usage.
Schema33/protocol11 is the new source boundary.

Fourteen existing focused cases have passing outcomes across separate compiler2/services2/
selector2/native-Python2/compaction4/RPC2 scopes; type checking passed. The service path retains
genuine recovery through eviction, ordinary summary and same-journal reopening. The compiler
cases exercise real destination rebuilding and native fake-fetch continuation from copied
summaries. Earlier failed diagnostics and repeated invocations remain recorded. This section
does not replace the W29 receipts or retroactively change the W26 audit.

Remaining prerequisite blockers include opaque continuation after prefix-breaking summaries
or rebuilds, complete resource/representation boundaries, and supported deployment profiles.
Covered cached-prefix units cannot be evicted using stale token credit. No portable public-data
renderer is implemented. The benchmark arm now forwards a declared enforced configured-limit
profile; that wiring and its syntax check do not open the no-live-benchmark gate.

## Current prerequisite implementation — W31

W31 adds explicit adapter-permitted public summary windows and owned kernel resource views.
The actual official request must have a supported stateless descriptor, closed groups and an
exact allowed route. Public fallback is a deliberate summary transition before its existing ACK,
not text inserted into opaque fields. V3 recipes preserve canonical originals, user roles and
exact public evidence, including the old retained tail. Reopen/native fork/import rebuilds
source references and cutoff metadata; destination permission is not copied. The next native
send still requires actual final-body budget/projection and epoch acceptance.

Kernel instance identity plus the actual lifecycle counter/state supplies bounded current
provider data. An unchanged capture stays stable; changed state needs an ACK and a stale held
capture refuses before send. Saved/imported revision markers never establish current liveness.
Original concrete readers are bound before callbacks. Managed compaction no longer probes the
namespace or announces survival. No-budget/no-epoch behavior stays unchanged. Schema34/protocol11
is the source boundary. No new resource/body/journal store or model call was added.

Fourteen existing cases pass across separate compiler2/services2/selector2/native-Python2/
compaction4/RPC2 scopes; types pass. Service evidence covers actual opaque tail/public summary,
reopen and native fork/import continuation (six main fake responses plus one summary). Native
Python covers real startup/stability/restart/shutdown/new-owner and stale no-send. The separate
Codex adapter phase covers full public dispatch after prefix loss without old pointer/opaque/
credit. Initial selector fixture and two typing diagnostics, and affected repeats, remain
recorded. This is not an extra set of W29/W30 runs or live provider certification.

The gate remains closed. Unaccepted recovery groups, unsupported media/routes/native modes
and opaque requests without a permitted transition still refuse. Automatic handling of every
prefix-loss/unknown-budget state is not implemented by this explicit-summary milestone. Finish
that source continuation path before opening the five-feature benchmark gate; do not substitute
unauthorized readiness/auth/model probes for implementation. Broader job/artifact/scheduler
freshness, full portable/native modes and deployment certification remain separate backlog.

## Current prerequisite implementation — W32

W32 implements request-time public fallback for supported official Responses/Codex requests.
When ordinary selection cannot admit the native body, the actual adapter may encode whole
completed groups as standalone public data. The same captured source recipes supply the
candidate, final budget, existing canonical ACK and adopted messages. Original users and
policy items remain unchanged. Canonical opaque originals remain archived. The normal
converter and payload hook are not replayed, and no summary model call is added.

V4 records this as a `portable-checkpoint`, not a fabricated summary. Its fixed public-tail
cutoff does not convert later native messages. Native fork/import rebuilds destination refs
and permission remains request-local. Null original input estimates stay null in the same
compaction control and copies; ordinary summary estimates/usage remain unchanged. Direct
prior-token displays label unknown explicitly. Schema35/protocol11 fences these readers.

Fourteen existing cases and type checking pass on their first W32 invocations: separate
compiler2/services2/selector2/native-Python2/compaction4/RPC2 scopes. The service path includes
new opaque output plus genuine recovery, actual request fallback, exact adopted public text,
null original estimate, close/reopen and native fork/import. It uses seven main fake responses
and one ordinary summary. The separate AI-only Codex phase checks every post-callback budget
measurement and the physical fake send for stale credit; its offline acceptance callback is
not claimed as a canonical ACK. Root's service case supplies that actual ownership path.

The five benchmark prerequisites now have working source paths: TaskFrame injection (W26),
closed ViewUnit selection (W29/W30), actual-request conservative model budgets (W27/W32),
stable source-backed epochs (W29/W31/W32), and native selective recovery (W28–W32). After this
coherent source change is committed and built, proceed to the authorized benchmark phase:
all 30 isolated tasks at LOW effort, then MEDIUM, using this session's same existing ChatGPT
subscription and exact `gpt-5.6-sol` / `gpt-6-astra` routes. No early samples or readiness/auth/
model probes are needed. The remaining audit findings are now the post-prerequisite backlog,
not reasons to reopen settled feature work or repeat D/S setup.

Unsupported routes, open groups, media and candidates that still exceed the budget may refuse
explicitly; this is not a promise that every representation can fit. Source/fake-transport checks
do not certify provider behavior, cache hits, tokenizer accuracy, installed platforms or the
full remaining spec. No live benchmark, publication or goal-completion claim is made here.

## Post-prerequisite implementation — W34

The W26 audit above remains immutable. These changes address bounded parts of G01
and G02 after the five supported benchmark prerequisites were completed.

- **G01, command/worker recovery journals:** checked UTF8 writes reuse `writeFullySync`.
  File sync precedes replacement and directory sync follows creation/replacement.
  JSONL v1 remains unchanged. Malformed complete records refuse; a torn final fragment
  exposes only its valid prefix and blocks later mutation until external recovery.
  Uncertain writes retain their original failure. The recovery-local descriptor helper
  retains distinct close errors without changing the canonical helper. Supervisor
  receipt failure prevents dispatch; uncertain result persistence is not retried as a
  conflicting result. Worker checkpoint failures propagate through existing cleanup.
  The ready checkpoint is inside runtime binding cleanup. Orphan journals remain open.
- **G02, conservative resident admission:** one actual live parent owns one pending
  setup or resident child. Native spawn, direct factories and passive hydration reserve
  before awaits and bind the actual constructor. Completed residency still counts;
  successful `disposeAsync` plus setup settlement can release capacity. Unknown startup
  or cleanup does not prove release. Parent disposal joins accepted setup and partial
  children. Same-target hydration joins remain. No copied parent ID grants ownership.
- Child runtime `newSession`, `switchSession`, `fork` and `importFromJsonl` refuse before
  setup until owned replacement is implemented. Main/root replacement is unchanged.
  This is not the full tree-wide/cross-worker scheduler, persistent reservation recovery,
  separate resource budgets or fairness required by §19.2/W10.

Four existing journal cases and two existing real runtime cases with the faux provider
passed in separate first W34 invocations. The required full check passed after correcting
three test-mock overload declarations; no focused case was rerun. These checks do not
certify all daemon fault paths, historical
synthetic/unlimited-sibling fixtures, platform durability or whole-process bounds.
Frozen benchmark packages and runner scripts are unchanged by this source work.

## Completed D/S setup handoff — setup only

The earlier, separately authorized setup is complete and stopped. It is not an outstanding API-key/dependency blocker and is not a benchmark result.

- **D manifest:** `/home/jdabrowski/work/base-context/.work/ds-frozen-layouts-gcnind2s/D/hosts.json`. Runner: `D/external-runner/benchmarks/python-realworld-30/run.py`; template: `D/models.json.template`; receipts/notes: `D/SETUP.md`, logs. The already-started final metadata write completed successfully (`D/logs/07-write-metadata.log`); no further receipt write was made after the stop instruction.
- **S manifest:** `/home/jdabrowski/work/base-context/.work/ds-frozen-layouts-gcnind2s/S/hosts.json`. Runner: `S/runner/benchmarks/python-realworld-30/run.py`; template: `S/models-template/models.json`; receipts/notes: `S/SETUP.md`, `S/setup-output/commands.json`.

Each uses private dependency copies, its unchanged frozen patcher and its own same-package SDK/RPC path. D and S remain distinct; explicit private Astra configuration is not stock-catalog or entitlement certification. No setup job remains. No new CLI, model, auth, provider, kernel or benchmark probe was launched by this audit.

## Bounded completion order

1. Close the active durability/admission/ownership deviations without undoing working native owners or silently changing the frozen generic control.
2. Finish actual provider-budgeted closure selection, committed epochs and selective recovery. Preserve W26's real TaskFrame wiring and stable-prefix/tail policy.
3. Finish scoped migration/retention, true off/shutdown/freshness contracts, and the remaining catalog/skill/job bounds on their existing owners.
4. Correct user-facing identity, public exports and updater activation. Complete owned release/support/intake deliverables with explicit unsupported/unknown scope.
5. Only after the user's five-feature gate and relevant implementation gates, obtain the specifically missing installed/platform/provider/control/accuracy evidence. Keep valid failures, unknown costs and all physical attempts visible. Publication remains separately approval-gated.

These are bounded product tasks, not permission for new audit rounds, proof frameworks, extra artifacts, benchmark samples or speculative provider calls. The functional first-release definition and aggressive optimization promotion gates are **not met at W26**.


## W35 update — native EOF refinement admission

Native RPC EOF closes new opportunistic refinement before pending handlers and idle
drain. Its runtime retains the closed gate across an already accepted session replacement.
Disposal drains accepted refinement and genuine queued explicit `refine.run` requests;
it no longer creates interval/compact reviews, promotes an approved review into new
planning after closure, or recreates a failed background plan for disposal-only retry.
The gate is separate from model-visible skills and explicit refinement eligibility.

This closes the bounded G07 shutdown-admission path, not the full optimizer-off backlog.
Accepted work can still exceed the runner's 30-second grace. No cancellation policy,
generic AgentConnection protocol, model prompt, frozen control or result is changed.
Sol's custom anti-overengineering prompt remains intact. The existing RPC happy/edge
use local-faux native lifecycle phases; six directly contradictory legacy disposal
expectations are aligned. Validation results are recorded in implementation STATUS.


## W36 update — compact provider metadata

New TaskFrame text exposes exact session/entry/field/revision coordinates and the
captured horizon, without internal physical locators or journal paths. Full internal
rows/material/origins, requirements/relations/authority/coverage and source capture
remain unchanged. Matching material reuses frozen text verbatim; destination frames
still rebuild through the destination reducer. Row selection and byte limits are unchanged.

Recovery's provider-facing action unions use equivalent string enums. The strict
input/parser, recovery semantics and canonical ACK path are unchanged. Sol's custom
anti-overengineering prompt and all behavioral text are preserved verbatim. This is
a bounded representation reduction, not a token, speed, cost or new benchmark claim.


## W37 update — explicit request budgets in owned children

Owned native child creation and passive hydration copy the actual parent's explicit
request-budget configuration through existing runtime/daemon factories and the main
creation whitelist. Defined trusted child options retain priority; absence remains
absence. Each child has its own ordinary budget instance. Parent calibration, request
observations, ACK-prefix credit, bodies, resource facts and authority are not inherited.

This is request-policy forwarding, not tree-wide spend scheduling or profile synthesis.
An unprofiled child model remains unknown under enforcement. W34 residency and W35
shutdown admission remain unchanged. Validation scope is recorded in STATUS.

## W38 update — selected skill text admission

Skill discovery now reads at most 16 KiB of raw frontmatter with bounded 1 KiB
read-ahead. Explicit selection captures at most 1 MiB of the complete SKILL.md,
including frontmatter, or rejects. Known selected-file failures emit the existing
skill error and stop the prompt; unknown commands still pass through. The parser,
raw submitted clause, wrapper and actual captured input remain unchanged.

These are local byte limits for §18.3, not complete G09 closure. Aggregate catalog
size, directory traversal, Python module/version lifecycle and global heap/model-fit
bounds remain open. No file-version store or same-size concurrent-write snapshot
guarantee was added. Sol's custom prompt remains unchanged.

## W39 update — retain unreadable orphan tracking

Malformed complete records and incomplete orphan-journal tails now reject the read
as unknown tracking, before owner filtering. The owned frontend retains the journal
and recovery descriptor, attempts its existing uncertain-RPC replies, then rethrows
before any replacement-worker decision. Reaping stays at its original location;
distinct cleanup and reporting errors retain their order. Daemon cleanup also keeps
associated records after a read error. Valid cleanup and signal/identity policy stay
unchanged.

G01 remains open: shared host/kernel writers still lack record-level serialization.
No writer, Python enrollment gate, repair, format or ownership change is included.
The reader remains unbounded in bytes. Detection and retention are not global
durability or complete enrollment guarantees.

## W40 update — selected skill catalog admission

The existing system-prompt path now admits at most 32 visible skill items and
65536 UTF-8 bytes for the exact rendered catalog section. It retains all selected
entries in order or refuses explicitly. The unchanged introductory text, XML fields
and newline separators count toward that limit. Admission occurs before unbounded
escaped-field or complete-catalog assembly; the same captured section is appended
at the existing default/custom prompt location without a second render.

Disabled skills, legitimate empty catalogs and no-file-access gates keep their
existing behavior. Inventory, SourceInfo and session selection are unchanged. This
is not a discovery/inventory, full-system-prompt, wire-envelope, Python module/version
or global heap bound. W38 readers and Sol/custom/behavioral instructions are intact.
G09 remains open for those wider catalog/version requirements.

## W41 update — remove an unimplemented public hooks subpath

Removed the package `./hooks` export and its exact root/example TypeScript aliases.
The tracked source has no corresponding implementation or build generator. The
supported root API and actual ExtensionAPI lifecycle handlers remain unchanged.
The real root-import case exposed a missing exact owned AI `/mcp` loader alias;
it now resolves the published module through the existing workspace/package resolver.
Native AI root sharing stays intact. No hooks facade, legacy subpath or replacement
framework was added; bundled behavior was not inferred from this Node-path result.

This closes that advertised source-surface mismatch only. The other G14/G15 updater,
activation, build and installed-package requirements remain open.

## W42 update — stop self-update after unknown release lookup

Unavailable release metadata now rejects self-update explicitly. Thrown lookup
errors reach the existing CLI error reporter instead of becoming an install plan.
`--force` applies only after a known release result and still permits same-version
reinstallation. Refusal precedes self-installer resolution, daemon probe and restart.
Earlier accepted extension updates remain; no rollback or whole-command no-effects
claim is made.

This closes the G14 lookup-failure fallthrough only. Origin/product/schema policy,
artifact validation and staged CLI/runtime activation or rollback remain open.

## W43 update — release metadata origin boundary

Release metadata fetches now refuse redirects. A configured-base manifest that
advertises a resolved tarball on another origin is unavailable as a whole; the
tarball is not stripped to permit a fallback package install. Existing relative
resolution, same-origin absolute URLs and the normal owned registry path remain.
The current publisher already advertises a relative tarball.

This is only the metadata/advertised-URL boundary. It does not control npm or
artifact-download redirects, add product/schema/integrity validation, or stage, activate
or roll back a CLI/runtime pair. Other G14 requirements remain open.
