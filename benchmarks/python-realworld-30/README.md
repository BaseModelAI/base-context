# Python Real-World 30 benchmark

This directory implements `prime-context-python-realworld-30-benchmark-spec.md`.
It replaces the Docker synthetic corpus with 30 deterministic Python 3.12 tasks.
Candidate solutions and all fixture code use only the Python standard library.

The current Base Context campaign gate remains closed until the five benchmark
prerequisites work. No early samples or model/auth/readiness probes are admitted.
After that gate, run all 30 isolated tasks at low effort, then at medium effort,
using the same existing session ChatGPT subscription and the exact Sol/Astra models.

## Layout

- `tasks.json` indexes the 30 scenarios.
- `tasks/<id>-<slug>/` contains `TASK.md`, `scenario.json`, `seed.py`, initial and staged payloads, and an external `judge.py`.
- `benchlib.py` contains deterministic setup, staging, metrics, and judge helpers.
- `prepare-hosts.py` maps local H0.9.3 archives and an already frozen native candidate. It does not install, download, rebuild, or patch products.
- `run.py` is the paired H/native Base Context RPC runner for all tasks and variants.
- `run_codex.py` is the stock Codex CLI runner.
- `generate_charts.py` regenerates the published SVG scorecard and per-task advantage charts.
- `bash-tool.mjs` is a neutral benchmark adapter that exposes the same isolated `bash` tool, including optional per-command millisecond timeouts, to all variants.

The runner creates a separate workspace, HOME, config, session directory,
temporary directory, daemon socket, and process for every attempt. Each RPC
process has a private PID/mount view. Its published package image, local
dependencies, Node executable, and neutral adapter are read-only. Only its own
attempt and socket state are writable. No source checkout or user home is
mounted. A private tmpfs `/tmp` and `/rpc/daemon.sock` keep Unix socket paths
short, even when the result directory has a long name. The RPC process keeps
network access for the explicitly selected API.

Both hosts load the same `bash-tool.mjs` adapter and use `--tools bash`.
Neither activates `ipython`, so neither prewarms its kernel. No SDK shim,
product extension, goal, resume snapshot, or product patch is used. Resource
discovery is disabled, and fresh settings contain `packages: []`.

The generated Bubblewrap tool shell has a separate network/PID namespace and
cleared environment. It exposes only the candidate workspace, Python 3.12
standard library, and a small command set. It hides judges, later stages,
credentials, package managers, and public network interfaces. Runner-managed
services are replicated inside its loopback namespace. Future payloads are
injected only between stages. Inputs are read-only; only declared candidate
paths are editable. Judges run outside the measured agent interval.

RPC `agent_end` gates an ordinary stage. A matching `compact` response gates
the next stage after manual compaction. The runner does not invent a
`needs_input`, public `wait_for_idle`, or `shutdown` command. Final stdin EOF
uses the product's wait-idle/dispose route, followed by actual process exit.

The host needs `bwrap`, Python 3.12, and an explicit Node >=22.8.0 executable.
The runner never installs or updates packages.

## Validate the corpus

```sh
python3.12 -E -S run.py --validate-only
```

## Run

Prepare one fresh host directory from existing local inputs. The original S/D
controls and H archives stay unchanged. The native four-core extraction and
private mappings are reused from the frozen candidate; setup does not repack
it. The dependency directory must match the candidate's existing local mapping.

```sh
python3.12 -E -S -B prepare-hosts.py \
  --h-artifacts ../../.work/controls/H-artifacts \
  --candidate-root /absolute/path/to/frozen-candidate \
  --dependency-root /absolute/path/to/base-context/node_modules \
  --node /absolute/path/to/node \
  --root /absolute/path/to/new-host-directory
```

Setup only reads local packages, queries `node --version`, extracts H, and
writes a v2 `hosts.json`. It does not launch a product or copy auth. `vanilla`
uses `@earendil-works/pi-coding-agent@0.9.3`; `current` uses the clean candidate's
`@ponythewhite/base-context`. Both use an external SDK bootstrap importing their
published `dist/index.js`, with the existing runtime and JSONL RPC mode. The
native candidate must include the instance-scoped host-subscription authorization;
older frozen candidates refuse this route.

The native arm passes an enforced request-token policy through that same service/SDK
path. The profile uses the selected local model configuration's combined context limit
and output ceiling, with a one-token-per-UTF8-byte estimate plus a 1024-token margin.
These are declared benchmark settings, not deployment or tokenizer certification.
Only actual native projections grant narrower replay groups. Opaque accounting without
owned exact-prefix coverage remains unknown/refused. The H/control configuration is
unchanged. This wiring does not open the campaign gate or perform a provider probe.

Inference uses only the existing host OpenAI subscription through
`openai-codex` / `openai-codex-responses`. API-key files, credential copies,
login, refresh, provider aliases and inherited credentials are not used.
`--admit-provider-calls` explicitly admits inference for this run.

Pass the existing host auth file path with `--host-openai-codex-auth-file`.
The Python runner checks file metadata only. The provider process reads the
file through `AuthStorage.fromStorage()` using an owned read-only backend.
It retains only the fresh Codex access credential in auth/provider memory.
The exact file is mounted read-only at `/run/host-openai-codex-auth.json` in
the agent process. Bash tools, candidate services, and judges have separate
mount/PID views that do not contain this path or the host auth directory.
No credential is passed through environment variables, argv, or run files.
An absent, invalid, or expired login refuses the run. Refresh is never attempted.

After admission, the full comparison command is:

```sh
python3.12 -E -S -B run.py \
  --hosts-manifest /absolute/path/to/new-host-directory/hosts.json \
  --host-openai-codex-auth-file /absolute/path/to/existing/host/auth.json \
  --admit-provider-calls \
  --tasks all \
  --variants vanilla,current \
  --provider openai-codex \
  --model gpt-5.6-sol \
  --thinking medium \
  --timeout-seconds 1800 \
  --group-size 2 \
  --max-workers 6 \
  --retry-failed 1
```

Both local catalogs contain exact `gpt-5.6-sol` and `gpt-6-astra` under
`openai-codex` / `openai-codex-responses`. `--model gpt-6-astra` selects the
other supported model; no aliases or catalog overrides are added. Catalog
recognition does not establish account access. `--offline` prevents background
package/catalog access, not explicitly admitted inference. H/S/D controls stay
frozen; this external runner does not call archived auth-copy runners. Its
implemented comparison arms are H0.9.3 and the newly authorized native candidate.

Each wave contains three tasks in two flavors, for at most six isolated agent
processes. The first valid attempt is the primary and drives every headline,
including when it fails. A non-strict primary may receive one diagnostic retry
in either arm. A retry never replaces the primary. Speed or cost regressions do
not trigger retries.

An exact confirmed provider error, `Selected model is at capacity.`, invalidates
that run. Native receipts expose this as `capacityConfirmed: true`; H RPC
requires the exact error in an assistant error, failed prompt/compact response,
or `compaction_end.errorMessage`. These invalidations do not consume
the primary or retry allowance. Their attempts and any incurred spend remain in
the output. At most two **valid** attempts run per task/variant; capacity-invalid
attempts are counted separately.

The metric gates are ordered as requested: completion/progress, agent elapsed
time, then cost. Provider tokens remain supporting diagnostic data.
A comparison is publication-ready when current strictly passes all 30 tasks and,
for each task, either the vanilla primary fails (a current primary correctness
win) or both primaries strictly pass and current is faster and cheaper. Missing
time or cost makes the efficiency comparison incomplete, not a win. Efficiency
is not compared on a task that current wins on primary correctness.

Each output root contains raw RPC events, a message transcript, stderr, service
logs, full session JSONL files, the final workspace, per-attempt judge output,
`results.json`, `summary.json`, and `SUMMARY.md`. A task-scoped contract fix
invalidates that task's comparison and requires a clean paired replacement.
Unaffected task results may be retained under the targeted-replacement protocol.
A global product or harness performance fix invalidates every task it can affect.

### Pure vanilla Codex CLI run

The independent Codex arm uses the installed stock `codex exec` CLI under an existing ChatGPT subscription login. The runner pins `gpt-5.6-sol` and medium reasoning effort, uses at most six sessions, and retries only an initial strict failure once:

```sh
python3 run_codex.py \
  --tasks 1-30 \
  --max-workers 6 \
  --retry-failed 1 \
  --timeout-seconds 1800 \
  --output results/20260904-codex0153-gpt56sol-all30-v1
```

This arm does not run Prime Agent or Prime Context. It starts every attempt in a fresh `/tmp` workspace, uses an empty isolated `HOME` and fresh run-scoped `CODEX_HOME`, copies only ChatGPT `auth.json` at startup, and passes benchmark messages on stdin. It strips API-key variables and uses `--ignore-user-config`, `--ignore-rules`, no custom system prompt, and no global or local `AGENTS.md`, `AGENTS.override.md`, or `.codex/config.toml`. Stock Codex built-in instructions remain. `workspace-write` uses the stock command-network proxy with only exact `127.0.0.1` allowed so the two loopback fixture tasks can run while other command destinations remain blocked.

Cost uses the same matched rates as the other arms. Codex turns are staged CLI turns; underlying model-call count is not exposed.

The full local run remains under `results/`. Curated publication evidence under `evidence/20260904-codex0153-gpt56sol-all30-v1/` retains invocation, aggregate and pairwise summaries, every attempt result, every public JSONL event stream, stderr, final messages, service/judge logs, and the exact runner. It excludes authentication state, Codex private rollout state, and bulky duplicated workspaces.

## Accounting

Each attempt retains RPC events, the transcript, session data, the final
workspace, judge output, and its result. Headlines use the first valid primary.
Diagnostic retries and capacity-invalid runs remain in all-attempt time and
spend totals. Valid failures are never hidden by a later success.

Base Context framed journals use canonical `request` entries. Accounting joins
`attempt_admitted` and `attempt_settled` by physical `attemptId`, across session
files, and includes failed as well as successful attempts. Assistant aggregate
usage is not added: child attribution or replay can repeat the same spend.
Native request-purpose counts replace auxiliary inference. Observational
compiler totals are never added again to native receipt totals.

Native receipts expose usage, not invoices. When the captured model contract
has catalog rates and the required usage components are present, the runner
labels the result `catalog_estimate`. Missing rates, usage components, receipts,
or observed costs remain `null` with incomplete flags. Aggregates preserve
unknown values; Markdown prints `n/a`. An unavailable total is never zero.

H raw sessions use their observed assistant accounting. Unavailable physical
request coverage and auxiliary/refinement fields remain unknown. Neither arm
reads the old Prime Context accounting sidecar or archive directory. Provider
prompt anchors count input, cache-read, and cache-write tokens, excluding output.

### Explicit API-price estimates for new runs

The optional `--api-price-profiles PATH` flag reads a JSON snapshot once. The
supplied `api-price-profiles.json` covers Sol and Astra on the existing ChatGPT
subscription and `deepseek-flash` on the DeepSeek API. Omitting the flag keeps
the existing recorded-catalog path. This flag changes estimates, not credentials
or permission to start a benchmark.

OpenAI uses the declared **STANDARD API-equivalent** rates, including separate
ordinary-input, cache-read, cache-write and output charges. Gross input above
272,000 tokens selects long-context rates for the entire request. This is not
subscription cash spend or applied priority/flex billing. DeepSeek uses a declared
**peak API estimate**, not an inferred billing window or verified debit.

The report groups estimates by profile and observation source. Native estimates
use deduplicated physical receipts. Stock v0.9.4 combines ordinary input and cache
writes in its normalized input count; its synthetic write-zero is not evidence.
The report therefore shows a conditional price interval, not a guessed split.
DeepSeek normalized counts can give a conditional point estimate. These figures
cover only priced observations. Missing/default-only observations remain unpriced;
hidden retries, fallback and auxiliary usage are not counted as zero. Conditional
ranges are not guaranteed whole-run bounds or complete-cost comparisons.

The profile snapshot is recorded in the existing `invocation.json`. Physical
receipts, recorded catalog rates, original emitted usage/cost observations and
primary/all-retained-attempt selection remain unchanged. The new three-model
schedule, latest-public host and DeepSeek credential route are separate work;
this pricing option alone does not make that experiment ready.
