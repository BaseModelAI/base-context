# Targeted context workflow stress set — design v2

This is a deliberately selected stress set, not a representative comparison of coding agents.
It targets long staged work, recovery of large output, earlier constraints after native
compaction and cold process resume, and independent work that can be delegated.
Codex may win. Good filesystem notes, SQL filtering, redirects, native search, and serial
work are valid solutions. No score requires Python, Base Context, a memory tool, or a child.
A task can be solved without overflowing a context window. Do not inflate it after seeing results.

## Existing interfaces inspected

Read the original claude_rating.md in full, source AGENTS.md, third-review-disposition.md,
python-realworld-30/{README,REPRODUCE}.md, native/{README,run_one,base_protocol,codex_protocol},
and the task scenario/seed/judge format. CodeGraph was unavailable; source fallback used.
The retained native runner already provides native tool access, same staged injection,
owned-container deadlines, model/effort readiness checks, external judges, and usage collectors.
Its load_scenarios validator hard-codes 30 stdlib-Python tasks. Do not masquerade as that suite.
The historical loop did NOT act on compact_after. The stress-only extension now handles it;
old-30 behavior stays unchanged. A scenario flag alone is not a compaction measurement.

## Small runner extension, not a replacement harness

Keep historical files unchanged. Parent should create a separately labeled adapter alongside
these assets. Reuse the existing protocol classes, container preparation, stage copying,
deadline watchdog, and run_judge. Load these five scenario.json files directly rather than
altering historical validation. Add only explicit native compact and process-restart/resume
hooks at the specified stage boundaries. Native Base RPC documents compact, get_state.sessionFile,
and --session for reopening; switch_session alone is not a cold restart. Inspect the installed
Codex app-server schema for its supported compact and thread/resume calls before implementation.
Do not approximate one product's compaction by silently deleting its messages. Both native
compactions use their default summarizer and no injected task-specific hints.

Read the full chosen files before editing. Neither this design nor the assets launch providers.
Product runtime and historical task/results files are unchanged by the task assets.
The native runner extension is restricted to the new suite's lifecycle and judge requirements.

## Freeze before first task outcome

Task payloads, prompts, judge criteria and stage order are frozen as content revision 2.
Runtime constraints below must reflect supported controls, not guesses. The parent completes
an external runtime-lock.json before the FIRST TASK outcome: installed product
versions/build paths, exact common model and effort, auth route category (no secrets), context
settings, Base budget profile and serialized ON settings, OFF settings, container image/runtime
versions, lifecycle calls confirmed by installed schemas, and pricing catalog date or 'unpriced'.
No task run is authorized by this file while any runtime-lock field is unresolved.
Do not invent a live route profile from labels. Base ON must match the real supported route.
If a common model, native lifecycle, or resource limit cannot be configured, resolve that BEFORE
task execution, record the corrected runtime protocol, or omit the unsupported experiment.
Never tune tasks or limits based on task outcomes. A tiny task-independent native route/lifecycle
preflight may precede the runtime freeze on the corrected build. Record its calls and costs
separately. It checks capability, not task quality, and must not become a quality-tuning pilot.
All known product, harness and newly discovered fixes must first be in ONE committed local
candidate. No provider preflight or benchmark may use an earlier incomplete build.

## Fixed campaign and limits

- Baseline arms: Codex native and the corrected LOCAL UNPUBLISHED Base build with
  requestTokenBudget absent (OFF). Never use old published 1.1.1 or superseded 1.1.2 packs.
  Parent freezes the exact corrected build before any benchmark. New five tasks run first.
- Two exact shared profiles: gpt-6.1-sol/high and gpt-6-astra/medium, through the SAME existing
  ChatGPT subscription route for both products. No API-key substitution and no DeepSeek.
  One valid first attempt per arm/task/profile: 5 x 2 x 2 = 20 baseline cells. No best-of-two.
  Any additional benchmark runs must be planned before live outcomes and all must count.
- Optional third arm: SAME Base build with requestTokenBudget.mode=enforce (ON), only after
  the real subscription-route profile is validated and the decision to include it is frozen.
  This gives 30 cells total. It isolates the budgeted-selection bundle, including epochs and
  accounting, NOT pure selection alone. Never relabel observe mode as OFF. If omitted, make
  no causal selection claim; do not add ON later merely because baseline results look favorable.
- Maximum SIX simultaneous attempts TOTAL across arms. Parent freezes balanced arm/profile
  scheduling and the actual common concurrency before starting. Limits below are proposed
  for runtime-lock approval, not an executable campaign controller.
- The separately requested original-30 rerun is outside this corpus: corrected local Base only,
  using existing valid historical Codex results, NOT new Codex calls. Preserve historical runs
  and disclose dates/build/settings differences; it is not a fresh matched-period comparison.
- Each attempt gets 2700 seconds total from first prompt admission through all stage work,
  compaction, process teardown/reopen and the completion boundary below. Native startup before the
  first prompt and external grading excluded; between-stage resume time included.
- Proposed shared allocation: 2 CPU cores and 8 GiB memory, using explicit Docker flags in
  the runtime freeze. The bind-mounted workspace has NO hard disk quota. Same runtime
  executables and source fixtures. Node 22, Python 3.12 (including sqlite3), Bash and jq available to BOTH.
  No sqlite3 CLI is promised or required. The task4 judge must bind the same exact Node binary
  read-only and expose node on its PATH; the historical Python-only judge namespace omits it.
  Python is a judge implementation choice, not a solver restriction. Offline packages only.
- The task instructions prohibit web research and package downloads. Provider/auth traffic
  remains necessary. This is NOT an enforced endpoint allowlist unless the runtime freeze
  identifies an actual network filter. Both see identical task files and may keep notes.
  Secrets stay in native private homes, never in task files or public results.
- At most two concurrent children, one descendant level, same model/effort and shared attempt
  deadline/resource limits. Use supported native controls for BOTH; if unavailable, freeze a
  common feasible rule before running. Delegation optional. Report actual use without rewarding it.
- Both selected model catalogs declare context capacity 272000 and maxTokens 128000.
  Preserve these actual values in runtime-lock; no one-sided lowered capacity. Manual compaction after stages 2 and 4. Cold process restart/resume after stage 4,
  after compaction settles. Preserve workspace and native saved session, stop parent/children/
  kernels, reopen same native session/thread in a new OS process. No human-written summaries.
  Natural auto-compaction remains enabled with the same nominal trigger where supported.
- ON budget values are intentionally unspecified until the actual subscription route and native
  output reserve are validated. A profile's outputCeiling does NOT shrink the model's native
  output reserve; do not pretend a small example budget does so. Parent freezes exact supported
  values before task outcomes. This is a treatment, not equal provider capacity. OFF/Codex retain
  the same actual model capacity; never impose ON's budget on Codex by truncating its prompts.
- Stage completion: Base uses its native family-quiescence barrier. Codex root turn completion
  alone is not a family barrier. For this suite, the runner pages thread/list with ancestorThreadId
  and explicit subagent source kinds, then reads current root/descendant statuses with thread/read.
  It waits for root idle and descendants idle/notLoaded, including child-triggered parent activity.
  Unknown/active states are not treated as idle. This is observed_native_family_idle, not an atomic
  admission barrier or a guarantee about future messages. Both stay under the original deadline.
  Codex compaction additionally requires its completed contextCompaction item AND matching
  successful turn/completed, then the same idle observation before teardown. Base requires its
  successful manual compaction_end event. This avoids killing known active delegated work.
- All six stages are delivered in fixed order after that boundary, regardless of artifact score.
  No mid-run judge feedback. If the product cannot continue, stop and grade existing artifacts.
  No operator repair prompts, secret clues, profile fallback, or missing-stage retry.
- Clean task failures, refusals, and timeouts remain eligible results. Typed native provider/
  transport failures may be replaced under the parent's pre-frozen policy, never based on quality.
  Retain and publish their counts, time and cost separately; include them in total campaign spend.
  Pre-prompt infrastructure failures remain visible but score N/A. Parent freezes replacement
  cap and error classification before outcomes. A confirmed product defect stops the campaign;
  fix before a new separately labeled build/campaign, retain interrupted/old outcomes. Do not
  combine old and new builds. This design itself does not screen or schedule attempts.

## Scoring and reporting

Each task has five named binary semantic groups and one edge group (six points; full pass all six).
No quality tie-break on cost, speed, explanation style, chosen language or delegation.
Publish every attempt and paired per-task differences. Show full-pass counts plus six-point scores,
not a winner based on a single average. With ten cells per arm there is high uncertainty; do not
claim broad superiority. Keep failed attempts in duration and cost accounting; timeout is censored
at its fixed deadline, not a completed-runtime win. Output tokens include reasoning where the
provider includes it. Reuse native collectors; missing parent/child/compaction usage is UNKNOWN,
not zero, and exclude causal cost comparisons with asymmetric coverage. Price only against a
frozen catalog, clearly as estimates not invoices. Do not add selected-run estimates to campaign cost.

Record native compaction success, cold reopen, and selection omission/refusal from existing native
outputs as exposure diagnostics. An ON run with no selection omission is not evidence of the
selection mechanism's benefit. Large-output tasks allow efficient file search; avoiding a large
terminal response is a legitimate solution, not failure. If no run encounters retained-output
recovery, report that pathway unexercised. Task 5 permits delegation but cannot establish delegation
benefit without a separate both-products serial/native-enabled counterfactual; that is a possible
future preregistered ablation, not an uncounted rerun. Faux tests show mechanics only.

## Assets and grading

The corpus uses the familiar TASK.md, scenario.json, seed.py, visible/, stages/, judge.py layout.
Staged fixtures are deterministic and are injected without deleting prior inputs or solver notes.
Public criteria contain all grading rules; judges are outside the solver workspace for both.
Fresh main and one edge fixture are used where code behavior is required. Artifact-analysis tasks
compare submitted machine-readable decisions against the supplied source facts. They do not claim
to test general program synthesis. Files under output/ may be recreated freely; no score requires
exact prose. The design includes only the minimal main+edge checks, not a new validation framework.
