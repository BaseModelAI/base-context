# Native single-attempt harness

Run one installed Base Context or Codex attempt on one Python Real-World 30 task.
The product keeps its native prompts, tools and delegated-work behavior. This
runner does not schedule a campaign, screen saved transport errors, choose a
best-of-two result or reproduce every private controller timing change. See the
[reproduction limits](../REPRODUCE.md).

## Inputs

Use Linux with Docker, Python 3.12, Bubblewrap (`/usr/bin/bwrap`), Node 22 with
native SQLite support, `uv`, and an installed product. The benchmark task runtime
is Python 3.12. Use a fresh output directory outside the checkout. Input paths in
`config.json` must be absolute; the placeholders below are not literal paths.

For a Base Context attempt, `spec.json`:

```json
{
  "config_path": "config.json",
  "harness": "base-context",
  "profile": {
    "id": "gpt-6.1-sol-high",
    "family": "sol",
    "model": "gpt-6.1-sol",
    "effort": "high"
  },
  "task_id": 1,
  "attempt": 1
}
```

For the other published profile use `gpt-6-astra-medium`, family `astra`, model
`gpt-6-astra`, effort `medium`. Model and effort must match native readiness;
there is no model fallback.

Example `config.json` for an existing Base installation:

```json
{
  "corpus_root": "/absolute/repo/benchmarks/python-realworld-30",
  "base_install": "/absolute/base-install",
  "base_version": "/absolute/base-install/versions/installed-version-directory",
  "base_package": "/absolute/base-install/versions/installed-version-directory/node_modules/@ponythewhite/base-context",
  "base_auth_source": "/absolute/private/base-auth.json",
  "node": "/absolute/node/bin/node",
  "uv": "/absolute/bin/uv",
  "python_base": "/absolute/python-prefix",
  "container_image": "debian:trixie-slim",
  "network": "bridge",
  "timeout_multiplier": 2
}
```

`base_version` is the installed directory, not a version string. It supplies
`runtime/`, `node_modules/` and `package.json`. `base_package` supplies the public
read-only session decoder. `python_base` is the prefix used by the installed
Python runtime links. The runner copies mutable runtime state per attempt and
mounts the installed package read-only.

For Codex, set `harness` to `codex`. Instead of the Base-specific fields, provide
`codex_install` (containing `bin/codex`), `codex_auth_source` and an explicit
`codex_sandbox` value supported by the installed app-server. Both agents run
inside an attempt-owned Docker container. Use an existing container image and
network; optional `dns` is a list of resolver addresses.

Auth files are user-supplied native product credentials. The Base file must have
an `openai-codex` entry. The runner copies credentials into the private attempt
home and removes those copies during normal cleanup. It does not log in or
recover credentials. Never publish auth files or raw attempt directories.

## One attempt

After configuring your own installation and provider access:

```sh
python3.12 -B benchmarks/python-realworld-30/native/run_one.py \
  --spec /absolute/private-run/spec.json \
  --out /absolute/private-run/attempt-1/result.json
```

**This command calls the selected provider and can incur cost.** `config_path`
resolves relative to `spec.json`; `--out` resolves relative to the working
directory. No campaign or automatic retry starts.

The deadline is the task's original timeout times `timeout_multiplier`, shared
across all stages and started immediately before the first prompt. Preparation,
startup and grading are outside the intended task clock. The external watchdog
terminates owned containers at the deadline. The retained runner's cleanup and
exit-observation details are not an exact copy of the measured private controller.
It also does not set the published context overrides; native settings must be
reviewed for any new experiment.

Base requires RPC protocol 13+, schema 51+ and `rlm_quiescence_barrier` before the
first prompt. Stage completion waits for native settlement and a correlated
final `stop`. Codex uses its app-server lifecycle. Private fixture services and
external judges are not exposed as solver files. Candidate services share the
attempt's lifecycle and can restart between stages.

## Context Stress 5 extension

Set `corpus_root` to `benchmarks/context-stress-5` and `timeout_multiplier` to `1`
for its fixed 2700-second task window. Its own manifest selects the five-task
loader; the historical 30-task validator and stage semantics remain unchanged.
Only the stress suite acts on `compact_after` and `cold_resume_after`.

Base compaction must emit a successful manual `compaction_end`. Codex's
`thread/compact/start` ACK is not completion: the client waits for that thread's
`contextCompaction` item in `item/completed` AND its matching successful `turn/completed`.
For this suite only, Codex stages also wait for observed root/descendant idle status using
native `thread/list` and `thread/read`, including child-triggered parent turns. This is an
observed idle boundary, not Base's atomic family-quiescence barrier. Unknown or active
statuses do not count as idle; unloaded descendants have no loaded runtime work.
The same check follows compaction before teardown. Cold resume removes the whole
owned Docker namespace, starts a new process with the same persistent home,
workspace and Base runtime, and reopens the same native session/thread ID.
It never resends old task prompts. Model and effort are checked again.
The watchdog acknowledges namespace replacement without resetting its deadline;
old-generation exits cannot end the measured task. Results retain compaction
completion and resumed identity per stage. Stderr, sessions and protocol usage
from both processes are retained for the existing collectors.

Optional `container_cpus` and `container_memory` set Docker limits for either
product. There is no disk quota or endpoint filter in this runner.
`base_settings` writes the attempt's native settings.json; `codex_thread_config`
is merged into native thread configuration, with the selected effort fixed.
Optional `task_instructions` prepends a shared user policy to the first prompt;
use identical wording for both products on the same profile, not product-specific hints.
Freeze these controls before task outcomes. Do not treat a profile output ceiling
as a lower native output reserve. The stress judge reuses Bubblewrap and mounts
the exact configured Node binary read-only; no SQLite CLI is required.
See the [stress protocol](../../context-stress-5/DESIGN.md) for interpretation limits.

## Local outputs and pricing

Outputs can include native events, service logs, usage, price estimates, judge
output and `result.json`. These are private working artifacts, not public exports.
The collectors deduplicate physical native receipts instead of adding cumulative
snapshots. Missing usage stays unknown. Captured activity may not cover every
child request; requested model metadata is not proof of backend execution.

[`pricing-metadata.json`](pricing-metadata.json) contains only the two published
models, using the frozen 3 October 2026 rates. Unknown models remain unpriced.
Reasoning tokens are already part of output. Unknown service tiers explicitly
assume standard rates. Estimates are not invoices or full-family spending totals.
The pricer does not apply the report's cancellation-zero or selection policy.

Offline pricing of an existing numeric usage file:

```sh
python3.12 -B benchmarks/python-realworld-30/native/price_usage.py \
  --usage /absolute/private-run/native-usage.json \
  --harness base-context --out /absolute/private-run/new-cost.json
```

`run_one.py --help` is offline. The retained protocol and candidate-service checks
use synthetic data; they do not reproduce the published campaign.
