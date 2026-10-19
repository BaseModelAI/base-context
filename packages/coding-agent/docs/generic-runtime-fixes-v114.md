# General runtime fixes after the v1.1.14 benchmark

## Findings and limits

On the same 62 naturally completed tasks, v1.1.14 scored 28/62 (45.16%), versus 64/124 (51.61%) across the two v1.1.11 attempts. Estimated model cost rose from $1.4744 to $1.5980 per task (+8.38%); mean agent time rose 1.06%. Failed natural outcomes remain included. These are observed results, not a statistical attribution to individual source changes.

The net extra cost was $7.6641 across the cohort. Three tasks contributed $12.1785 before savings elsewhere. The pooled cache-hit rate was nearly unchanged, but that hid within-task changes: 37 of 62 tasks had lower cache-hit fractions. The subsequent [paired cost investigation](v114-cost-cause.md) separates those effects and finds request growth to be the main accounting driver. The original five repairs below do not address most of that additional solving work; they must not be presented as recovery of the cost regression.

The selected repairs address concrete runtime or interface mechanisms. None contains benchmark names, answers, exclusions, verifier changes, dependency restrictions, or new solving prompts. Incorrect task outputs were investigated, but these changes do not establish recovery of the accuracy or cost regression.

## Five repairs

1. **Release drained watch capacity.** Retained histories reached the 16-watch limit with mostly inactive, terminal watches whose pending evidence had already drained. Only inactive terminal watches with no pending events now stop occupying admission slots. Restore uses the same rule. Cached status remains available; unresolved reports and queued/in-flight evidence still count. Existing byte budgets and unregister behavior remain.
2. **Skip empty idle-eviction barriers.** The supervisor could acquire its global mutation-drain fence even with no eligible whole workers. A retained run logged an eviction drain timeout, though its exact blocking mutation and reward effect are unproved. Empty sweeps now skip that fence after child passivation. Real worker eviction retains its drain and fresh eligibility check.
3. **Keep children resident while known completion work remains.** Timed passivation omitted the existing completion-blocker state. Both candidate selection and the fresh pre-disposal snapshot now include it. Parked watches, pending terminal notices, and other work exposed by that getter prevent passivation. The 90-minute policy and four-resident-child limit are unchanged. This is a source-level ownership defect; a benchmark accuracy contribution is not established.
4. **Give accurate installed-skill API feedback.** An observed `job_watch.register` error suggested `unregister`, a different action. Missing attributes on exact installed skill module identities now show bounded real callable names and canonical skill help, without the spelling guess. Ordinary module exceptions, the original exception and its context/stack remain unchanged. No aliases were added and successful calls receive no extra text.
5. **Show valid fields in task-contract errors.** Unsupported nested fields previously returned only a rejection. The same validator now lists valid fields at the failing object. The schema and strict rejection remain unchanged; for example, dependencies still belong on individual delivery files, not the delivery object.

## Validation

- 11 focused TypeScript tests passed across `task-contract.test.ts`, `job-watch-capacity.test.ts`, `daemon-supervisor-idle-noop.test.ts`, and `daemon-passivation-completion-blockers.test.ts`.
- Two Python cases in `test_skill_api_errors.py` passed through the runtime project's locked, offline environment: installed-skill feedback and an unchanged ordinary-module error.
- `npm run build:source` passed, including runtime and skill copying/bundling.
- `npm run check` passed. It applied formatting to two files; installer and browser checks passed.

These are local source and boundary checks, not a new provider benchmark or deployment. There are no daemon command/event/response-shape changes, capability changes, or protocol-version changes.

## Deliberately not changed

Correct queued/in-flight watch delivery is not suppressed to reduce wakeups. Completed children are not forcibly reclaimed under admission pressure: current host state cannot prove that all Python BashHandles and unread results are quiescent. The completion-blocker repair does not close that separate gap. The shutdown/attach race is also deferred rather than hidden with log filtering or another timeout increase.

No paid rerun, release bump, publication, or JAX-specific work was performed. Measured accuracy and cost effects require a separately authorized benchmark.
