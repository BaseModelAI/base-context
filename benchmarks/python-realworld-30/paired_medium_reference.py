#!/usr/bin/env python3
"""MEDIUM reference and explicitly selected regressions, with deferred benchmark retries."""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
import json
import shutil
from collections import deque
from pathlib import Path

import run as harness
from compare import numeric, runtime_clean

CURRENT_COMMIT = "077f463424f8eb94f07dc2c6325db0feaba363cd"
MODELS = harness.CAMPAIGN_MODELS
VARIANTS = ("current", "vanilla")


def clean_pass(result):
    return bool(result and harness.strict_pass(result) and runtime_clean(result))


def result_of(record):
    return record.get("result") if record else None


def selected_record(cell, assisted=False):
    attempts = cell["attempts"]
    if not attempts:
        return None
    # No capacity-valid promotion or best-run selection. A retry is terminal.
    return attempts[-1] if assisted else attempts[0]


def outcome(record):
    result = result_of(record)
    metrics = (result or {}).get("metrics") or {}
    return {
        "completed": result is not None,
        "strict_pass": harness.strict_pass(result) if result else False,
        "runtime_clean": runtime_clean(result) if result else False,
        "strict_runtime_clean": clean_pass(result),
        "error": result.get("error") if result else None,
        "capacity_invalid": result.get("capacity_invalid") if result else None,
        "compaction_failures": metrics.get("compaction_failures"),
    }


def activity(records):
    """Keep captured prices separate from whole-invocation API-equivalent cost."""
    results = [r["result"] for r in records if r.get("result") is not None]
    metrics = [r.get("metrics") or {} for r in results]
    value = harness.aggregate_bucket([({}, r) for r in results])
    if len(results) != len(records):
        # Captured profile subtotals remain visible, but an unfinished invocation is not free.
        value["api_cost"] = {key: None for key in value["api_cost"]}
        value["provider_usage"] = {key: None for key in value["provider_usage"]}
        for key in ("agent_wall_seconds", "lifecycle_wall_seconds", "judge_seconds", "all_model_calls"):
            value[key] = None
    # Existing aggregate_bucket derives cost_complete from a numeric cost alone.
    # Explicit aggregate observations and full-incurred-cost coverage are separate.
    value["cost_complete"] = (bool(records) and len(results) == len(records)
                              and all(m.get("cost_complete") is True for m in metrics))
    value["usage_complete"] = (bool(records) and len(results) == len(records)
                               and all(m.get("usage_complete") is True for m in metrics))
    completeness = [m.get("incurred_cost_complete") for m in metrics]
    value["incurred_cost_complete"] = (False if False in completeness else True
                                       if records and len(results) == len(records)
                                       and all(v is True for v in completeness) else None)
    value["admitted_attempts"] = len(records)
    value["unfinished_attempts"] = len(records) - len(results)
    value["strict_pass_rate"] = value["strict_passes"] / len(records) if records else None
    value["runtime_clean"] = sum(runtime_clean(r) for r in results)
    value["strict_runtime_clean"] = sum(clean_pass(r) for r in results)
    value["accounting_sources"] = sorted({m.get("accounting_source") or "unknown" for m in metrics})
    value["accounting_incomplete_attempts"] = sum(m.get("accounting_incomplete") is True for m in metrics)
    value["cost_complete_attempts"] = sum(m.get("cost_complete") is True for m in metrics)
    value["usage_complete_attempts"] = sum(m.get("usage_complete") is True for m in metrics)
    value["physical_attempt_records"] = (harness.sum_known(
        len(m["physical_attempts"]) if "physical_attempts" in m else None for m in metrics)
        if len(results) == len(records) else None)
    value["unsettled_attempts"] = (harness.sum_known(m.get("unsettled_attempts") for m in metrics)
                                    if len(results) == len(records) else None)
    return value


def accuracy(cells, assisted=False):
    records = [r for c in cells if (r := selected_record(c, assisted)) is not None]
    outcomes = [outcome(r) for r in records]
    return {
        "expected_cells": len(cells),
        "completed_cells": sum(o["completed"] for o in outcomes),
        **{key: sum(o[key] for o in outcomes)
           for key in ("strict_pass", "runtime_clean", "strict_runtime_clean")},
        "strict_pass_rate": sum(o["strict_pass"] for o in outcomes) / len(cells) if cells else None,
        "strict_runtime_clean_rate": sum(o["strict_runtime_clean"] for o in outcomes) / len(cells) if cells else None,
    }


def physical_price_key(records, expected_source):
    """One explicit profile/basis for this physical source, never None == None."""
    keys = set()
    for record in records:
        metrics = (result_of(record) or {}).get("metrics") or {}
        estimates = metrics.get("api_price_estimates") or []
        if metrics.get("accounting_source") != expected_source or not estimates:
            return None
        for estimate in estimates:
            key = (estimate.get("profile_id"), estimate.get("basis"))
            if not all(isinstance(value, str) and value.strip() for value in key):
                return None
            if metrics.get("cost_basis") != key[1]:
                return None
            keys.add(key)
    return next(iter(keys)) if len(keys) == 1 else None


def matched(cells, tasks, assisted=False):
    by_key = {(c["task_id"], c["variant"]): c for c in cells}
    paired_ids = [task for task in tasks if all(
        clean_pass(result_of(selected_record(by_key[task, variant], assisted))) for variant in VARIANTS)]
    arms, price_keys = {}, {}
    sources = {"current": "native_request_receipts", "vanilla": "instrumented_physical_attempts"}
    for variant in VARIANTS:
        selected = [by_key[task, variant] for task in paired_ids]
        # Assisted-cohort spend includes the failed primary, not just its retry.
        records = ([r for c in selected for r in c["attempts"]] if assisted
                   else [selected_record(c) for c in selected])
        arms[variant] = activity(records)
        price_keys[variant] = physical_price_key(records, sources[variant])
    costs = [arms[v]["api_cost"]["total"] for v in VARIANTS]
    same_price = price_keys["current"] is not None and price_keys["current"] == price_keys["vanilla"]
    complete = all(arms[v]["incurred_cost_complete"] is True for v in VARIANTS)
    comparable = same_price and complete and all(numeric(v) for v in costs)
    return {
        "task_ids": paired_ids,
        "cost_scope": "all attempts of matched cells" if assisted else "first primaries only",
        "variants": arms,
        "comparison_price": {"profile_id": price_keys["current"][0], "basis": price_keys["current"][1]}
        if same_price else None,
        "cost_comparable": comparable,
        "current_over_vanilla_cost": costs[0] / costs[1] if comparable and costs[1] > 0 else None,
    }


def report(manifest, cells):
    variants = tuple(manifest.get("variants", VARIANTS))
    expected_primaries = len(manifest["tasks"]) * len(MODELS) * len(variants)
    paired = variants == VARIANTS
    groups = []
    for label, *_ in MODELS:
        model_cells = [c for c in cells if c["model"] == label]
        arms = {}
        for variant in variants:
            selected = [c for c in model_cells if c["variant"] == variant]
            retained = [r for c in selected for r in c["attempts"]]
            arms[variant] = {
                "first_primary_accuracy": accuracy(selected),
                "retry_assisted_accuracy": accuracy(selected, True),
                "first_primaries": activity([c["attempts"][0] for c in selected if c["attempts"]]),
                "retry_overhead": activity([r for r in retained if r["number"] == 2]),
                "all_incurred": activity(retained),
                "runtime_outcomes": [{"task_id": c["task_id"], "attempt": r["number"],
                                      "kind": r["kind"], "raw_dir": r["raw_dir"], **outcome(r)}
                                     for c in selected for r in c["attempts"]],
            }
        groups.append({"model": label, "variants": arms,
                       "matched_clean_first_primary": matched(model_cells, manifest["tasks"]) if paired else None,
                       "matched_clean_retry_assisted": matched(model_cells, manifest["tasks"], True) if paired else None})
    primaries = [c["attempts"][0] for c in cells if c["attempts"]]
    retained = [r for c in cells for r in c["attempts"]]
    complete = (bool(manifest.get("completed_at")) and len(primaries) == expected_primaries
                and all(r.get("result") is not None for r in retained))
    chronology = (
        "User-requested partial restart: retained Sol/Astra retries followed the original 180 primaries; "
        "all 60 fresh DeepSeek primaries precede their retries, not all 180 merged primaries. "
        "At most one retry per failed or runtime-unclean cell."
        if manifest.get("restart_deepseek_from") else
        f"All {expected_primaries} primaries precede retries. At most one benchmark retry per failed or runtime-unclean cell.")
    return {
        "generated_at": harness.utc_now(), "campaign_root": manifest["output"],
        "finalization_pending": manifest.get("finalization_pending"),
        "complete": complete, "expected_primaries": expected_primaries,
        "completed_primaries": sum(r.get("result") is not None for r in primaries),
        "benchmark_retries": sum(r["number"] == 2 for r in retained),
        "all_incurred": activity(retained),
        "retry_overhead": activity([r for r in retained if r["number"] == 2]),
        "groups": groups,
        "notes": [
            "Primary is the first benchmark invocation, even if capacity-invalid.",
            chronology,
            *(["Discarded source DeepSeek cells and fees are excluded; their raw artifacts stay in the source output."]
               if manifest.get("restart_deepseek_from") else []),
            "Retry-assisted selects the sole retry when present, never the best result.",
            f"Accuracy denominators include all {len(manifest['tasks'])} selected tasks, including invalid, failed and unrun cells.",
            ("Cost comparisons use only strict-passing, runtime-clean cells completed in both harnesses." if paired else
             "No stock arm was run. Comparisons with historical cells are reported separately, not as a contemporaneous paired campaign."),
            "Cost ratios also require one matching explicit profile/basis and each arm's distinct physical accounting source.",
            "All-incurred and retry-overhead totals include failures and invalids; they are not cost rankings.",
            "Physical provider recoveries stay in raw metrics; they are not benchmark retries.",
            "Known price subtotals do not establish whole-invocation cost. Missing or unfinished costs remain unknown.",
            "USD is API-equivalent estimated cost, not a cash subscription charge.",
        ],
    }


def save(output, manifest, cells):
    harness.json_dump(output / "invocation.json", manifest)
    harness.json_dump(output / "results.json", cells)
    value = report(manifest, cells)
    harness.json_dump(output / "summary.json", value)
    title = "MEDIUM subset regression" if manifest.get("run_kind") == "new-subset-regression" else "Paired MEDIUM reference"
    lines = [f"# {title}", "", f"Complete: {value['complete']}",
             *([f"Unfinalized: {value['finalization_pending']}"] if value["finalization_pending"] else []),
             f"First primaries: {value['completed_primaries']}/{value['expected_primaries']}; benchmark retries: {value['benchmark_retries']}", "",
             "| Model | Harness | First strict | First strict + clean | Retry-assisted strict + clean |",
             "| --- | --- | --- | --- | --- |"]
    for group in value["groups"]:
        for variant, arm in group["variants"].items():
            first, assisted = arm["first_primary_accuracy"], arm["retry_assisted_accuracy"]
            count = first["expected_cells"]
            lines.append(f"| {group['model']} | {variant} | {first['strict_pass']}/{count} | "
                         f"{first['strict_runtime_clean']}/{count} | {assisted['strict_runtime_clean']}/{count} |")
    lines += ["", *["- " + note for note in value["notes"]], "",
              "See summary.json for matched cohorts, all costs, completeness, runtime outcomes and retry overhead.",
              "See results.json and each raw_dir for every attempt, including unfinished and failed activity.",
              "See invocation.json for exact hosts, versions, configuration and price profiles."]
    (output / "SUMMARY.md").write_text("\n".join(lines) + "\n")


def restart_source(source):
    """Read the existing campaign, without waiting for or controlling its controller."""
    manifest = json.loads((source / "invocation.json").read_text())
    cells = json.loads((source / "results.json").read_text())
    if (manifest.get("schema") != "prime-context.python-realworld-paired-medium-reference/v1"
            or manifest.get("restart_deepseek_from")
            or manifest.get("tasks") != list(range(1, 31))):
        raise ValueError("restart source must be the original full paired reference")
    retained = [c for c in cells if c["model"] in ("sol", "astra")]
    expected = {(task, label, variant) for task in range(1, 31)
                for label in ("sol", "astra") for variant in VARIANTS}
    if len(retained) != 120 or {(c["task_id"], c["model"], c["variant"]) for c in retained} != expected:
        raise ValueError("restart source must contain all 120 retained Sol/Astra cells")
    for cell in retained:
        cell.setdefault("source_output", str(source))
    return manifest, retained


def prepare_deepseek_restart(manifest):
    source = Path(manifest["restart_deepseek_from"]).resolve()
    if source == Path(manifest["output"]).resolve():
        raise ValueError("restart source and fresh output must differ")
    original, retained = restart_source(source)
    if manifest["hosts"]["vanilla"] != original["hosts"]["vanilla"]:
        raise ValueError("DeepSeek restart must use the same instrumented private stock host")
    if not original.get("api_price_profiles") or manifest["api_price_profiles"] != original["api_price_profiles"]:
        raise ValueError("DeepSeek restart must keep the source price profiles unchanged")
    manifest.update({
        "mode": "deepseek-only-restart", "restart_deepseek_from": str(source),
        "retained_source_manifest": original,
        "new_work_models": ["deepseek"], "new_work_expected_primaries": 60,
        "retained_models": ["sol", "astra"], "retained_expected_primaries": 120,
        "discarded_source_models": ["deepseek"],
        "source_outputs": [str(source), manifest["output"]],
        "current_commits_by_model": {"sol": original["candidate_commit"],
                                     "astra": original["candidate_commit"],
                                     "deepseek": manifest["candidate_commit"]},
        "host_and_price_metadata_scope": "new DeepSeek work only; retained_source_manifest describes Sol/Astra",
        "new_work_candidate_commit": manifest.pop("candidate_commit"),
        "max_workers": 2, "max_active_per_pair": 1,
        "scheduling": "two independent sequential DeepSeek queues; retained Sol/Astra remain in source controller",
        "retry_policy": "one retry per non-strict or runtime-unclean fresh DeepSeek cell after all 60 new primaries",
        "chronology": "user-requested partial restart; retained OpenAI retries followed original 180 primaries, "
                      "not all valid merged primaries; old DeepSeek cells are discarded",
        "finalization_pending": "fresh DeepSeek work and retained source completion required",
    })
    return retained


def trials_finalized(cells, labels):
    expected = {(task, label, variant) for task in range(1, 31) for label in labels for variant in VARIANTS}
    if len(cells) != len(expected) or {(c["task_id"], c["model"], c["variant"]) for c in cells} != expected:
        return False
    for cell in cells:
        attempts = cell["attempts"]
        if not attempts or any(result_of(r) is None for r in attempts):
            return False
        numbers = [1] if clean_pass(result_of(attempts[0])) else [1, 2]
        if [r["number"] for r in attempts] != numbers:
            return False
    return True


def finalize_deepseek_restart(output):
    """Report-only merge. Never admits work; a pending source needs a later explicit call."""
    manifest = json.loads((output / "invocation.json").read_text())
    if not manifest.get("restart_deepseek_from"):
        raise ValueError("output is not a DeepSeek-only restart")
    cells = json.loads((output / "results.json").read_text())
    # Completed merged outputs are not refreshed from a later source mutation.
    if manifest.get("completed_at"):
        if not trials_finalized(cells, ("sol", "astra", "deepseek")):
            raise ValueError("completed restart output is missing finalized trials")
        return True
    if not manifest.get("new_work_completed_at"):
        raise ValueError("DeepSeek dispatcher has not finished; leave its live output untouched")
    reason = None
    try:
        original, retained = restart_source(Path(manifest["restart_deepseek_from"]))
        cells = retained + [c for c in cells if c["model"] == "deepseek"]
        manifest["retained_source_manifest"] = original
        if not original.get("completed_at") or not trials_finalized(retained, ("sol", "astra")):
            reason = "source Sol/Astra trials or source completed_at are not finalized"
    except (OSError, ValueError) as exc:
        # Source save is not atomic. Do not poll or rerun models if a snapshot is unavailable.
        reason = f"source snapshot unavailable: {exc}"
    if not trials_finalized([c for c in cells if c["model"] == "deepseek"], ("deepseek",)):
        reason = "fresh DeepSeek trials are not finalized"
    manifest["finalization_pending"] = reason
    if reason is None:
        manifest["completed_at"] = harness.utc_now()
    save(output, manifest, cells)
    if reason:
        print(f"UNFINALIZED: {reason}; DeepSeek results preserved. Run --finalize-deepseek-restart later.", flush=True)
    return reason is None


def run_campaign(args, scenarios, manifest, runner=None):
    """Use one-attempt runner only: run_case has a different retry/primary contract."""
    runner = runner or harness.safe_run_attempt
    tasks = sorted(scenarios)
    variants = tuple(manifest.get("variants", VARIANTS))
    if tasks != list(range(1, 31)) and manifest.get("run_kind") != "new-subset-regression":
        raise ValueError("paired reference requires all 30 task IDs")
    if tasks != manifest["tasks"] or not tasks or set(tasks) - set(range(1, 31)):
        raise ValueError("campaign tasks must match the declared benchmark selection")
    if variants not in (VARIANTS, ("current",)):
        raise ValueError("campaign variants must be current or current,vanilla")
    cells = [{"task_id": task, "model": label, "variant": variant, "attempts": []}
             for task in tasks for label, *_ in MODELS for variant in variants]
    restart = bool(manifest.get("restart_deepseek_from"))
    active_models = [model for model in MODELS if not restart or model[0] == "deepseek"]
    if restart:
        cells = prepare_deepseek_restart(manifest) + [c for c in cells if c["model"] == "deepseek"]
        for cell in cells:
            cell.setdefault("source_output", manifest["output"])
    active_cells = [c for c in cells if c["model"] in {model[0] for model in active_models}]
    configured = {}
    for label, provider, model, *_ in active_models:
        setting = copy.deepcopy(args)
        setting.provider, setting.model, setting.thinking = provider, model, "medium"
        configured[label] = setting
    save(args.output, manifest, cells)

    def execute(cell, record):
        task_dir, scenario = scenarios[cell["task_id"]]
        attempt_dir = Path(record["raw_dir"])
        try:
            return runner(cell["variant"], task_dir, copy.deepcopy(scenario), attempt_dir,
                          copy.deepcopy(configured[cell["model"]]))
        except Exception as exc:
            # A collector failure must not erase its raw sessions or trigger another task retry.
            result = {"task_id": cell["task_id"], "variant": cell["variant"],
                      "error": f"{type(exc).__name__}: {exc}",
                      "judge": {"status": "error", "progress_level": 0},
                      "metrics": {"accounting_incomplete": True, "incurred_cost_complete": False}}
            harness.json_dump(attempt_dir / "orchestrator-error.json", result)
            return result

    queue_count = len(variants) * len(active_models)
    with concurrent.futures.ThreadPoolExecutor(max_workers=queue_count) as executor:
        def dispatch(selected, number):
            queues = {}
            for cell in selected:
                queues.setdefault((cell["model"], cell["variant"]), deque()).append(cell)
            futures = {}

            def submit_next(pair):
                if not queues[pair]:
                    return
                cell = queues[pair].popleft()
                scenario = scenarios[cell["task_id"]][1]
                raw = (args.output / "medium" / cell["model"] /
                       f"task-{cell['task_id']:02d}-{scenario['slug']}" / cell["variant"] / f"attempt-{number}")
                raw.mkdir(parents=True, exist_ok=True)
                cell["attempts"].append({"number": number, "kind": "primary" if number == 1 else "benchmark_retry",
                                         "raw_dir": str(raw), "result_path": str(raw / "result.json"),
                                         "result": None})
                save(args.output, manifest, cells)
                futures[executor.submit(execute, cell, cell["attempts"][-1])] = cell

            for pair in queues:
                submit_next(pair)
            while futures:
                done, _ = concurrent.futures.wait(futures, return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    cell = futures.pop(future)
                    record = cell["attempts"][-1]
                    record["result"] = future.result()
                    # safe_run_attempt writes this too. Persist fake/collector-failure outcomes identically.
                    path = Path(record["result_path"])
                    if not path.exists():
                        harness.json_dump(path, record["result"])
                    save(args.output, manifest, cells)
                    print(f"finished {cell['model']} task {cell['task_id']:02d} {cell['variant']} "
                          f"attempt {number}: clean_pass={clean_pass(record['result'])}", flush=True)
                    submit_next((cell["model"], cell["variant"]))

        print(f"starting MEDIUM primaries in {queue_count} independent model/variant queues", flush=True)
        dispatch(active_cells, 1)
        manifest["new_work_primaries_completed_at" if restart else "primaries_completed_at"] = harness.utc_now()
        retry_queue = [c for c in active_cells if not clean_pass(result_of(selected_record(c)))]
        manifest["retry_queue"] = [{k: c[k] for k in ("task_id", "model", "variant")} for c in retry_queue]
        save(args.output, manifest, cells)
        dispatch(retry_queue, 2)
    manifest["new_work_completed_at" if restart else "completed_at"] = harness.utc_now()
    save(args.output, manifest, cells)
    if restart:
        finalize_deepseek_restart(args.output)
        cells = json.loads((args.output / "results.json").read_text())
    return cells


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tasks", default="all", help="Task IDs/ranges for a newly qualified regression (default: all)")
    parser.add_argument("--variants", choices=("current,vanilla", "current"), default="current,vanilla")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--restart-deepseek-from", type=Path, metavar="OLD_OUTPUT")
    mode.add_argument("--finalize-deepseek-restart", action="store_true",
                      help="report-only merge for --output; no provider calls")
    parser.add_argument("--hosts-manifest", type=Path)
    parser.add_argument("--api-price-profiles", dest="api_price_profiles_file", type=Path)
    parser.add_argument("--host-openai-codex-auth-file", type=Path)
    parser.add_argument("--host-deepseek-api-key-file", type=Path)
    parser.add_argument("--bwrap", default=shutil.which("bwrap") or "")
    parser.add_argument("--admit-provider-calls", action="store_true")
    parser.add_argument("--qualified-current-commit", help="Explicit clean SDK pin for a new method replication, not the historical mixed reference")
    parser.add_argument("--qualification-complete", action="store_true",
                        help="Acknowledge completed host/accounting qualification; does not replace archive checks")
    args = parser.parse_args()
    args.output = args.output.expanduser().resolve()
    subset = args.tasks != "all" or args.variants != "current,vanilla"
    if subset and (args.restart_deepseek_from or args.finalize_deepseek_restart):
        parser.error("task/variant selection cannot alter the historical DeepSeek restart")
    if subset and not args.qualified_current_commit:
        parser.error("task/variant selection requires --qualified-current-commit for a new regression")
    if args.finalize_deepseek_restart:
        if args.admit_provider_calls:
            parser.error("report-only finalization does not accept --admit-provider-calls")
        try:
            return 0 if finalize_deepseek_restart(args.output) else 2
        except (OSError, ValueError) as exc:
            parser.error(str(exc))
    if args.restart_deepseek_from:
        args.restart_deepseek_from = args.restart_deepseek_from.expanduser().resolve()
        if args.restart_deepseek_from == args.output:
            parser.error("restart source and fresh output must differ")
    for option in ("hosts_manifest", "api_price_profiles_file", "host_openai_codex_auth_file",
                   "host_deepseek_api_key_file"):
        if getattr(args, option) is None:
            parser.error(f"{option} is required for provider work")
    if not args.admit_provider_calls:
        parser.error("--admit-provider-calls is required; this command starts the one paired campaign")
    if not args.bwrap:
        parser.error("bubblewrap is required")
    args.timeout_seconds = 1800
    variants = tuple(args.variants.split(","))
    args.api_price_profiles = json.loads(args.api_price_profiles_file.read_text())
    if not isinstance(args.api_price_profiles, list) or not args.api_price_profiles or any(
            not isinstance(p, dict) for p in args.api_price_profiles):
        parser.error("price profiles must be a nonempty JSON array of profile objects")
    if args.qualified_current_commit and not args.qualification_complete:
        parser.error("a new SDK pin requires completed qualification and --qualification-complete")
    hosts = harness.apply_hosts_manifest(args)
    expected_commit = args.qualified_current_commit or CURRENT_COMMIT
    if hosts["candidate_commit"] != expected_commit:
        parser.error(f"this run requires the clean CURRENT build {expected_commit}")
    if "vanilla" in variants:
        vanilla = hosts["hosts"]["vanilla"]
        if not vanilla.get("accounting_patch"):
            parser.error("hosts.vanilla.accounting_patch must identify the separate accounting hotpatch")
        if vanilla["package_name"] != "prime-agent" or vanilla["version"] != "0.9.4":
            parser.error("this reference requires separately accounting-hotpatched public Prime Agent 0.9.4")
    # Metadata only: the existing runner reads credentials only inside its native provider process.
    for key in ("host_openai_codex_auth_file", "host_deepseek_api_key_file"):
        path = getattr(args, key).expanduser().resolve(strict=True)
        if not path.is_file():
            parser.error(f"{key} must name an existing file")
        setattr(args, key, path)
    benchmark_python = harness.require_python312()
    scenarios = harness.load_scenarios(harness.ROOT, require_complete=True)
    try:
        selected_tasks = harness.parse_task_ids(args.tasks, scenarios)
    except ValueError as exc:
        parser.error(str(exc))
    scenarios = {task: scenarios[task] for task in selected_tasks}
    args.output = args.output.resolve()
    if args.output.exists() and any(args.output.iterdir()):
        parser.error("output must be fresh and empty; no resume or automatic second campaign")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "prime-context.python-realworld-paired-medium-reference/v1",
        "run_kind": ("new-subset-regression" if subset else
                     "new-method-replication" if args.qualified_current_commit else "historical-reference-protocol"),
        "started_at": harness.utc_now(), "output": str(args.output),
        "tasks": sorted(scenarios), "variants": list(variants), "phases": ["medium"], "thinking": "medium",
        "models": [{"label": label, "provider": provider, "model": model,
                    "expected_provider_api": api, "expected_auth_route": route,
                    "logical_effort": "medium", "expected_wire_effort": "high" if label == "deepseek" else "medium"}
                   for label, provider, model, api, route in MODELS],
        "expected_primaries": len(scenarios) * len(MODELS) * len(variants),
        "max_workers": len(MODELS) * len(variants), "max_active_per_pair": 1,
        "scheduling": f"{len(MODELS) * len(variants)} independent sequential queues for primaries and deferred retries",
        "queue_key": ["model", "variant"], "primary_task_order": "ascending task ID per pair",
        "worker_unit": "harness/model/task/attempt", "retry_failed": 1,
        "primary_policy": "first attempt including invalid; never first capacity-valid or best",
        "retry_policy": "one retry after all primaries for non-strict-pass or runtime-unclean cells; invalids consume the retry",
        "timeout_seconds": 1800, "task_deadlines": "unchanged pressure-specific min(task timeout, 1800)",
        "tool_network": "loopback-only", "rpc_adapter": "external-sdk-runtime",
        "bwrap_executable": str(Path(args.bwrap).resolve()), "benchmark_python": benchmark_python,
        "provider_calls_admitted": True,
        "hosts_manifest": str(args.hosts_manifest), "host_manifest_snapshot": hosts,
        "hosts": hosts["hosts"], "candidate_commit": hosts["candidate_commit"],
        "node_executable": hosts["node_executable"], "node_version": hosts.get("node_version"),
        "api_price_profiles_file": str(args.api_price_profiles_file.resolve()), "api_price_profiles": args.api_price_profiles,
        "orchestrator": str(Path(__file__).resolve()), "runner": str(harness.ROOT / "run.py"),
        "raw_layout": "medium/{model}/task-{id:02d}-{slug}/{variant}/attempt-{1|2}",
        "raw_config": "each attempt config/settings.json, config/models.json and rpc-bootstrap.mjs",
        "freeze_policy": "new output only; existing frozen benchmark results are never modified",
    }
    if args.restart_deepseek_from:
        manifest["restart_deepseek_from"] = str(args.restart_deepseek_from)
    try:
        run_campaign(args, scenarios, manifest)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    final_manifest = json.loads((args.output / "invocation.json").read_text())
    return 0 if final_manifest.get("completed_at") else 2


if __name__ == "__main__":
    raise SystemExit(main())
