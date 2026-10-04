# Native single-attempt benchmark driver

Run an installed Base Context CLI (JSON RPC) or Codex CLI (app-server) on one unchanged Python Real-World30 task. This is the published-native path, not the legacy SDK/Bwrap agent wrapper. The runner keeps the product's normal tools, prompts, runtime protocol, and delegated-work behavior. It does not start a campaign, retry, select a best pair, or replace historical results.

## One attempt

From any directory, with Python3.12:

```sh
/usr/bin/python3.12 -B /absolute/repo/benchmarks/python-realworld-30/native/run_one.py \
  --spec /absolute/run/spec.json --out /absolute/run/attempt-1/result.json
```

Use a fresh attempt directory. `spec.json` selects the task and installed product:

```json
{
  "config_path": "config.json",
  "harness": "base-context",
  "profile": {
    "id": "deepseek-flash-high",
    "family": "deepseek",
    "model": "deepseek-flash",
    "effort": "high"
  },
  "task_id": 6,
  "attempt": 1
}
```

`config_path` is absolute or relative to the spec file, not the working directory. Other input paths in the config must be absolute host paths. `--out` resolves relative to the invoking working directory. The result retains the supplied spec as its identity.

Minimal Base/DeepSeek `config.json` (replace the example paths):

```json
{
  "corpus_root": "/absolute/unchanged-corpus",
  "base_install": "/absolute/owned-install",
  "base_version": "/absolute/owned-install/versions/1.1.0-install-id",
  "base_package": "/absolute/owned-install/versions/1.1.0-install-id/node_modules/@ponythewhite/base-context",
  "node": "/absolute/node/bin/node",
  "uv": "/absolute/bin/uv",
  "python_base": "/absolute/python-prefix",
  "container_image": "debian:trixie-slim",
  "network": "bridge",
  "timeout_multiplier": 2,
  "deepseek_key_source": "/absolute/private/deepseek-api-key"
}
```

- **`base_version` is an installed directory, never a version string.** It supplies `runtime/`, `node_modules/`, and `package.json`. `base_install/bin/base-context` must select this installation; `base_package` supplies its public read-only journal decoder and recorded package version.
- `python_base` is the host prefix targeted by the installed runtime's Python links; its `bin/` and `lib/` are mounted. The runtime is copied into an attempt-owned writable directory; the installed Node package remains read-only.
- `corpus_root` contains the complete original `tasks.json` and30 task directories. Shared `../benchlib.py` validates, prepares, stages, and grades them. No definition, judge, or fixture is rewritten by this tooling; each attempt gets its own fixture-source/workspace copy. Do not point at model answers or substitute a different task variant.
- Required host tools: Docker, Node22 with native SQLite support, `uv`, `/usr/bin/python3.12`, and `/usr/bin/bwrap`. Required mounts include `/usr`, `/etc/ssl/certs`, and `/etc/ld.so.cache`. Use an available container image and existing Docker network. Optional `dns` is an array of resolver addresses passed to Docker.
- DeepSeek uses a nonempty controller `DEEPSEEK_API_KEY` first, otherwise the text file at `deepseek_key_source`. The key is never part of the spec/example/result. Per-attempt credential/environment files are mode0600 and are removed in normal launch cleanup. Keep input credentials outside the repository.
- Base/OpenAI profiles instead require `base_auth_source`, a native auth file containing the `openai-codex` entry. This driver copies that entry; it does not implement login or credential recovery.
- `product_build` and `controller_variant` are optional caller labels. Installation path fields are not version labels. There are no embedded historical paths, credentials, task selections, or scheduler assumptions.

For `harness: "codex"`, provide `codex_install` (containing `bin/codex`) and an explicit `codex_sandbox`. OpenAI uses `codex_auth_source`; DeepSeek uses the same key source/environment and a frozen `deepseek_catalog` JSON file. Base-only attempts do not require any Codex settings. `deepseek_catalog_source`, if retained as provenance, is a URL and is not a file input. Model/effort must resolve exactly at native readiness; there is no model fallback.

## Native completion and lifecycle

Base requires RPC protocol13 or newer, schema51 or newer, and the advertised `rlm_quiescence_barrier` capability **before the first prompt**. Each stage awaits prompt admission, `wait_for_completion`, its event watermark, and the final outcome associated with actual prompt consumption. Only final `stop` succeeds; intermediate `agent_end`, `toolUse`, length, refusal/error, and local idle do not prove completion. The native product owns family settlement; the controller does not recreate a Python polling heuristic. Codex keeps its own app-server completion/provider-error handling.

The task deadline is `scenario.timeout_seconds * timeout_multiplier`, starting immediately before the first prompt is sent after readiness. Every stage and subsequent candidate-service restart shares that deadline. Preparation, startup, usage collection, and external grading do not count. The external watchdog kills the owned container PID namespaces on expiry; a timeout is not a provider error and is not automatically free.

The runner-owned `/bench/bin/python` points to `/usr/bin/python3.12`, and the private PATH includes it. Models do not need to create aliases inside task workspaces. Shared permission helpers skip symlinks rather than changing their targets.

Fixture services are private task inputs. Candidate services honor `start_at_stage` and `restart_each_stage`, publish their URL even when starter code fails, accept the actual announced `LISTENING` port, and retain logs. They run in a separate owned container sharing the main agent's network and PID namespaces. This keeps services available across model tools and ties their lifetime to the task. Expected candidate startup failure is tolerated so the model can repair it; Docker/port infrastructure errors are not silently converted into candidate startup success.

An observed controller `PermissionError` becomes `measurement_failure`, is excluded by `valid_for_selection`, and causes nonzero exit after preserving artifacts. Missing configuration/fixtures and other early preparation errors can exit before any result exists. Do not turn a missing result into a task failure, grade, duration, usage receipt, or zero cost. Other native startup/product error handling and provider classification retain the original controller behavior; this is not a new general exception taxonomy. Any positively identified provider error invalidates the attempt even after native recovery. This single-attempt entrypoint never automatically retries it.

## Numeric artifacts and cost limits

Outputs include native events, service logs, timing/deadline evidence, `native-usage.json`, `api-rate-cost.json`, the real judge transcript, and `result.json` when measurement reaches those stages. Neither collector starts a model or grader. Base collection uses the selected installation's public `SessionManager.openReadOnly` through a generated short **static-import** ESM bootstrap; no source checkout or historical SDK path is embedded. Codex collection reads only retained numeric/control metadata and does not use model answers as fixtures.

Native attempts/responses are deduplicated by physical receipt ID. Message totals, cumulative snapshots, and parent/child attribution are not added again. Missing usage remains missing. Root/family discovery and Codex response coverage can be partial; backend execution is not proven by requested model metadata. API list-rate estimates are not invoices, subscription cash charges, or proven full-family spend.

`pricing-metadata.json` is the dated published-rate snapshot. Unknown models remain unpriced. Unknown DeepSeek holiday/peak timing can remain bounded; unknown service tiers explicitly assume standard pricing. Reasoning output is not added twice. The pricer preserves raw captured-rate pricing, including unknown prices; campaign-specific cancellation-zero reports and best-of-two/mixed-build policy are not applied here. A timeout, empty receipt set, or failed attempt is never inferred to be free.

Offline Codex/pricing CLI helpers:

```sh
/usr/bin/python3.12 -B native/collect_codex_usage.py --codex-home /absolute/home/.codex --stderr /absolute/native-stderr.jsonl --out /absolute/new-usage.json
/usr/bin/python3.12 -B native/price_usage.py --usage /absolute/native-usage.json --harness base-context --out /absolute/new-cost.json
```

The Base collector is an importable helper; `run_one.py` generates its installed-SDK bootstrap and passes the normal `--session-dir` / `--out` arguments. This avoids dynamic imports and decoding with an unrelated historical build.

## Existing offline checks

From `benchmarks/python-realworld-30`:

```sh
/usr/bin/python3.12 -B native/test_base_protocol.py
/usr/bin/python3.12 -B native/test_candidate_service.py --config /absolute/service-test-config.json -v
/usr/bin/python3.12 -B native/run_one.py --help
```

The service check needs only `container_image` and `network` in its JSON config. It uses two synthetic stdlib services in owned containers, not a provider or benchmark task. The adapter check uses synthetic protocol events. No original campaign record or scheduler is needed.
