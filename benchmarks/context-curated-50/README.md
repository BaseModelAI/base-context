# Curated 50-task benchmark

![Base Context has 27–39% lower mean attempt time in these three matching profiles, with near-ceiling artifact scores. This is a curated comparison, not a general ranking.](../../packages/coding-agent/docs/images/benchmarks/curated50-overview.svg)

**Less time on these workflows, with strong artifact scores.** Base Context's mean attempt time was **27.1%, 37.3% and 38.7% lower** than Codex's at the three matching model/effort profiles. Full artifact passes were **148/150 vs 146/150**. These are descriptive results on a curated, outcome-informed task set, not evidence of general superiority or a particular mechanism's effect.

This page reports only **50 tasks × 3 profiles × 2 products = 300 selected attempts**, 50 per group. It retains all six clean failures and all six native timeouts. Cost estimates include missing captured costs for both products, with known subtotals and estimated additions shown separately.

[Machine-readable summary](summary.json) · [Time](#mean-attempt-time) · [Quality](#artifact-quality) · [Cost](#estimated-cost-per-task) · [Methods](#methods-and-limits) · [Reproducibility](#reproducibility)

## Mean attempt time

![Mean attempt time in minutes, including clean failures and native timeouts.](../../packages/coding-agent/docs/images/benchmarks/curated50-time.svg)

| Requested model / effort | Base Context mean | Codex mean | Base mean reduction |
| --- | ---: | ---: | ---: |
| `gpt-6-astra` / medium | 508.43 s (8.47 min) | 697.18 s (11.62 min) | 27.1% |
| `gpt-6.1-sol` / high | 606.40 s (10.11 min) | 967.36 s (16.12 min) | 37.3% |
| `gpt-6.1-sol` / xhigh | 908.06 s (15.13 min) | 1,481.28 s (24.69 min) | 38.7% |

The primary time measure is the arithmetic mean of **all 50 selected attempt durations per group**, from first prompt through native attempt termination. It includes staged work, compaction/reopen time, clean failures and deadline-limited timeouts. Preparation/startup and post-run judging are outside this elapsed-time measure. Reduction is `1 − Base mean / Codex mean`, not an average of task-level speed ratios or a throughput result.

**A different, descriptive subset:** 144 matched task/profile pairs fully passed artifact judging on both products. In 141 of these, both native attempts also completed. Base was faster in **128 pairs**, Codex in **13**, with no ties. The other three pairs had passing Codex artifacts but a native timeout. Those three are excluded only from this completed-pair comparison, **not** from the primary means. This subset is not a 128/150 win claim.

## Artifact quality

![Mean judge progress scores, full artifact passes and main-check accuracy.](../../packages/coding-agent/docs/images/benchmarks/curated50-quality.svg)

| Model / effort | Product | Full artifact passes | Mean judge progress / 5 | Main-check accuracy | Native completed |
| --- | --- | ---: | ---: | ---: | ---: |
| Astra / medium | Base Context | 49/50 (98%) | 4.96 | 98.8% | 50/50 |
| Astra / medium | Codex | 50/50 (100%) | 5.00 | 100.0% | 50/50 |
| Sol 6.1 / high | Base Context | 50/50 (100%) | 5.00 | 100.0% | 50/50 |
| Sol 6.1 / high | Codex | 49/50 (98%) | 4.96 | 98.8% | 50/50 |
| Sol 6.1 / xhigh | Base Context | 49/50 (98%) | 4.96 | 99.6% | 50/50 |
| Sol 6.1 / xhigh | Codex | 47/50 (94%) | 4.84 | 96.8% | 44/50 |

- **Full artifact pass:** all five main checks and the edge check pass. This does not require native completion.
- **Mean judge progress:** average judge-reported `progress_level`, on a 0–5 scale. It is not the average number of passed checks. For example, F06 Base/xhigh passed four main checks but not its edge check and received progress 3.
- **Main-check accuracy:** passed main checks divided by 250 per group. Edge checks are not included in this percentage.

The scores are near ceiling. The small gaps are descriptive; no significance or population-level claim is made.

### Failures and timeouts stay visible

All six provider-clean artifact failures remain in the reported groups. None was rerolled for quality.

| Adaptive task | Product / profile | Native status | Main checks | Edge | Progress / 5 |
| --- | --- | --- | ---: | --- | ---: |
| F06 | Base / Sol xhigh | completed | 4/5 | fail | 3 |
| I09 | Codex / Sol xhigh | timeout | 0/5 | pass | 1 |
| AB28 | Codex / Sol xhigh | timeout | 4/5 | fail | 3 |
| AG33 | Base / Astra medium | completed | 2/5 | pass | 3 |
| AG33 | Codex / Sol high | completed | 2/5 | pass | 3 |
| AT46 | Codex / Sol xhigh | timeout | 3/5 | fail | 3 |

All **six native timeouts** were Codex/Sol xhigh: I09, Y25, AB28, AD30, AT46 and AW49. Y25, AD30 and AW49 fully passed artifact checks at the deadline. I09 had a 5,400-second deadline; the other five had 2,700 seconds. Observed durations are about 0.1 seconds beyond these deadlines. Their available artifacts were judged without converting a timeout into native completion. The failure and timeout counts overlap; they are not twelve distinct failed attempts.

## Estimated cost per task

![Estimated mean cost per task and Base savings, including missing-cost estimates for both products.](../../packages/coding-agent/docs/images/benchmarks/curated50-cost.svg)

| Model / effort | **Base estimate / task** | **Codex estimate / task** | **Base saving / task** | **Base saving** |
| --- | ---: | ---: | ---: | ---: |
| Astra / medium | **$3.325** | **$3.668** | **$0.343** | **9.3%** |
| Sol 6.1 / high | **$0.753** | **$0.836** | **$0.082** | **9.8%** |
| Sol 6.1 / xhigh | **$0.948** | **$1.161** | **$0.213** | **18.3%** |
| All profiles | **$1.675** | **$1.888** | **$0.213** | **11.3%** |

**Both sides include an estimate for their missing captured costs.** Base's missing usage is imputed from comparable priced requests. Codex's known token counts with missing model identities are priced at the requested profile model. The main figures are estimates under these assumptions, not recovered measurements. The All profiles row divides each product's estimated total by 150; it does not average the three savings percentages.

Estimates cover captured requests for all 50 selected attempts per product/profile, including clean failures and timeouts. They use API list rates, not subscription charges or invoices. Completely uncaptured work remains outside both estimates.

### Supporting components

| Model / effort | Base known / task | Base added estimate / task | Codex known / task | Codex added estimate / task |
| --- | ---: | ---: | ---: | ---: |
| Astra / medium | $3.3242 | +$0.001016 | $3.1527 | +$0.515185 |
| Sol 6.1 / high | $0.7533 | +$0.000042 | $0.7226 | +$0.112916 |
| Sol 6.1 / xhigh | $0.9467 | +$0.001031 | $1.0273 | +$0.133380 |

The small Base additions are shown to six decimals so they are not rounded to zero. Known subtotals are based on captured, priced usage; the added components are imputed separately.

| Model / effort | Base priced / captured receipts | Codex priced / captured receipts |
| --- | ---: | ---: |
| Astra / medium | 3,778 / 3,783 | 2,622 / 2,769 |
| Sol 6.1 / high | 3,987 / 3,988 | 2,907 / 3,054 |
| Sol 6.1 / xhigh | 4,230 / 4,232 | 3,208 / 3,355 |

### How missing costs are estimated

**Base Context: missing usage, known models.** Eight captured receipts lack usage: seven root `native-control` / `daemon-status` admissions and one root `refine` / `plan` request. We impute each from the arithmetic mean cost of comparable priced requests in the same selected profile, matching recorded model, provider/API, purpose/subtype, root role, transport and attempt kind. Requested effort is absent; effective effort is matched when recorded. All donors have complete usage and a completed outcome. Child requests are not used as root donors. The additions total **$0.104473 across 150 Base attempts**, rather than zero.

The seven status admissions have no recorded sent or settlement timing, so dispatch and charging are unknown. The planning request was sent, received first events, then was interrupted after 15.422 seconds without usage. Completed peers are an explicit approximation for these incomplete records, not recovered token counts or established charges. No matching priced duplicate or direct usage reconstruction was found.

| Profile / request class | Missing receipts | Comparable priced requests | Mean cost imputed per receipt |
| --- | ---: | ---: | ---: |
| Astra / medium / `daemon-status` | 5 | 449 | $0.010157 |
| Sol 6.1 / high / `daemon-status` | 1 | 531 | $0.002121 |
| Sol 6.1 / xhigh / `daemon-status` | 1 | 737 | $0.002107 |
| Sol 6.1 / xhigh / `plan` | 1 | 10 | $0.049462 |

**Codex: known usage, missing models.** All 441 unpriced receipts have token usage but no recorded model; there are 147 per profile. We price them at that profile's requested model rates. Their actual model and purpose are not established; this is not a verified same-model or compaction-only claim. The assumption adds $38.074 across 150 attempts.

Savings per task = Codex estimated mean − Base estimated mean. Percentage savings = 100 × savings per task / Codex estimated mean. Calculations use unrounded values; displayed amounts are rounded separately. No missing captured receipt is silently assigned zero.

### Sensitivity to the assumptions

Using comparable priced requests from each missing receipt's own run instead of pooling its profile gives overall estimated savings of **11.259%**, versus **11.261%** with the main pooled method. These are alternative imputations, not confidence bounds. The missing planning request has only ten same-profile completed peers, so its true interrupted cost remains uncertain.

**The Codex model assumption matters more:** on Astra, pricing unknown-model receipts at Sol rates makes Base **2.4% more expensive** instead of 9.3% cheaper. The main savings figures must not be read as a measured or model-independent cost advantage.

The Codex model-price alternatives below keep Base's central estimate and both known subtotals fixed. Only the model used to price Codex's unknown-model receipts changes.

| Codex profile | Codex mean if missing model = Sol | Base saving | Codex mean if missing model = Astra | Base saving |
| --- | ---: | ---: | ---: | ---: |
| Astra / medium | $3.247 | -2.4% | $3.668 | 9.3% |
| Sol 6.1 / high | $0.836 | 9.8% | $1.339 | 43.7% |
| Sol 6.1 / xhigh | $1.161 | 18.3% | $1.759 | 46.1% |

These are scenarios, not confidence intervals or bounds on actual cost. The unknown model could be neither Sol nor Astra. A positive percentage means Base is estimated cheaper; a negative percentage means Base is estimated more expensive.

The [recorded pricing table](../python-realworld-30/native/pricing-metadata.json), dated 2026-10-03, uses USD per million tokens:

| Assumed model | Ordinary input | Cache read | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| `gpt-6.1-sol` | $2 | $0.10 | $2.50 | $10 |
| `gpt-6-astra` | $10 | $1 | $12.50 | $50 |

For each unknown-model Codex receipt, the hypothesis computes:

```text
ordinary_input = input_total − cache_read − cache_write
USD = (ordinary_input × input_rate + cache_read × cache_read_rate
       + cache_write × cache_write_rate + output × output_rate) / 1,000,000
```

It assumes standard tier (multiplier 1). Reasoning output is already included in output and is not added again. All 441 receipts have zero cache-write tokens and input below the 272,000-token long-context threshold, so no long-context modifier applies. Token aggregates and unrounded scenario amounts are in the JSON summary. These assumptions do not establish actual billing tiers.

Selected-attempt estimates cover only the 300 selected attempts and exclude provider-invalid attempts and parent interruptions. They are not total campaign or complete agent-family expenditure.

## Methods and limits

### Task selection and staged work

The set consists of five existing [Context Stress 5](../context-stress-5/) tasks plus 45 adaptive workflow candidates that had provider-clean Codex passes on both earlier profiles. Selection was explicitly outcome-informed, then frozen before these fresh runs. It is not a random sample, an unseen holdout or a set of 50 demonstrated Base advantages. Earlier candidate outcomes remain historical; W23 was not qualified, and AL38/AN40 remained on authoring-contract holds.

Both products received the same task information, fixtures, judges, stage treatment and task/profile configuration. The tasks include staged workflow updates, scheduled native compaction and cold reopening of the persisted native session with the workspace intact. Deadlines do not reset at compaction or reopening.

| Tasks | Stages | Compact after stages | Cold reopen after stage | Deadline |
| ---: | ---: | --- | ---: | ---: |
| 5 Stress5 | 6 | 2, 4 | 4 | 2,700 s |
| 35 adaptive | 16 | 4, 8, 12 | 8 | 2,700 s |
| 6 adaptive | 14 | 4, 8, 12 | 8 | 2,700 s |
| 1 adaptive | 14 | 4, 8, 11 | 8 | 2,700 s |
| 1 adaptive | 12 | 3, 6, 9 | 6 | 2,700 s |
| 1 adaptive (F06) | 20 | 4, 8, 12, 16 | 12 | 5,400 s |
| 1 adaptive (I09) | 22 | 4, 8, 12, 16 | 12 | 5,400 s |

These are scheduled interventions, not evidence that every timed-out attempt reached every stage. The result does not isolate output retention, instruction pinning, delegation or any recovery mechanism as a cause.

### Native settings, resources and timing

- Requested profiles: `gpt-6-astra`/medium, `gpt-6.1-sol`/high and `gpt-6.1-sol`/xhigh, through the existing ChatGPT subscription route.
- Rolling paired admission: at most **8 active physical attempts globally, 4 per product**, through collection. The leading product alternated by frozen pair order. There was no batch-completion barrier. Concurrency was not a 12-vs-24 comparison.
- Each attempt had 2 CPU and 8 GiB container limits. Forty-eight tasks had 2,700-second deadlines; F06/I09 had 5,400 seconds.
- Native tools, shell commands, SQL, filesystem notes, redirected output and optional delegation were allowed. Base used its frozen websocket-cached settings, up to two children and depth one; Codex retained its native sandbox/default-child settings.
- **`requestTokenBudget` was omitted.** Budgeted request-view selection was not enabled or measured here.
- Matching tasks and requested profiles do **not** establish architecture, tool, auxiliary-model, delegation or native-lifecycle parity. Base's family barrier and Codex's observed root/descendant idle state have different semantics. Cold reopen uses each product's own persistence implementation.

### First provider-clean selection, not quality selection

Collection admitted **380 physical attempts**:

| Disposition | Base Context | Codex | Total |
| --- | ---: | ---: | ---: |
| Selected provider-clean attempts | 150 | 150 | 300 |
| Provider-invalid physical attempts | 72 | 4 | 76 |
| Parent-interrupted physical attempts | 2 | 2 | 4 |

An observed provider/transport error invalidated the whole physical attempt, including an eventual recovered pass. Its evidence and captured usage stayed in the private campaign record. Explicit replacements used the same cell and deadline. The **first provider-clean attempt** was selected; clean quality failures and clean native timeouts were not rerolled. “Provider-clean” means no qualifying error was observed, not proof that all provider behavior was identical. Conditioning on clean attempts excludes the 76 invalid attempts from headline quality/time and selected cost, so this is not an unconditional reliability or all-in operational-cost result.

The selected attempts include 294 full artifact passes and six clean failures.

### Actual builds, not a single-build claim

| Product | Observed identity | Selected attempts |
| --- | --- | ---: |
| Base Context | `31d7827b0ab8a57e9c09e6b6f66661793c1e550a` | 24 |
| Base Context | `694414adbd29908d753c1d90fc7bb82cdc674456` | 126 |
| Codex | `0.160.0` | 150 |

An asynchronous frame decode/close ordering defect triggered a stop. At the user's direction, completed valid results were retained and only unfinished cells continued after the fix. No recorded completed result is established to have been affected; this does not prove old-build immunity. This is an explicit **multi-build continuation**, not a clean-slate restart or a measurement of only the new release source. The build change is another limit on attribution.

## Reproducibility

This directory supplies the aggregate [summary](summary.json), this method description and a standard-library SVG renderer. The five existing Stress5 inputs and judges are public in the adjacent directory. **The 45 adaptive corpora, full frozen runtime configs, native raw records and controller artifacts are not supplied here. This is not a complete public rerun package.** No benchmark was rerun to prepare these publication assets.

Aggregates were taken from the private campaign's `matched-summary-collection175.json` and `matched-completion-summary-collection175.json`, filtered to the 300 selected attempts. Per-record cost metadata was consulted for Base's eight missing-usage receipts. The publication does not copy corpora, raw runs, credentials or private host paths. The archived campaign retains non-selected attempts and earlier outcomes, but this page does not promise public access to those records.

Rebuild only the four charts, without dependencies or provider access:

```bash
python3 benchmarks/context-curated-50/render_charts.py
```

The renderer reads only `summary.json` and writes `packages/coding-agent/docs/images/benchmarks/curated50-{overview,time,quality,cost}.svg`. It does not collect, judge or reprice runs. All bar axes start at zero; labels are rounded for display, while the JSON keeps unrounded aggregates. The cost hatching denotes an assumption, not additional measured coverage.
