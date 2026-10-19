# v1.1.14 cost: paired causes, not a cache headline

## Correction to the earlier diagnosis

The five runtime/interface repairs in `dbd17f522` address real defects, but do not address most of the additional solving work. Selecting those defects was not a sufficient response to the cost regression. An unchanged pooled cache-hit rate also does not establish unchanged caching within tasks.

This follow-up retains the same 62 naturally completed tasks, including failures, and both v1.1.11 attempts with equal weight. There was no new paid run. All amounts are model catalog estimates, not invoices. The observed workflow differences cannot be causally assigned to a release change from these three stochastic attempts alone.

## What increased

The comparator total rises from $91.4113118780 to $99.0754254613: **+$7.6641135833 (+8.38%)**. Recorded token costs rise $7.6884252; the difference in missing-usage estimates subtracts $0.0243116167. Prices are unchanged across every record carrying rate metadata.

An ordered accounting bridge changes request count, then input/request, then input mix, then output/request:

| Component | Recorded cost change |
|---|---:|
| More requests: 7,492 → 8,044 | +$6.7322564 |
| Larger input per request: 31,278 → 31,860 tokens | +$1.2423221 |
| Input-token mix | -$0.1761529 |
| Output tokens per request | -$0.1100004 |
| Total | +$7.6884252 |

Request growth accounts for 87.56% in this order-dependent decomposition. This is an accounting identity, not an estimate of avoidable spend.

The net recorded increase is in descendants: **+$7.74086255 and +646 requests**, versus roots **-$0.05243735 and -94 requests**. That net hides root growth on the three costly tasks, offset elsewhere. On those three, descendant sessions barely increase (10.5 → 11), while requests double (565 → 1,157). Arbitrarily reducing fanout would target the wrong mechanism: long existing workflows dominate there.

## Why the costly workflows grew

| Task | Cost increase versus v11 mean | Paired process evidence |
|---|---:|---|
| Takens | +$5.0599615 | The cheap v11 repeat explicitly abandoned the proof unchanged. Including it lowers the baseline by $3.42470265 relative to the successful original. V14 completed the proof and costs $1.6352589 more than that successful original. The failed repeat remains in every benchmark calculation. |
| Layout | +$4.7005229 | Solver requests increase from mean 226 to 452. Completed icon workers are reassigned to fitting. Measurements from a surrogate interface lead to work that must be reconsidered when the native renderer disagrees. Later fitting still serves the user-requested 98% exact target; v11 repeat openly stops at 92.98%, while v14's final local native render measures 98.266%. All three verifier rewards are zero; local quality is not fresh-consumer success. |
| UEFI | +$2.4180288 | Scope-limited static scans miss relevant data; a RAM/GRUB/GDB/snapshot-tracing detour follows before the same successful four-byte repair. That phase contains 144 requests/$2.1324079; nine VM jobs versus three in each baseline. The model introduced the search restrictions; the task did not require them. The entire phase is not a measured removable-cost amount. |

These three add $12.1785133, offset by $4.5143998 saved on the other 59. Their cache fractions all improve; improved input mix saves about $2.9682 at their v14 input volumes. Their larger request counts and contexts overwhelm that saving.

## What the pooled cache rate hid

The pooled rate moves from 93.0396% to 93.0604%. Yet 37/62 tasks have lower cache-hit fractions. A symmetric task-weight decomposition gives -0.513467 percentage points within tasks, offset by +0.534256 points from changing task weights.

At matched task input volumes, the changed input mix adds only **$0.1583185**. Reweighting toward tasks with cheaper baseline input mixes saves $0.3344715, giving the net -$0.1761529 above. Thus cache behavior varies, but it is not the main dollar driver here. Cache fractions alone do not identify an invalidation bug.

Status-only `ipython(action=status)` requests fall from mean 146 to 56, saving $1.6787442. Increasing the foreground yield timeout is not supported as a repair for this increase. Native-control/refinement costs also cannot be equated with all solver requests that call watch or messaging APIs.

## Input-policy correction

The RLM guidance now makes two decision boundaries explicit, for roots and children:

- A negative search or check applies only to the scope examined. Reconsider exclusions and untested assumptions before switching to a more expensive approach.
- Use the required interface for a representative measurement before scaling work driven by a proxy or alternate interface; do not assume equivalence.

This targets the observed restricted-negative inference and surrogate-to-native rework. It changes the evidence used before expansion, not the user objective or stopping threshold. It adds no task names, answer hints, tool bans, child limits, mandatory reporting stage, or new test framework. Existing edge-case limits and reuse of unchanged observations remain.

This is an evidence-motivated input correction, **not a measured recovery of accuracy or cost**. Source/build checks can show that the guidance is delivered, not that a model follows it. A separately authorized paired benchmark is needed for that claim. The earlier runtime repairs remain useful but must not be used as a substitute for this diagnosis.

Local validation passed: `npm run check`, `npm run build:source`, and a native public prompt-builder call at root and child depths. Both generated prompts contain the new guidance. This checks delivery, not behavioral effectiveness.

## Completed-job registration

A concrete native state boundary was also repaired. `watch()` previously returned the initial `running` snapshot even when its handle already had a settled result; the completion callback only scheduled delivery afterward. Registration now waits for that already-ready result to reach the host and returns the current cached status. It does not wait for running or unsettled jobs.

Terminal events remain pending for normal delivery or explicit consumption. No parking behavior, report, watch limit, public keyword, or daemon wire shape changes. This avoids telling the model to wait on work whose completion is already known; it does not eliminate every legitimate park/consume sequence or establish a dollar saving for all observed false parks.

Validation passed with 64 tests across the existing watch controller, system prompt, and native kernel watch files (22, 27, and 15 respectively; no skips), plus the current source build and repository checks. The native kernel cases cover ready terminal evidence and nonblocking running/duplicate registrations.

## Evidence

Retained runs under `benchmarks/terminal-bench/jobs/`:

- `base-context-sol-tb4-v1.1.11-round-1-20261015-163008`
- `base-context-sol-tb4-v1.1.11-round-2-20261018-102257`
- `base-context-sol-tb4-v1.1.14-published-round-1-20261019-142522`

The v14 run's `comparison/published-final.json` defines the shared cohort. Native trajectories supply per-request metrics, purpose tags and session identities. Selected trace boundaries: Takens repeat root25/28/30/32 (abandonment); layout v14 typography120/126→128/130 and sibling113/115 (proxy/native disagreement), root238/240 (final native render); UEFI v14 root26/28/45→66–139→140 (restricted scans, detour, later finding), compared with v11 original steps 50/52.

Detailed accounting, exact quantities, helper scripts and paired reports are retained in `/tmp/base-context-v114-cost-cause/{accounting,layout,uefi,takens}` and the session result capsules. Analysis used the original benchmark virtual environment with explicit 60-second limits. No provider, Modal, verifier rerun, publication, or JAX-specific work was performed.
