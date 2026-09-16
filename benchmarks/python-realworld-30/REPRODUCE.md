# Reproduce the benchmark method

This guide starts a **new experiment**. It does not overwrite or re-create the
historical [mixed-commit reference](REPORT.md). The frozen CURRENT SDKs were
`84a7e6f30625247aa153ed8fdb0d40c4981c4632` for Sol/Astra and
`077f463424f8eb94f07dc2c6325db0feaba363cd` for DeepSeek, both package version 0.1.0.
The task 15/27 correction is revision `86429a34362e3125679812e129c9fd5d6b6001d8`.
Vanilla was Prime Agent 0.9.4 with the accounting-only patch in this directory.

Release 1.0.0 is a **single-commit method replication**, not the measured SDK.
Changing SDKs, providers, models or prices changes the experiment. Hosted models
are stochastic and may no longer be available. Never silently replace a model
and retain the same comparison label. Do not run the known-bug `84` SDK on
DeepSeek to reconstruct the discarded old run.

## 1. Runtime and user-supplied inputs

Use Linux with:

- Python **3.12**, invoked with `-E -S -B`.
- Node **22.12.0** for the recorded floor. Supported versions match the package
  engine: `^22.12.0 || >=23.3.0` (Node 23.0–23.2 are not supported).
- `bwrap` (Bubblewrap) and permission to create user, mount, PID and network
  namespaces. Both outer RPC isolation and inner tool isolation are required.
- npm and the source checkout's locked dependencies.
- Your own provider access to `gpt-5.6-sol`, `gpt-6-astra` and `deepseek-flash`.
  The provider process accepts an existing OpenAI Codex subscription auth file
  and a DeepSeek API-key file. No credential, login command or credential contents
  are supplied by this repository. Do not put them in the checkout or public output.

The commands below use variables chosen locally by you:

- `RUN_ROOT`: a fresh absolute directory **outside the checkout**, for private
  package hosts and raw outputs. Do not publish it.
- `NODE`: the absolute path to the selected Node executable.
- `OPENAI_AUTH_FILE`, `DEEPSEEK_KEY_FILE`: your private existing credential files.

The scripts do not log in, inspect credentials during offline preparation, install
packages or make readiness/model probes. `prepare` is local-only. `run` can call
providers only after explicit admission. Dependency/archive downloads below are
user-run package preparation, not inference.

## 2. Build and pack a clean CURRENT checkout

After the 1.0.0 release tag is available:

```sh
git clone https://github.com/BaseModelAI/base-context.git
cd base-context
git checkout v1.0.0
npm ci
npm run build:source
npm run release:pack -- --base-url https://github.com/BaseModelAI/base-context --version 1.0.0
```

Before that tag exists, use an available clean revision chosen for your own
experiment. Build and qualify that exact revision. Do not substitute the latest
npm package and call it an exact historical replay. Generated build metadata must
record `sourceDirty: false` and the real source commit.

The pack command produces these local files under
`packages/coding-agent/release/artifacts/`:

- `base-context-1.0.0.tgz`
- `base-context-ai-1.0.0.tgz`
- `base-context-agent-1.0.0.tgz`
- `base-context-tui-1.0.0.tgz`

Keep generated private hosts and outputs outside the checkout so they cannot
make the source build dirty. Preserve the chosen Node and dependency versions
when comparing runs. The source build embeds SDK metadata; a version string alone
is not an exact build pin.

Fetch the four pinned stock archives from the upstream public release storage into a separate local directory. Prime Agent0.9.4 uses these release archives rather than npm packages under these names. The commands below download archives only and do not execute an upstream installer:

```sh
mkdir -p "$RUN_ROOT/stock-archives"
STOCK_RELEASE=https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.4
curl -fL "$STOCK_RELEASE/prime-agent-0.9.4.tgz" -o "$RUN_ROOT/stock-archives/prime-agent-0.9.4.tgz"
curl -fL "$STOCK_RELEASE/prime-agent-core-0.9.4.tgz" -o "$RUN_ROOT/stock-archives/prime-agent-core-0.9.4.tgz"
curl -fL "$STOCK_RELEASE/prime-agent-ai-0.9.4.tgz" -o "$RUN_ROOT/stock-archives/prime-agent-ai-0.9.4.tgz"
curl -fL "$STOCK_RELEASE/prime-agent-tui-0.9.4.tgz" -o "$RUN_ROOT/stock-archives/prime-agent-tui-0.9.4.tgz"
```

The expected filenames are `prime-agent-0.9.4.tgz`, `prime-agent-core-0.9.4.tgz`,
`prime-agent-ai-0.9.4.tgz`, and `prime-agent-tui-0.9.4.tgz`.

## 3. Prepare isolated hosts offline

From the repository root:

```sh
python3.12 -E -S -B benchmarks/python-realworld-30/scripts/reproduce.py prepare \
  --current-archives packages/coding-agent/release/artifacts \
  --stock-archives "$RUN_ROOT/stock-archives" \
  --dependency-root "$PWD/node_modules" \
  --node "$NODE" \
  --current-commit "$(git rev-parse HEAD)" \
  --output "$RUN_ROOT/hosts"
```

The wrapper extracts the four CURRENT archives, maps their private core packages,
and writes the existing `package-inspection.json` format. It calls
`prepare-hosts.py` to check metadata, clean source pin, dependencies and SDK paths.
It then calls `stock-accounting/apply_patch.py` to patch a **new stock copy** and
writes `hosts.json` pointing at it. The pristine copy is not modified. The patch
instruments accounting in the selected unbundled SDK, not the CLI bundle.

No new benchmark framework is involved: live work still uses
`paired_medium_reference.py`, `run.py`, the same shared adapter and the existing
stock-accounting patch. Archive/package or exact patch mismatches are errors.
Missing or incompatible dependencies must be resolved in the chosen local build
and requalified; do not remove those checks to force the run to start.

## 4. Run offline qualification against the prepared archives

From the same clean checkout and selected Node, run:

```sh
python3.12 -E -S -B benchmarks/python-realworld-30/scripts/reproduce.py qualify \
  --hosts-manifest "$RUN_ROOT/hosts/hosts.json" \
  --current-commit "$(git rev-parse HEAD)"
```

This command does not accept credentials or provider-admission flags. It must exit
successfully before proceeding. It performs these concrete checks:

1. Calls the existing `run.py` host-manifest checks against the **actual prepared
   archives**. Package metadata, clean source commit, dependencies and pinned
   entrypoints must match. Vanilla must be the separate accounting-patched Prime
   Agent 0.9.4 copy. The selected Node must satisfy the package engine range.
2. Imports each prepared `dist/index.js`, creates the native SDK services/runtime
   through the existing `subscription-rpc.mjs` setup, and uses the existing
   `run.py` process isolation. It sends only native JSONL `get_state`, checks the
   response, then exercises native stdin-EOF disposal. Auth is empty and in-memory;
   the only credential mount is an empty local fixture. Network access is disabled
   with Bubblewrap. No prompt, model request, login or real credential read occurs.
3. Checks that the **actual instrumented stock SDK** opens and closes its accounting
   sidecar without write errors or any admitted model attempt.
4. Runs these existing public offline adapter/accounting checks under the selected
   Node, Python 3.12 and network-disabled Bubblewrap:

```text
test_harness.HarnessComparisonTests.test_shared_bash_workspace_devices_and_timeout_recovery
test_harness.HarnessComparisonTests.test_native_prompt_completion_marker_is_host_scoped_and_exact
test_harness.HarnessComparisonTests.test_current_terminal_invocation_error_does_not_advance_stage
test_harness.HarnessComparisonTests.test_stock_retry_waits_for_sdk_idle_before_advancing
test_harness.HarnessComparisonTests.test_stock_retry_start_rejection_is_terminal_only_at_idle
test_cost_accounting.CostAccountingTests.test_happy_closed_physical_scope_and_raw_price_presence
test_cost_accounting.CostAccountingTests.test_incomplete_failed_scope_and_synthetic_write_stay_unknown
```

The first three steps target the prepared SDK archives. The last step exercises the
real shared Bash adapter and existing RPC/accounting fixtures, including timeout
recovery, terminal failures, stock retry settlement and unknown cost handling.
It does not manufacture physical usage for a model call.

This is **offline host/adapter/accounting qualification**, not proof of hosted-model
behavior or authorization. It does not test inference, live provider accounting,
or the accuracy of a newly changed SDK. Use a release with the working-context
features and known product fixes already qualified; this command cannot qualify
an arbitrary new product change. Do not use early samples or auth/model probes as
a substitute. Stop a run if a product bug is found, fix and qualify it, then start
a fresh run rather than changing the build under an existing campaign.

The later `--qualification-complete` flag acknowledges that you ran this procedure
successfully and selected a qualified SDK. It performs no qualification itself.
It does not replace these checks or the live runner's clean archive/pin checks.
There is no private qualification artifact, token or external file to obtain.

For the added exporter/wrapper's separate happy-path and missing-data/admission
edge test (also offline):

```sh
cd benchmarks/python-realworld-30
python3.12 -E -S -B -m unittest -v test_publication
cd ../..
```

## 5. Explicitly start a new paired MEDIUM run

Only after qualification, with your own provider authorization:

```sh
python3.12 -E -S -B benchmarks/python-realworld-30/scripts/reproduce.py run \
  --hosts-manifest "$RUN_ROOT/hosts/hosts.json" \
  --current-commit "$(git rev-parse HEAD)" \
  --host-openai-codex-auth-file "$OPENAI_AUTH_FILE" \
  --host-deepseek-api-key-file "$DEEPSEEK_KEY_FILE" \
  --output "$RUN_ROOT/new-run" \
  --qualification-complete --admit-provider-calls
```

**This command spends real provider resources.** The output must be fresh and
empty. The wrapper checks both acknowledgements before reading host/auth inputs.
The fixed public price snapshot is the default; an explicit
`--api-price-profiles` file can define a separately labeled new experiment.
The runner never installs, logs in, changes the installed host or launches an
automatic second campaign.

The original driver retains its hardcoded historical `CURRENT_COMMIT = 077f463…`
as the default gate. The wrapper passes `--qualified-current-commit` explicitly
and requires qualification acknowledgement. That alternate pin is compared with
the **actual clean archive build metadata**; it is not a rewrite of a result's
commit label. The manifest marks this as `new-method-replication`.

The scheduler runs 30 tasks × 3 models × 2 harnesses. It uses six independent
sequential queues with at most one active attempt per (model, harness), and six
globally. All first primaries precede deferred retries. At most one benchmark
retry is allowed for a failed or runtime-unclean cell. The terminal attempt is
the retry, not the best attempt. Every attempt is charged. DeepSeek logical MEDIUM
uses the existing native `high` mapping. Task deadlines remain unchanged, bounded
by the 1800-second runner limit.

The historical reference instead retained OpenAI cells during a DeepSeek restart,
then freshly replaced only tasks 15/27 across both harnesses and all three models.
The archived partial-restart/finalization driver modes remain available for their
original local artifacts, but are **not required** for this new clean-checkout
run. Replaying those modes with one current SDK would not recreate the old mixed
reference. Raw historical outputs are private, so exact local replay of their
provider responses and queue timing is not offered.

## 5a. Run a qualified CURRENT-only task subset

For a release regression, the same scheduler accepts an explicit subset and a
CURRENT-only arm. This does not run stock Prime Agent again. Select the tasks
once, before seeing new outputs, and use that same selection for all three
models. For the 1.0.1 regression, the random selection is
`1,5,6,8,9,10,14,18,23,28`.

After qualifying the exact clean installed CURRENT build, invoke the existing
driver directly (the full-paired wrapper above keeps its original defaults):

```sh
python3.12 -E -S -B benchmarks/python-realworld-30/paired_medium_reference.py \
  --tasks 1,5,6,8,9,10,14,18,23,28 --variants current \
  --hosts-manifest "$RUN_ROOT/hosts/hosts.json" \
  --qualified-current-commit "$(git rev-parse HEAD)" \
  --api-price-profiles benchmarks/python-realworld-30/api-price-profiles.json \
  --host-openai-codex-auth-file "$OPENAI_AUTH_FILE" \
  --host-deepseek-api-key-file "$DEEPSEEK_KEY_FILE" \
  --output "$RUN_ROOT/new-subset-run" \
  --qualification-complete --admit-provider-calls
```

The host manifest can contain only the qualified CURRENT host for this mode;
no stock archive or stock accounting patch is required or loaded. The existing
CURRENT package, clean commit, Node and dependency checks still apply. This mode
is marked `new-subset-regression`, not a historical replay or a paired stock run.

It runs **30 first primaries**, using three independent sequential model queues
and one active attempt per model. All 30 primaries finish before any benchmark
retry. Each failed or runtime-unclean cell can have one retry; all attempts count.
The task/judge Python 3.12 environment, logical MEDIUM effort, DeepSeek native
`high` mapping, task deadlines and SDK/shared-Bash adapter are unchanged. This is
not a native-RLM benchmark. Product Python 3.13 installer/kernel qualification is
separate.

Compare the selected historical CURRENT cells with the new first primaries and
terminal attempts separately. Report the changed build, calendar/model-service
conditions and reduced concurrency (three queues instead of the old six-arm
paired run). Do not claim contemporaneous stock performance or replace frozen
historical results. Unknown whole-invocation costs remain unknown. If a product
bug is confirmed, stop, fix and qualify a new build before starting a fresh run.

## 6. Export numeric results without publishing raw artifacts

```sh
python3.12 -E -S -B benchmarks/python-realworld-30/scripts/export_results.py \
  --input "$RUN_ROOT/new-run" --output "$RUN_ROOT/public-export"
```

This is an offline transformation of the existing paired driver's `results.json`.
It emits `cells.csv`, `cells.md`, `attempts.csv` and `summary.json`. It uses a
field allowlist, not raw-object copying. Unknown costs/durations/counters remain
unknown, and entirely unknown columns are omitted. It keeps full CSV/JSON numeric
precision and explicit coverage. The displayed Markdown rounds numeric values.

The committed frozen files were produced by the same exporter from the canonical
local corrected reference. `reference.json` and `historical-fees.json` are the
separate, allowlisted historical pin/fee snapshots described in the report.
They are not recomputed or silently substituted for a new run. To inspect the
published reference, no auth or raw private data is needed: read the committed
CSV/JSON and the [methodology](REPORT.md).

Publish only the curated numeric exports and experiment notes. Never copy raw
`results.json`, per-attempt result files, session trees, RPC/provider streams,
error bodies, receipt attribution, commands, environment snapshots or auth files.
The raw output root is deliberately separate from the public export.
