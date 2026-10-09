# 1.1.2 review follow-up

> **Release update, 2026-10-09.** See the [release highlights and installation](release-notes-1.1.2.md) and the [curated first-replica results](../../../benchmarks/context-curated-50/README.md). The release comparison uses completed R1: 300 provider-clean outcomes, 148/150 Base artifact passes versus 146/150 Codex, and 150/150 versus 144/150 native completions. Clean failures and passing-artifact timeouts remain in the results. The benchmark methods document the 76 provider-invalid attempts, four interruptions, mixed builds, and cost estimates.
>
> Replica 2 was stopped by the user after 44 selected outcomes. It remains archival and is excluded from release metrics. No native benchmark jobs remain active.
>
> The corrected runtime `694414adb` finishes decoding received WebSocket frames before transport shutdown. Its qualification included 28 focused provider tests, project checks, source build, eight package archives, and native offline CLI/SDK checks. The release adds the R1 publication assets and explicit stable npm opt-in. Earlier full-suite and readiness records below retain their own source revisions. Publication is a separate manual action.

## Earlier qualification and discovery record

> **Local qualification completed 2026-10-08.** Runtime evidence below is tied to `61604d169`. This follow-up does not reinstate any withdrawn comparison.

## Changes and remaining limits

This follow-up addresses the six review requests below. It does not claim a particular rating or complete architecture-debt closure.

| Review request | Implemented changes | Remaining limits |
| --- | --- | --- |
| **1. Repair the suite and gate it in CI.** | Repaired stale fixtures around real lifecycle boundaries. The offline gate covers package suites, eight coding-agent shards and separate heavy groups. CI configuration includes these groups and exact-source release checks. | Qualification scopes are listed below. Known skips and credential exclusions remain. Local passes do not establish a remote green CI run or other-platform support; earlier failed runs remain preserved. |
| **2. Remove duplicate prompt text and prioritize older instructions.** | TaskFrame skips text whose exact source is already visible. Omitted older instructions receive the bounded text allowance first. Replay, ownership and source checks remain. | This covers actual user-source and goal-state producers, not a general-purpose fact extractor. Recovery remains bounded. |
| **3. Make request budgets usable.** | Added a validated settings route and explicit profile example with identity labels, SDK precedence and child inheritance. Observe mode retains a compatible full view when its assessment is unknown or over budget. `retry.maxRetries` now limits product retries. | Settings provide the CLI route; no new `/budget` command is claimed. Selection remains opt-in and depends on the exact provider, model, request layout and profile. This is not generic subscription calibration. Benchmarks that omit `requestTokenBudget` cannot establish selection-ON gains. |
| **4. Lead with the features that ship and report benchmarks honestly.** | The README leads with the persistent Python workspace, retained outputs, instruction pinning across compaction and native workers. All earlier Base Context comparisons are withdrawn; historical numbers remain archival. | Adaptive challenge selection is not representative evidence. Historical Codex controls cannot establish fresh matched timing or cost advantages. Profile-specific outcomes, provider-invalid attempts and incomplete API-rate cost coverage must remain distinct; no universal superiority claim follows. |
| **5. Split large owners and shorten the docs.** | Split compiler orchestration into focused modules, separated large test cases, and extracted epoch handling, action recovery and real goal state/accounting/persistence ownership. Shortened and corrected first-session and budget/settings guides, including model-facing recovery guidance. | `AgentSession` still has roughly 15,000 lines. Further cohesive owner extraction remains useful; how much to include is a release-scope choice. Single-maintainer concentration and upstream integration debt remain. |
| **6. Clean fork leftovers and clarify naming.** | Corrected active launchers, paths, credential helpers, examples and operational recipes. Base Context is the product name. MIT notices and Prime Agent, Pi and Synerise credits remain. | Synerise branding, the BaseModelAI repository and the `@ponythewhite` npm publisher have distinct intentional roles. Upstream attribution and inert historical fixtures remain intact; the existing npm account is unchanged. |

### Compaction and recovery corrections

The runtime now waits for an already-started kernel startup before capturing its resources. Failures after prompt admission are delivered as prompt outcomes instead of leaving a successful acknowledgement without a result. History search excludes the active search call's own arguments without hiding earlier public sources. Model-facing guidance also distinguishes registered-watch waits from child replies and requires exact `provider/model` selectors for explicit child models.

Installed `61604d169` readiness runs on both profiles completed two requested compactions and one whole-container cold restart per run. They retained root and child identities, recovered the required Python state and produced all five required output files. Optional history-reference warnings remain recorded. This is not a guarantee that every Python object can be restored. Stress5 supplies separate evidence from 20 finished compactions and 10 cold restarts across its ten selected runs.

### Qualification scopes

These records belong to separate source revisions. They are **not additive** and are not a fresh full-suite result on the latest candidate.

- **`61604d169`: 27 existing prompt tests passed** for explicit provider/model child-selector guidance, alongside its project checks, normal hooks and clean build.
- **`fe6a511aa`: 44 existing tests passed: 27 prompt tests and 17 watch tests.** These overlap the later prompt-test scope; do not add the totals.
- **`6c2fd6164`: 190 focused startup-correction tests passed.** This is separate runtime evidence.
- **`657865790`: historical 6,359-pass composite qualification.** Preserve its original run boundaries and earlier failures; do not relabel it as a new full run on `61604d169`.

Version 1.1.2 was unpublished when these qualification records were produced. Local artifact and installation checks do not establish remote CI, live public downloads or other-platform support. The benchmark results below retain their own sources, denominators and limitations; they do not change these test scopes.

## Benchmark method

We used two model/effort profiles: **gpt-6-astra / medium** and **gpt-6.1-sol / high**. Stress5 and adaptive multi-stage candidate routes included planned compactions and a container restart. Original30 is functional regression: its native route does not execute stress-only manual-compaction hooks, even where the source scenario carries a `compact_after` flag. No Original30 manual-compaction coverage is claimed. Ordinary scripts, saved files and recomputation were allowed. Each candidate’s contract, stage plan and deadline were frozen before its model outcomes; the overall search remained adaptive. Output scores used five factual groups and a separate edge check.

Runtime evidence used Base Context 1.1.2 at `61604d169`; the exploratory Codex runs used 0.160.0. Both used the existing ChatGPT subscription through `openai-codex`, not substituted API-key providers. Each native task ran in a container limited to two CPUs and 8 GiB. Base used `websocket-cached`; Codex used its WebSocket-first route. Native tools, instructions and auxiliary calls differed, so complete execution parity is not claimed.

Elapsed times run from the first task prompt to native process completion; judging is outside that interval. Each attempt kept its frozen deadline, including through a planned cold restart. Original30 used twice each task's original timeout, not one universal timeout.

The search sought five unique tasks where Base Context passed both profiles and Codex had at least one usable, provider-clean factual or adherence failure. Screening started with Codex Astra. A pass led to Codex Sol; a clean failure opened both Base profiles. Two Codex passes excluded the task. Unrun profiles were not scored as failures.

An observed provider or transport error invalidated the **whole physical attempt**, even if recovery produced a pass. Its evidence and captured costs were retained. Selection used the first provider-clean replacement. Clean task-quality failures were not retried to improve scores. “Provider-clean” means no such error was observed, not guaranteed complete telemetry.

These benchmark runs omit `requestTokenBudget`. They do not measure selection-ON behavior or establish subscription-profile calibration. Qualification is local Linux x64 using native installations and warmed offline caches, not remote CI or live public-download qualification.

## Closed exploratory rolling pool

New task discovery was stopped by the user. All existing frozen rolling routes are now closed or held. The rolling pool contains **48 frozen candidates**: **45 excluded after both Codex profiles passed**, **one not qualified** and **two authoring holds**. **Zero tasks qualified**; the former five-task target was not met. This does not show that qualification is impossible or that either product is universally better.

The pool records **96 physical attempts** and **95 selected RAW outcomes**, including the disputed authoring-hold results. The remaining physical attempt is AP42's provider-invalid first Astra run. RAW selection is not a count of valid comparative failures. D04/E05/F06 reuse earlier batch02 records; they are not additional physical runs. Earlier batch01 used a different exclusion rule and is outside these rolling denominators.

AZ52 finished with both Codex profiles passing 5/5 plus edge. Base remained unrun. The same unrun distinction applies to the other both-Codex-pass exclusions. These exploratory candidate fixtures and records are private working evidence, not newly published public benchmark corpora.

**W23 demonstrates why matching profiles matters:**

| Profile | Codex | Base Context |
| --- | --- | --- |
| Astra / medium | 4/5 main, edge passed | 3/5 main, edge passed |
| Sol / high | Unrun | 5/5 main, edge passed |

The three completed W23 runs were provider-clean. Codex Astra failed the `cascade` group; Base Astra failed `cascade` and `historical_branches`. W23 did not qualify because Base did not pass both profiles. The Sol Base pass has no matching Sol Codex result.

Two tasks remain **authoring holds**, not usable Codex quality failures:

- **AL38:** a `DUP_MODULE` diagnostic-location mismatch between the frozen contract and judge.
- **AN40:** an ambiguous `NAME` versus `RULE` diagnostic for a missing saved named-rule lookup.

Both produced raw Codex Astra scores of 4/5 plus a passed edge. Those records remain preserved, but cannot support qualification. Their other profiles are unrun.

**AP42 Astra attempt 1** recovered from two HTTP 503 `responseStreamDisconnected` errors and scored 5/5 plus edge. It remains provider-invalid. Its first clean Astra replacement and its Sol run both passed, excluding AP42; Base was unrun. The recovered pass did not erase the invalid attempt or its captured costs.

Unadmitted drafts, including AY51 and BA53, have no model outcome. The partial policy-compatibility draft was also never admitted. Materializing a fixture is not a benchmark pass.

## Completed corrected Base-only regression

Collection finished on **2026-10-08**. All **70 planned cells** have selected results: **69 full passes and one partial result**, with **348/350 main checks and 70/70 edges passed**. There were **75 physical attempts**: 70 selected, four provider-invalid and one unscored user interruption. All attempts were collected; no benchmark work remains active.

| Suite | Profile | Full passes | Main checks | Edges |
| --- | --- | ---: | ---: | ---: |
| Stress5 | Sol / high | 5/5 | 25/25 | 5/5 |
| Stress5 | Astra / medium | 5/5 | 25/25 | 5/5 |
| Original30 | Sol / high | 30/30 | 150/150 | 30/30 |
| Original30 | Astra / medium | 29/30 | 148/150 | 30/30 |

Task 11 Astra scored **3/5 main with a passed edge**. That clean quality failure is retained without a reroll. Original30 is functional regression, not manual-compaction coverage. Stress5 completed 60 stages, 20 requested compactions and 10 whole-container cold restarts.

### Selected timing and captured-cost scope

| Suite | Profile | Mean seconds | Median seconds | Priced / captured receipts | Known API-rate subtotal |
| --- | --- | ---: | ---: | ---: | ---: |
| Stress5 | Sol / high | 311.1 | 291.3 | 199/199 | $1.6384 |
| Stress5 | Astra / medium | 272.0 | 274.9 | 185/185 | $7.2066 |
| Original30 | Sol / high | 315.5 | 255.3 | 763/763 | $7.5718 |
| Original30 | Astra / medium | 202.5 | 135.2 | 560/560 | $24.7938 |

The selected runs have **1,707/1,707 captured receipts priced**, with a known API-list-rate subtotal of **$41.2106**. These are modeled rates, not subscription charges or invoices. Complete agent-family cost remains unknown for every selected cell. Timing includes the retained partial result and describes selected runs, not total campaign wall-clock time or a matched Codex comparison. Displayed values are rounded.

Scheduling began with windows of up to four cells. At the user's request, the remaining independent frozen cells moved to a rolling pool of six concurrent physical attempts. A free slot was refilled after collection and cleanup; one slow task no longer blocked the next batch. This changed admission order, not task content, model settings, judges, container limits or deadlines.

### Invalid and interrupted physical attempts

Four first attempts captured typed `WebSocketCloseError` code 1000. They remain invalid even though their raw provider-error flags were false. Native usage diagnostics and event records establish the transport errors; arbitrary tool text was not used to classify them. Each had a separately admitted provider-clean replacement, all of which passed. The raw results and usage remain preserved:

| Attempt | Raw main | Raw edge | Elapsed seconds | Priced / captured receipts | Known API-rate subtotal |
| --- | ---: | --- | ---: | ---: | ---: |
| t13-sol-high / attempt 1 | 5/5 | Passed | 1020.4 | 58/59 | $0.4609 |
| t23-sol-high / attempt 1 | 3/5 | Failed | 312.5 | 24/25 | $0.2120 |
| t27-astra-medium / attempt 1 | 0/5 | Failed | 58.6 | 4/5 | $0.1238 |
| t30-sol-high / attempt 1 | 0/5 | Failed | 182.9 | 8/9 | $0.0989 |

Task 13 Sol recovered to a raw pass; Task 23 Sol failed its last stage; Task 27 Astra and Task 30 Sol failed their first stage. None of these contaminated results is selected as a clean quality outcome. The invalid attempts have **94/98 captured receipts priced** and a separate known subtotal of **$0.8956**. Their complete costs remain unknown, and they are excluded from the selected totals above.

The user-requested reboot pause stopped Task 12 Sol's first physical attempt. It remains unscored and preserved. No result or final native usage summary was produced; that attempt's cost is unknown, not zero. Its separately labeled replacement passed 5/5 plus edge under the same frozen task/profile/time limit. The replacement is a new physical attempt, not a reset of the original clock or a retry of a quality failure. Other completed pre-reboot results were recovered without rerunning them.

After reboot, the same archived `61604d169` / 1.1.2 build was restored through the native offline installer to a durable path. Installed CLI and SDK Python checks passed. Only verified install locations changed in separate configs/specs; original files, tasks, judges, settings, profiles, resource limits and time limits were preserved. This was not a fresh full-suite or readiness run.

## Reporting limits

Candidates were developed and selected during an outcome-driven search, not sampled representatively. Profile routing also depended on earlier outcomes. These observations therefore do not establish population failure rates, product superiority or an unbiased cross-product win rate.

**Earlier public Base Context comparisons remain withdrawn.** Corrected Base results are stand-alone regression observations, not a fresh matched comparison against historical Codex controls. They do not reinstate earlier quality, speed or cost claims.

**Full agent-family cost remains unknown.** Captured API-list-rate subtotals are not invoices or established total spend. Invalid and unselected attempts retain their captured usage separately; they were not free. Complete call/resource parity is not established.

The runtime results are bound to source `61604d169`. Later documentation and release builds have their own source identities; they do not become freshly runtime-tested revisions merely by including these notes.
