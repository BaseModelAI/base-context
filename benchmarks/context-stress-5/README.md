# Context Stress 5

A deliberately targeted stress set for staged operational work, not a representative
agent ranking. Both products get identical task information, fixtures, notes access,
permissions and deadlines. Native tools, shell commands, SQL, filesystem notes, output
redirects and native delegation are allowed. No criterion requires Python or Base Context.
SQL and Node are deliverable formats only where the real workflow requires them.

| Task | Concrete work | Main stress |
| --- | --- | --- |
| 1. Settlement close | Reconcile 6,000 orders with FX, revised captures, capped refunds and chargebacks in SQLite | Evolving financial rules and cumulative data |
| 2. Checkout incident | Correlate 32,000 normal log records plus incident traces; correct clocks; apply one config rollback | Large-output recovery opportunity, scope retention |
| 3. Retention migration | Idempotent SQL migration for 1,800 customers with hold/support/privacy precedence | Early constraints across compaction and cold resume |
| 4. Label service | Repair/extend a six-file Node service for pricing, carrier selection, revisioned holds and CSV | Multi-file change with legacy API preservation |
| 5. Release handoff | Integrate capacity, security, billing and dependencies for 96 services in three regions | Independent workstreams suitable for delegation |

Every task has six fixed stages. Each has five named main checks and one edge check.
Code tasks are rerun against a fresh main and one edge fixture. Analysis tasks grade the
submitted decisions and configuration directly. All scoring rules are in TASK.md and the
stage messages. Judges are published but kept outside both solver workspaces during runs.
Task5 delegation is optional and unscored. Task2 can be solved by efficient file search:
dumping huge output is not required. Successful avoidance of context pressure is valid.

## Layout and integration

Use tasks.json to discover tasks. Each task provides TASK.md, scenario.json, seed.py,
visible/, stages/02..06/, judge.py and, where needed, edge/. Scenario fields follow the
existing python-realworld-30 scaffold except for a separate schema/pressure label and
cold_resume_after. Do not use its fixed 30-task validator for this corpus.

- Initial prompt is scenario.initial_prompt; every later prompt is stages[i].message.
- Prepare visible/ through the existing seed/copy helpers. Inject the named later directory
  after the preceding native turn settles. Old files and solver notes remain available.
- Base stage completion uses its native family barrier. Codex uses observed root/descendant
  idle status through native thread/list/read; this is not an atomic family barrier.
- At compact_after=true (after stages 2 and 4), await successful native compaction. Codex
  requires both the completed compaction item and its matching successful terminal turn,
  then observes root/descendant idle again before any process teardown.
- At cold_resume_after=true (after stage 4 compaction), stop the entire owned process family
  and reopen the persisted native session/thread in a new process, with workspace intact.
- A scenario flag is not proof that compaction happened. Confirm native completion events.
- judge_command returns the familiar status/progress_level/main_checks/edge result shape,
  plus named checks. Score six semantic checks, not the historical progress tie-breaker.
- Judging uses Python 3.12. Task4 also requires the exact same Node 22 binary used by both
  solvers. The historical Python-only Bubblewrap namespace needs that explicit read-only bind.
  No sqlite3 CLI is needed; Python sqlite3 or any other supplied SQLite interface is allowed.

[DESIGN.md](DESIGN.md) describes the protocol and small native-runner extension. Installed
builds, profile routes, concurrency and resource enforcement remain parent-owned runtime
freeze inputs. Task content revision v2 was fixed before any model outcomes; score counts and deadlines are unchanged. Do not launch a
provider from these files while the runtime freeze is unresolved. These assets contain no
provider launcher or credentials.

Content revision v2 is a pre-provider audit correction, not outcome-based tuning. It clarifies
that the support-ticket retention reason applies at any contact age, makes an empty settlement
CSV return a normal failed score, and adds one unheld tied-carrier order to the existing label
edge fixture without removing its independent-hold case. Schema v1, five main checks plus one
edge check per task, stage order, and all deadlines are unchanged. No model outcomes existed
when these corrections were made.

## Evidence limits

The five judges passed one local hand-written reference candidate each, including each
specified edge case. This is only an offline asset smoke check, not model evaluation.
No live result or performance claim is supplied here. Natural context saturation, native
retained-output recovery, selection omission, and delegation must be observed before claiming
those pathways were exercised. Native compact/resume is deliberately scheduled for both.

The intended live profiles are gpt-6.1-sol/high and gpt-6-astra/medium through the matched existing
ChatGPT subscription route. Base must be the corrected local unpublished build. Selection ON
versus OFF is an optional matched ablation only after the real route profile is validated and
the arm decision/settings are frozen; OFF means requestTokenBudget absent, not observe mode.
This contrasts the budgeted-selection bundle, not selection in isolation. Use all preselected
attempts; no best-of-two, no score-driven tuning/retry, and no generalized superiority claim.
