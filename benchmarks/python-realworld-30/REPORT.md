# Paired MEDIUM benchmark: frozen results

**CURRENT: 90/90 terminal strict passes. Vanilla: 87/90.**
CURRENT used **2 benchmark retries**, versus **26** for vanilla.
Across **all effective attempts**, CURRENT used **7.2953 cumulative attempt-hours**, versus
**9.6188** for vanilla: **24.16% less**. Attempt-minutes per terminal strict pass were
**4.8635 vs 6.6337**, or **26.68% less**.

These are harness-to-harness results for 30 tasks × 3 models × 2 harnesses:
**180 cells and 208 effective attempts**. Every failed attempt and retry is charged.
This is a fixed historical reference, **not a new benchmark of release 1.0.0**.
A strict grading pass is not the same as a runtime-clean result.

## Whole-workload comparison

| Metric | CURRENT | Vanilla |
| --- | ---: | ---: |
| First-primary strict passes | 89/90 | 87/90 |
| Terminal strict passes | 90/90 | 87/90 |
| First-primary runtime-clean outcomes | 89/90 | 65/90 |
| Terminal runtime-clean outcomes | 89/90 | 65/90 |
| First-primary strict **and** runtime-clean | 88/90 | 64/90 |
| Terminal strict **and** runtime-clean | 89/90 | 64/90 |
| Benchmark retries | 2 | 26 |
| Charged attempts | 92 | 116 |
| Cumulative lifecycle attempt-hours | 7.2953 | 9.6188 |
| Lifecycle attempt-minutes / terminal strict pass | 4.8635 | 6.6337 |
| Whole API-equivalent cost | UNKNOWN | UNKNOWN |
| Known API-equivalent USD subtotal | $42.789102136 | $58.690350868 |
| Attempts with complete whole-cost accounting | 88/92 | 104/116 |

The time comparison uses the whole workload, not a matched-clean-success subset.
The efficiency denominator is each harness's terminal strict-pass count, including
strict passes with runtime errors. It is not a mean duration over successful attempts.
Runtime-clean outcomes can still fail grading; do not call those clean completions.

## By model and harness

In the next table, `strict / clean / both` reports separate counts, each out of 30.
`clean` means runtime-clean, not necessarily correct. Time includes every attempt.

| Model | Harness | First: strict / clean / both | Terminal: strict / clean / both | Retries | Attempts | Attempt-hours | Attempt-min / strict pass |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| astra | current | 30 / 30 / 30 | 30 / 30 / 30 | 0 | 30 | 1.6373 | 3.2745 |
| astra | vanilla | 30 / 19 / 19 | 30 / 19 / 19 | 11 | 41 | 2.9315 | 5.8629 |
| deepseek | current | 30 / 29 / 29 | 30 / 29 / 29 | 1 | 31 | 2.9304 | 5.8609 |
| deepseek | vanilla | 29 / 27 / 27 | 30 / 27 / 27 | 3 | 33 | 3.2004 | 6.4008 |
| sol | current | 29 / 30 / 29 | 30 / 30 / 30 | 1 | 31 | 2.7276 | 5.4552 |
| sol | vanilla | 28 / 19 / 18 | 27 / 19 / 18 | 12 | 42 | 3.4869 | 7.7487 |

## Cost: known subtotals, not a whole-cost saving

**Whole-workload cost is UNKNOWN: 16 of 208 attempts lack complete accounting.**
The known subtotals below include available priced activity from incomplete attempts.
Missing usage is not free. A successful retry does not repair missing primary cost.
Do not divide the subtotal difference by one subtotal and call it a campaign saving.

| Model | Harness | Known USD subtotal | Complete-cost attempts | Whole cost |
| --- | --- | ---: | ---: | ---: |
| astra | current | $18.412900000 | 30/30 | $18.412900000 |
| astra | vanilla | $30.152550000 | 38/41 | UNKNOWN |
| deepseek | current | $3.237592536 | 28/31 | UNKNOWN |
| deepseek | vanilla | $3.553734468 | 26/33 | UNKNOWN |
| sol | current | $21.138609600 | 30/31 | UNKNOWN |
| sol | vanilla | $24.984066400 | 40/42 | UNKNOWN |

USD is an **API-equivalent estimate**, not subscription cash charges or a verified
provider debit. The fixed [price profiles](api-price-profiles.json) use OpenAI
standard Sol/Astra rates with the specified long-input scaling, and DeepSeek
peak-normalized rates. They are a snapshot, not a promise about future prices.
The public export contains price profile IDs, numeric subtotals and coverage, not
provider receipts, request attribution, response bodies or credentials.

## Timing and compaction instrumentation

- **Agent active-attempt time:** from just before the first stage is sent through
  RPC interaction and graceful host drain. It excludes earlier setup and later
  collection, cleanup and judging.
- **Lifecycle active-attempt time:** from workspace setup through RPC, cleanup,
  collection and judging/log writing. It excludes final result serialization.
  This is the basis of the headline attempt-hours.
- **Terminal elapsed span:** first-primary start to selected terminal end. It
  includes inter-attempt deferred queue waits and the retained restart chronology.
  It is not pure active execution, and does not imply success or a clean runtime.
- These are wall-duration observations, **not CPU time or provider latency**.
  Overlapping attempts mean summed hours are **not campaign wall time**.
  All 208 effective attempts have both active timing fields. Missing values would
  remain UNKNOWN and would not be filled with zero.

| All-attempt metric | CURRENT | Vanilla | Observed-attempt coverage |
| --- | ---: | ---: | --- |
| Session compaction entries (E) | 893 | 28 | 92/92 CURRENT; 116/116 vanilla |
| Observed RPC compaction completions | 60 | 28 | 92/92 CURRENT; 116/116 vanilla |
| Observed RPC compaction failures | 0 | 53 | 92/92 CURRENT; 116/116 vanilla |
| Explicit compact RPC requests | 51 | 81 | 92/92 CURRENT; 116/116 vanilla |
| Recorded child sessions | 0 | 0 | 92/92 CURRENT; 116/116 vanilla |
| Collected sessions, including roots | 92 | 116 | 92/92 CURRENT; 116/116 vanilla |

**E includes CURRENT working-set materializations. It is not an LLM-summary count.**
Session compaction entries and observed RPC events measure different things.
RPC completion/failure counters cover main-loop `compaction_end` observations;
trailing drained events are not included. A completion has neither `aborted` nor
`errorMessage`; a failure has one of them. Explicit request counts cover only
benchmark-sent `compact` requests, not automatic/internal requests. Zero observed
RPC events does not establish zero internal compactions.

Actual subagent spawn calls were **not measured**. All-UNKNOWN spawn columns are
omitted. Recorded child sessions are zero, but that does not establish zero spawn
calls, failed spawns, or unrecorded children. Sessions are deduplicated within each
attempt's collected session root, then summed across attempts. Diagnostic/report
agents are outside this scope. Session totals are not unique campaign-agent counts.

## Method and selection rules

The [30 checked-in Python tasks](tasks.json) use staged inputs and external,
deterministic judges. Task prompts, tools, models, deadlines and price profiles
are fixed across harnesses. Neither solver sees judges or future stages. Each
attempt has an isolated workspace, HOME, settings, sessions and RPC process.
The neutral `bash` adapter is the same for both arms. Inner tool commands have
loopback-only networking. The outer RPC process can reach the selected provider.
Neither arm uses the `ipython` tool. Task solutions and fixtures use the Python
standard library.

- **Strict pass:** judge status `pass`, progress level 5, and no capacity invalidation.
- **Runtime-clean:** explicit null runtime error, `capacity_invalid` false, and
  zero recorded compaction failures.
- **Strict + clean:** both rules hold on the selected attempt.
- **First-primary:** always attempt 1, even when invalid or unclean. There is no
  first-capacity-valid promotion.
- **Terminal:** the sole retry when present; otherwise the primary. It is never
  the best attempt. A worse retry is retained. This explains why Sol vanilla's
  strict count drops from 28 to 27.
- **Retry:** a non-strict or runtime-unclean cell may receive at most one deferred
  benchmark retry. Capacity invalidation consumes that allowance. SDK/provider
  recovery inside an attempt is distinct and stays charged inside that attempt.
- **All-attempt totals:** primary plus any retry, including failures. Terminal
  timing/cost totals never discard the failed primary.

The original dispatcher used six independent sequential queues, one per
(model, harness), with at most one active attempt per queue and six globally.
Each queue processed tasks 1–30. Deferred retries followed all original primaries.
The reference has the explicit restart/amendment exceptions below.

## Historical pins and chronology

| Component | Recorded value |
| --- | --- |
| CURRENT SDK, Sol and Astra | `84a7e6f30625247aa153ed8fdb0d40c4981c4632` |
| CURRENT SDK, DeepSeek | `077f463424f8eb94f07dc2c6325db0feaba363cd` |
| CURRENT package version at measurement | `@ponythewhite/base-context@0.1.0` |
| Vanilla, all models | `prime-agent@0.9.4`, separate accounting-only instrumented host |
| Accounting patch | `prime-agent-0.9.4-cost-accounting-1` |
| Corrected task 15/27 judges and runner revision | `86429a34362e3125679812e129c9fd5d6b6001d8` |
| Runtime | Linux, Python 3.12, Node 22.12.0, Bubblewrap |
| Sol | `gpt-5.6-sol`, logical MEDIUM |
| Astra | `gpt-6-astra`, logical MEDIUM |
| DeepSeek | `deepseek-flash`, logical MEDIUM mapped to native `high` |

1. The original reference ran all model/harness queues. A later **DeepSeek-only
   restart** replaced both DeepSeek arms, starting from task 1 with corrected
   CURRENT SDK `077f463…`. The original Sol/Astra cells and actual retries were
   retained on `84a7e6f…`. The same instrumented vanilla host was used.
2. The old **70 DeepSeek attempts** (60 primaries + 10 retries) were discarded
   from reference statistics, not deleted. Retained OpenAI retries followed the
   original 180 primaries, not all valid primaries in the merged reference.
3. Judges for tasks **15 and 27** were corrected to accept the declared executable
   package layout as well as a module file. All **12 cells** for those tasks
   (3 models × 2 arms × 2 tasks) were freshly run with corrected judges. Their
   12 primaries preceded their own 3 retries: **15 fresh attempts**.
4. Those fresh cells replace **16 superseded attempts**. The other **168 cells**
   retain their chronology. The resulting effective reference is **208 attempts**.
   Original submissions were not regraded; their behavioral correctness remains
   unknown where the old layout check blocked execution.

This is **not one fresh all-180 campaign**, nor one CURRENT SDK revision across all
models. Old raw artifacts and frozen originals remain private and unchanged.
The stock patch adds accounting observation only; it does not replace stock solver,
prompt, transport, compaction or recovery policy. Both arms use the existing native
SDK RPC path. Expected effort mapping is configuration, not measured wire proof.

### Historical fees outside the effective reference

| Excluded history | Attempts | Known API-equivalent USD subtotal | Whole cost |
| --- | ---: | ---: | --- |
| Discarded original DeepSeek | 70 | $6.252026232 | UNKNOWN |
| Superseded task 15/27 cells | 16 | $10.916280276 | UNKNOWN |

These fees are separate historical activity, **not part of the 208 effective
attempts**, their efficiency ratios or their known-cost subtotals. Per-arm/profile
values are in [historical-fees.json](results/historical-fees.json).

## Public files and reproduction

- [180 detailed rows, Markdown](results/cells.md) and [CSV](results/cells.csv),
  sorted by task, model, harness. CSV retains full numeric precision and coverage.
- [208 attempt rows, CSV](results/attempts.csv), sorted by task, model, harness,
  attempt. Strict and clean flags remain separate.
- [Aggregate JSON](results/summary.json) and [historical run pins](results/reference.json).
- [Clean-checkout instructions and executable scripts](REPRODUCE.md).

Exports use an explicit numeric/status/profile allowlist. They omit raw result
objects, sessions, prompts, model outputs, RPC/provider payloads, error bodies,
receipt attribution, auth commands, environment snapshots and private paths.
JSON null and CSV/Markdown UNKNOWN mean unmeasured or incomplete, never zero.
The CSV `completed` flags mean a result record exists, not a clean completion.

A new run can replicate this **method**, not the exact provider outputs or the
historical restart timing. Provider behavior is stochastic and model availability
can change. The latest npm SDK does not exactly reproduce the mixed `84`/`77`
reference. Do not run the known-bug `84` SDK on DeepSeek to reconstruct discarded
work. This small fixed corpus does not establish results for all coding tasks.
