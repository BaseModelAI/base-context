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

## W44 update — session-local context mode

`context.mode` now seeds fresh sessions with on/off policy. The external
`AgentSession.setContextMode()` path uses the existing serialized owner and a
qualified policy epoch; committed policy wins on resume. Off retains the current
canonical/public continuation and literal tail, explicit recovery, request/resource
checks, receipts and cancellation. It omits generated TaskFrame/resource overlays
and denies new automatic or manual refine/compact planning. Accepted work drains.
Re-enable is an explicit successor from the retained baseline, not archive replay.
Sol/custom/user/project/harness prompt text is unchanged.

A v5 policy-only epoch is unmeasured (`representation:null`, `tokensBefore:null`),
not a fabricated summary. Its small accepted adapter/route/model/replay contract
stays in that same checkpoint. Only a genuinely fresh off owner may accept its
first actual request contract once, before admission; missing legacy contracts get
no generic grant. The final fixed request uses one real projection and does not
select or learn another working set. Old v1–4 null rules remain unchanged.

This policy is session-local. Newly admitted native children capture parent mode;
existing independently owned children retain their accepted policy. Copy, child,
re-enable and failure handling are source wiring unless separately exercised.
Independent auxiliary model/effort/budget configuration and broader tree scheduling
remain open G07/G08 work; this is not a global toggle or complete G07 closure.

## W45 update — explicit learning model and effort

`autoRefine.model` optionally selects one provider/model ID/effort contract for
both the actual built-in reviewer and planner. Selection is captured before
history/auth waits and uses the existing local registry and configured thinking
level rules. Invalid explicit selection refuses before auth/send, without a
main-model fallback. The same coordinator, purposes, receipts, cancellation and
session budget remain in charge. W44's admission gates and protected prompt text
are unchanged.

The unconfigured legacy path inherits the main MODEL but omits request effort.
The old helpers received thinkingLevel and deliberately discarded it; this was
not wire inheritance of main effort. The new explicit contract reaches both
helpers' real request options. Omitted effort still leaves provider defaults
unknown; it does not establish no reasoning or a cost benefit.

This does not supply independent learning budgets, bridge/semantic configuration,
deployment/entitlement/pricing facts, or complete §18.4/G07. Configured effort
validation is not deployment certification.

## W46 update — root npm publication routing

The root release/publication route checks before one `build:source`, then passes
`--ignore-scripts` to workspace publication. Normal and dry publication routes
match; a failed check stops before build/publication. Standalone workspace
`prepublishOnly` hooks and the R2/private-distribution packer are unchanged.

This closes the root route's redundant lifecycle rebuild seam, not exact tested
tarball staging or installed/platform/publication evidence. The R2 stage rewrites
dependencies to download URLs and is not treated as a registry npm stage.
The two existing command-path cases observe controlled shell routing and flags,
not real npm lifecycle internals, artifact identity or live publication. G15's
remaining release work and publication approval stay open.

## W47 update — daemon catalog request admission

The existing client pending map and worker FIFO now admit at most 32 ordinary
requests and 1 MiB of combined encoded UTF-8 request payload each. Requests are
captured and charged before startup/queue waits; the same detached data is sent.
Admission remains held until response/error/timeout/close or worker-handler
settlement, not merely successful send or progress.

One coalesced 128-byte shutdown control follows accepted work without competing
for ordinary capacity. Stop closes new ordinary admission while it drains; its
existing transport-failure policy and unknown-write outcomes are not converted
into a successful-drain or rollback promise.

This is local encoded REQUEST admission, not whole-catalog paging, scans, cache,
response/progress/IPC buffers, caller memory, heap/RSS or a global aggregate bound.
Those G08 gaps remain open. Two existing cases cover healthy real IPC/full-capacity
shutdown drainage and the real client boundary with mocked startup transport.
Inbound overflow/control and failure/restart branches remain source wiring.

## W48 update — Responses long-retention route default

The Responses request builder now defaults optional `prompt_cache_retention` on
only for the resolved SDK client's exact official OpenAI Responses request URL.
Other routes require explicit `compat.supportsLongCacheRetention: true`; explicit
false still wins on the official route. Provider labels do not establish support.
The existing post-onPayload final request URL/budget checks remain unchanged.

The same two Responses cache cases use controlled pre-fetch stops and a rejecting
fetch stub, instead of sending fake credentials to a proxy. They cover unknown
default omission, retained official-route behavior, explicit opt-in and opt-out.
These are request-builder observations, not live retention/cache-hit/tariff or
deployment certification. Completions/Anthropic defaults, affinity headers and
the remaining G05 profiles/replay/capability gaps are unchanged.

## W49 update — per-kernel Bash handle admission

The existing Python `_live_handles` set and lock now admit at most 32 live or
unresolved Bash handles before shutdown-hook, pipe, process or worker setup.
Normal release uses actual group/job absence and existing watcher, reader and
worker settlement. Returned results, leader exit and delivered kill requests do
not release capacity. Completed caller-owned results remain readable.

Uncertain cleanup can retain admission until kernel exit. No reset, extra
registry, polling process or reaper was added. Shutdown skips records without
current signal authority, but keeps its original post-spawn cleanup while a
constructor finishes. G01 journal writers/enrollment and the pre-execution gate
are unchanged. This is a local handle-admission limit, not a descendant-process,
caller-retained output, heap/RSS or successful-shutdown bound.

Two existing cases retain their original phases and add 33 healthy completions
with real reuse, and 32 real handles held at existing worker exit with excess
refused before setup effects, followed by genuine settlement/reuse. Windows and
cancellation/failure/shutdown branches remain source-only; no extra fault matrix
or full G08/G01 closure is claimed.

## W50 update — explicit release manifests require package identity

A configured private download manifest must name the active package through its
existing `package`/`packageName` field. Missing identity now makes the whole
release unavailable before choosing its tarball; it is not treated as the current
product. The existing release producer already writes `package`, so its manifest
format is unchanged. The owned npm registry lookup keeps its existing behavior.

The same manifest happy/refusal cases cover the new missing-identity refusal
while retaining relative/absolute same-origin, registry, wrong-product, redirect
and cross-origin phases. This is metadata admission through a controlled fetch,
not artifact-content, schema/platform compatibility, activation/rollback or full
G14 certification. No new integrity mechanism was added.

## W51 update — doctor reports owned native epoch metadata

The local doctor report no longer says native context is unimplemented. Its
existing string field now uses the actual exported request/policy epoch renderer
identifiers, and the existing text formatter shows the same metadata. This does
not query a model, load credentials or establish session/runtime readiness.

The product-isolation checkpoint now names the actual current protocol 11/schema
36 contract, rather than its old protocol 9/schema 28 checkpoint. Frozen W32
benchmark artifacts still use their own schema 35; they are not changed.

The same two doctor cases retain owned paths, credential-value exclusion and
invalid legacy-root refusal. The happy case additionally observes native epoch
metadata and the real text formatter. No installed CLI, deployment or whole G13
certification is implied by this local metadata correction.

## W52 update — native benchmark capacity authority

The selected host package identity is cross-checked against the existing admitted
package metadata. Native capacity invalidation requires an existing parsed settled
physical receipt with `capacityConfirmed: true`; RPC-only or legacy assistant
markers cannot exempt a native attempt. Missing native accounting does not restore
RPC authority or imply zero work. H/legacy retains its prior RPC-or-aggregate rule.

RPC markers remain explicit `rpc_capacity_observed` observations with their errors.
An exceptional attempt with no returned RPC observation records null. Existing
judging, retained attempts, first-valid-primary selection, retry allowances, time
and known/unknown costs stay on their original paths. No completed output or
frozen H/D/S host, layout or external runner is rewritten or reclassified.

This closes the native runner's capacity-authority seam, not all G17 metadata or
receipt coverage. Selected-host metadata checking is source wiring; the two
existing cases use mocked selected hosts/RPC/judges and actual native receipt
parsing through the runner/attempt/case path. They do not establish live provider
receipt production, installed artifact identity, billing or publication readiness.

## W53 update — bounded retained session-info cache

The existing derived `sessionInfoCache` Map now retains at most 256 entries and
4MiB encoded key/stat/info metadata. Null results count too. Encoding is bounded
before retention cloning; the byte metric projects created/modified Date values
to ISO strings, while the stored and returned metadata retains real Date/types.
This is not a heap/RSS limit. Hits become recent; only oldest derived cache entries
evict. Byte usage is summed from this bounded Map, preserving the existing stale
file deletion path without another accounting store.

Actual reads detach retained metadata from callers. A hit-copy failure removes
cache ownership before returning the complete old value. Oversized, unencodable
or uncloneable successful scans return unchanged and uncached, never clipped or
replaced by an empty list. Missing/stat/null behavior and the existing size/mtime
snapshot rule remain. Same-size/mtime edits, scans, paging, IPC/output, other
caches, transient/caller-held values and full G08 remain outside this local bound.

## Post-prerequisite implementation — W54

This closes one further G17 metadata seam, not all receipt/accounting coverage.
The existing native request events gain an optional descriptive `contextEpoch`
reference containing the session ID and exact accepted epoch entry ID. The
compiler retains that ID only beside its already-qualified checkpoint. Actual
selection/fixed preparation returns either that retained reference or the entry
ID returned by the new epoch/first off-mode compatibility ACK. A source frontier,
public/copied IDs, an unrelated purpose or a latest-leaf lookup is not a substitute.

The coordinator copies the accepted reference when the physical attempt is
admitted. Its existing transient attempt tracking retains the reference for that
attempt's settlement; later source changes cannot replace it. No second owner,
receipt store, history scan, descriptor budget/effort copy, profile promotion or
new selection/replay authority is introduced. Original source capture, purpose,
ACK/adoption/send order, resource checks, cancellation and error handling remain.
Unsupported/unmanaged or unrelated auxiliary contexts remain unassociated.

Two existing offline cases exercise the actual native service/canonical fake-SSE
path with new/retained references and a late ordinary source entry, plus the
existing unmanaged/child/auxiliary coordinator boundary. No provider call or test
case is added. This is not live provider, installed/platform, complete lifecycle,
billing or whole G17 certification. Frozen benchmark artifacts/runners and prior
results are unchanged. Sol and other protected instruction text remain unchanged.


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

## W74 / G11 — explicit natural-turn continuation control

The native AgentSession natural-stop producer uses typed continuation outcomes on
the existing Agent/agent-loop callback path. Only `continue` authorizes another
model turn. `wait_for_owned_work`, `finish` and `cancelled` end this low-level
invocation. Descriptive `turn_end` events and message bodies do not gain control
authority. The existing array callback retains its generic behavior when no typed
owner is bound; a bound typed owner is not followed by a second callback invocation.

Goal/autonomous policy and limits are unchanged. An actual outstanding goal
deferral becomes `wait_for_owned_work` only when no existing continuation wins.
Existing descendant settlement/terminal-notice delivery and the single goal-resume
owner remain responsible for wakeup. Waiting is not a self-quiescence await,
conversation polling, job cancellation or a new scheduler/registry. A final response
and unfinished owned work remain separate facts.

The original session/source and input-pump owner govern work across awaits. Accepted
goal bookkeeping stays with its source, without requalifying it as native admission.
Stale control cannot select a replacement's next turn or roll back a new goal.
Existing stop-hook precedence, finalized tool results, all-tools terminate handling,
steering/follow-up ordering, primary failures and cancellation/disposal/EOF owners
remain in place. The result type does not make a second aborted assistant or hide
an accepted write/late failure.

The compaction/checkpoint producer is unchanged; no unused
`checkpoint_then_continue` state is claimed. Shared workspaces, a whole job registry,
strong descendant lifecycle drains, all G11 outcomes and global efficiency gains
remain outside this bounded change. No new provider call, auxiliary budget default,
wire message, journal, index, kernel/bootstrap, epoch or queued-action format is
introduced. Schema44/min44 (`protocol-11-schema-44-turn-outcomes`) fences loaded
native workers with older continuation behavior; protocol11 is unchanged.
W72 auxiliary-budget defaults remain unapproved and untouched.

The existing autonomous command result/abort and mutable gate-bookkeeping retention
limits remain. This change does not add a durable command-result registry or claim
complete output retention on stale/cancelled paths. Existing process settlement,
orphan tracking and primary lifecycle errors are not converted into harmless finish
outcomes. The existing goal-resume write/admission/compensation body reuses the same
scoped ownership capture; its scheduling and wakeup policy are unchanged.
The existing callback-abort race can finish the low-level invocation before the
callback itself settles. No new all-callback drain or complete late-error visibility
guarantee is claimed by these outcomes.

The two agreed existing offline selectors passed first on actual Node22.12 through
project tsx/package Vitest in fresh six-variable, network/PID-isolated environments.
The persisted native-goal path (PID4006647,5.029995028162375s,
1passed/42skipped) exercised real SessionManager/AgentSession/Agent/loop with the
existing Faux provider and ipython host bridge. It observed typed
continue/continue/finish, no legacy callback invocation, unchanged response counts,
qualified goal creation/completion and ordinary unqualified bookkeeping. This is
an actual native producer-to-loop fixture, not a live provider or kernel run.

The completed-turn abort case (PID4006652,2.1680260528810322s,
1passed/34skipped) left the typed callback pending, ended on abort, then released
its late continue result. It retained exactly one completed assistant/agent_end,
one model stream and no legacy fallback, second assistant or extra input. No new
case, suite, matrix or harness was added. Real descendants, wakeup replacement,
all concurrent goal/state changes and process-crash behavior have source-review
scope here, not a separate runtime certification.

Required `npm run check` passed first (PID4006658,5.189717738190666s;
1046files/no fixes, types, installer/browser). There were no failing checks/cases,
source corrections or focused reruns. No provider, benchmark, user-session migration,
installation or publication run occurred. The existing command-result retention
and callback-abort limits remain explicit. W72 defaults are still unapproved;
whole G11 completion, current-native gains and overall goal completion are not
claimed.

## W75 / G11 — explicit checkpoint-to-resume ownership

The native compatible-turn checkpoint producer carries explicit control through
the existing Agent/loop stop, accepted compaction and post-compaction input-pump
settlement. Its resume directive identifies interrupted tool work and existing
accepted actions/tickets rather than last-message role, payload presence or array
membership. The existing generic boolean stop hook and W74 natural continuation
callback retain their distinct positions and behavior; no duplicate callback call
or unused checkpoint variant is added to the natural-stop hook.

The native producer honors the loop's finalized all-terminate decision and the
existing context-optimization admission gate. A terminating tool batch alone does
not authorize another model request. Automatic threshold work does not stop/queue
while optimization is off or a pending transition closes that gate. Separately
accepted goal/autonomous/input work and previously accepted explicit compaction
requests keep their existing authority. Ordinary completed-turn compaction without
more work still finishes. This fixes the identified native control mismatches;
the lookup finding itself was source evidence, not a runtime failure receipt.

The current compaction sink/epoch append remains the only checkpoint ACK owner.
The intent is not an ACK, and the legacy auto-compaction boolean is not a success
receipt. Success resumption follows owned ACK/setup/release. Known committed
checkpoint plus later setup/release error remains distinct, with pump suspension
and no second summary or automatic resume. Recoverable skipped/ordinary failed
requested/threshold compaction retains its existing interrupted/queued-work resume
policy; absence of an ACK does not assert absence of a write. Abort does not resume;
overflow retains its separate one-retry owner.

Captured manager/session/file, branch/pump ownership and actual action consumption
carry the directive through waits. Queued inputs go first; a real input invocation
that takes the interrupted boundary cannot leave a stale extra continuation.
Missing or released action data alone does not establish successful delivery.
Existing settlement identity, action-commit fence, finalization, serialized refine,
manual save/reschedule/cancel, EOF/disposal and headless-idle owners remain. No wait
for the current invocation's own idle barrier, new queue/registry, converter,
summary engine, model call, quota or persisted resume protocol is introduced.

The adjacent threshold bookkeeping reuses W74's scoped goal/autonomous ownership.
Its accepted autonomous command-output and callback-abort limitations remain; no
new result store or all-callback-drained guarantee is claimed. The related compaction
guide now uses owned identity/settings and distinguishes native capture, resident
legacy fallback, nullable estimates, context.mode and runtime uncertainty.

Schema45/min45 (`protocol-11-schema-45-checkpoint-transitions`) fences older loaded
native workers. Protocol11/history-index16/kernel4/bootstrap11, accepted epoch and
queued-action formats are unchanged. Pending checkpoint intents remain transient;
no cross-restart recovery, whole G11 completion or current-native gain is claimed.
W72 auxiliary-budget defaults remain unapproved and untouched.

Five other existing private-interface fixtures are maintained with the same
scenarios after removal of the old boolean/zero-argument scheduler assumptions.
This is fixture maintenance, not five new scenarios or five extra executed cases.
The two agreed real-path selectors remain the focused runtime scope.

Focused validation used actual Node22.12, the isolated six-variable environment,
network/PID/proc isolation and the package Vitest runner. The existing real skip/
resume case passed in the first two-case run (4029294); it was not rerun. The happy
case initially failed its new order assertion. The first observer counted
`Agent.continue()` method entries rather than actual run admission. Switching to
raw `agent_start` still showed intent/resume/ACK. A bounded same-case diagnostic
(4033863) then recorded a threshold skip (`Session is too short to compact — try
again once it grows`) followed by overflow compaction, not success-first threshold
compaction. No production control failure or busy-return cause was inferred from
the original method-entry trace.

A prior completed canonical user/assistant pair alone was insufficient (4034293).
Source inspection found that `prepareViewCompaction` with keepRecentTokens1 hits
the last tool result, finds no following eligible cut, and uses the earliest cut.
The same happy fixture now has a larger completed prefix, keepRecentTokens10001
for its 10000-token-estimate tool result plus call, and a 12000-token model window.
It still uses the actual big tool, canonical ACK, extension summary and native
loop; no extra model call, case or harness was added. The strict
intent → canonical ACK → actual run-admission order is unchanged.

The affected happy-only run4036149 passed (1pass/9skip, 4.698449845192954s). Required
check4036154 passed (5.016415226040408s, 1046files/no fixes, types, installer and
browser checks). Earlier failure receipts4029294/4031979/4033863/4034293 and passing
checks4029299/4031984/4034298 remain in the work logs. Post-integration corrections
were fixture-only; the production candidate did not change. Five existing
private-interface fixtures were maintained but not executed as extra cases.

These cases do not certify real-provider summarization, all lifecycle races,
installed binaries, crash recovery or platforms. No new provider/benchmark/install/
publication approval is implied. W72 remains a separate pending policy decision;
the overall objective remains active.

## W76 / G06,G20 — existing lifecycle view retained

The bounded source trace found no change needed. The existing owned kernel
lifecycle capture reaches native context with stale-generation checks. Bash busy
flags and recorded command/task evidence are not promoted into process availability.
This does not establish a complete live job inventory.

## W77 / G08 — release cancelled Bash waiters

`BashHandle._wait` now removes its own completion callback under the existing lock
when the await exits. Previously a cancelled background await retained its future
and event loop through that callback until the command finished. The existing
2MiB head/tail output buffer and 32 live-handle admission limit already apply;
neither prevented this waiter retention.

Two existing Python cases passed first (4043706): completion/later-await returns
the same result, and cancelling a released-handle await removes its callback while
the command remains live. Required check4043788 passed: 1046 files/no fixes, types,
installer and browser checks. The cases used the existing project Python environment
and fresh six-variable, network/PID/proc-isolated state. No corrections or reruns.

No new queue, limit, status producer or wire/state format is introduced. Callbacks
already handed to completion or the event loop are not promised drained by this
change. This is not a global memory bound or measured efficiency gain. W72 budgets,
live benchmarks, installation and publication remain outside this change.
