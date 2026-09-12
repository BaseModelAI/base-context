#!/usr/bin/env python3
"""Read-only live or completed model/harness comparison; never starts benchmark work."""
from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import run as harness


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def runtime_clean(attempt):
    return ("error" in attempt and attempt["error"] is None
            and attempt.get("capacity_invalid") is False
            and (attempt.get("metrics") or {}).get("compaction_failures") == 0)


def nonpass_or_error(attempt):
    failures = (attempt.get("metrics") or {}).get("compaction_failures")
    return (not harness.strict_pass(attempt) or attempt.get("error") is not None
            or attempt.get("capacity_invalid") is True or (numeric(failures) and failures > 0))


def bucket(attempts):
    if not attempts:
        return {"runs": 0, "strict_passes": 0, "runtime_clean": 0}
    value = harness.aggregate_bucket([({}, attempt) for attempt in attempts])
    metrics = [attempt.get("metrics") or {} for attempt in attempts]
    usage = [m.get("provider_usage") if m.get("accounting_source") == "native_request_receipts"
             else m.get("observed_provider_usage") for m in metrics]
    value["display_usage"] = {key: harness.sum_known((u or {}).get(key) for u in usage)
                              for key in ("inputTotal", "output", "cacheRead", "cacheWrite", "totalTokens")}
    value["observed_model_calls"] = harness.sum_known(m.get("observed_model_calls") for m in metrics)
    value["runtime_clean"] = sum(runtime_clean(a) for a in attempts)
    value["accounting_sources"] = sorted({m.get("accounting_source") or "unknown" for m in metrics})
    value["usage_coverage"] = sum(m.get("usage_complete") is True for m in metrics)
    return value


def read_json(path, pending):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        # A live writer may not have finished a result. Never promote its retry.
        pending.append(str(path))
        return None


def load_group(directory, variants, pending):
    rows = []
    for variant in variants:
        for case_dir in sorted(directory.glob(f"task-*/{variant}")):
            attempts, numbers, unfinished, unreadable = [], [], 0, False
            for attempt_dir in sorted(case_dir.glob("attempt-*"), key=lambda p: int(p.name.split("-")[-1])):
                path = attempt_dir / "result.json"
                if not path.exists():
                    unfinished += 1
                    continue
                value = read_json(path, pending)
                if value is None:
                    unreadable = True
                    continue
                attempts.append(value)
                numbers.append(int(attempt_dir.name.split("-")[-1]))
            task_id = attempts[0]["task_id"] if attempts else int(case_dir.parent.name.split("-")[1])
            row = {"task_id": task_id, "variant": variant, "attempts": attempts,
                   "attempt_numbers": numbers, "unfinished": unfinished}
            row["primary"] = None if unreadable else harness.primary_attempt(row)
            rows.append(row)
    return rows


def paired(rows, tasks, candidate, baseline, clean_only=False):
    primaries = {(r["task_id"], r["variant"]): r["primary"] for r in rows}
    pairs = [(task, primaries.get((task, candidate)), primaries.get((task, baseline))) for task in tasks]
    pairs = [(t, c, b) for t, c, b in pairs if c and b and harness.strict_pass(c) and harness.strict_pass(b)
             and (not clean_only or (runtime_clean(c) and runtime_clean(b)))]
    timed = [(t, c, b) for t, c, b in pairs if numeric(c.get("agent_wall_seconds")) and numeric(b.get("agent_wall_seconds"))]
    ctime = harness.sum_known(c["agent_wall_seconds"] for _, c, _ in timed)
    btime = harness.sum_known(b["agent_wall_seconds"] for _, _, b in timed)
    return {"task_ids": [t for t, _, _ in pairs], "timed_task_ids": [t for t, _, _ in timed],
            "candidate_seconds": ctime, "baseline_seconds": btime,
            "candidate_over_baseline_time": ctime / btime if btime else None,
            "candidate": bucket([c for _, c, _ in pairs]), "baseline": bucket([b for _, _, b in pairs])}


def compare(root, *, efforts=None, models=None, candidate="current", baseline="vanilla", baseline_results=None):
    baseline_root = baseline_results or root
    manifest = json.loads((root / "invocation.json").read_text())
    efforts = efforts or manifest["phases"]
    models = models or [m["label"] for m in manifest["models"]]
    tasks = manifest["tasks"]
    pending, groups, common = [], [], {}
    for effort in efforts:
        phase_rows = {}
        for model in models:
            rows = load_group(root / effort / model, (candidate,), pending)
            rows += load_group(baseline_root / effort / model, (baseline,), pending)
            rows = [r for r in rows if r["task_id"] in tasks]
            phase_rows[model] = rows
            arms, failures = {}, []
            for variant in (candidate, baseline):
                selected = [r for r in rows if r["variant"] == variant]
                primary = [r["primary"] for r in selected if r["primary"] is not None]
                retained = [a for r in selected for a in r["attempts"]]
                invalid = sum(a.get("capacity_invalid") is True for a in retained)
                arms[variant] = {"primary": bucket(primary), "all_retained": bucket(retained),
                                 "nonpass_or_error": bucket([a for a in retained if nonpass_or_error(a)]),
                                 "capacity_invalid": invalid,
                                 "valid_retries": sum(max(0, sum(a.get("capacity_invalid") is not True for a in r["attempts"]) - 1) for r in selected),
                                 "unfinished_attempts": sum(r["unfinished"] for r in selected)}
                for row in selected:
                    for number, attempt in zip(row["attempt_numbers"], row["attempts"]):
                        if nonpass_or_error(attempt):
                            failures.append({"task_id": row["task_id"], "variant": variant, "attempt": number,
                                             "primary": attempt is row["primary"], "error": attempt.get("error"),
                                             "rpc_errors": [r.get("error") for r in attempt.get("responses", [])
                                                            if r.get("success") is False and r.get("error")],
                                             "judge": (attempt.get("judge") or {}).get("status"),
                                             "capacity_invalid": attempt.get("capacity_invalid"),
                                             "compaction_failures": (attempt.get("metrics") or {}).get("compaction_failures")})
            primaries = {(r["task_id"], r["variant"]): r["primary"] for r in rows}
            scored = [(t, primaries.get((t, candidate)), primaries.get((t, baseline))) for t in tasks]
            scored = [(t, c, b) for t, c, b in scored if c and b]
            groups.append({"effort": effort, "model": model, "variants": arms, "failures": failures,
                           "scored_pairs": len(scored),
                           "gained_ids": [t for t, c, b in scored if harness.strict_pass(c) and not harness.strict_pass(b)],
                           "lost_ids": [t for t, c, b in scored if harness.strict_pass(b) and not harness.strict_pass(c)],
                           "matched_pass": paired(rows, tasks, candidate, baseline),
                           "matched_clean_pass": paired(rows, tasks, candidate, baseline, True)})
        shared = set(tasks)
        for model in models:
            shared &= set(paired(phase_rows[model], tasks, candidate, baseline)["task_ids"])
        common[effort] = {"task_ids": sorted(shared), "rows": []}
        for model in models:
            for variant in (candidate, baseline):
                values = [r["primary"] for r in phase_rows[model] if r["variant"] == variant and r["task_id"] in shared]
                common[effort]["rows"].append({"model": model, "variant": variant, "metrics": bucket(values)})
    completed = sum(arm["primary"]["runs"] for g in groups for arm in g["variants"].values())
    expected = len(efforts) * len(models) * 2 * len(tasks)
    unfinished = any(arm["unfinished_attempts"] for group in groups for arm in group["variants"].values())
    complete = bool(manifest.get("completed_at")) and completed == expected and not pending and not unfinished
    generated = datetime.now(timezone.utc)
    end = datetime.fromisoformat(manifest["completed_at"]) if manifest.get("completed_at") else generated
    elapsed = (end - datetime.fromisoformat(manifest["started_at"])).total_seconds() if manifest.get("started_at") else None
    return {"generated_at": generated.isoformat(), "campaign_elapsed_seconds": elapsed, "campaign_root": str(root),
            "baseline_root": str(baseline_root),
            "campaign_started_at": manifest.get("started_at"), "campaign_completed_at": manifest.get("completed_at"),
            "candidate_commit": manifest.get("candidate_commit"), "complete": complete,
            "completed_primary_runs": completed, "expected_primary_runs": expected, "tasks": tasks,
            "efforts": efforts, "models": models, "candidate": candidate, "baseline": baseline,
            "pending_read_files": pending, "groups": groups, "common_matched_pass": common}


def cell(value):
    if value is None:
        return "unknown"
    if isinstance(value, list):
        return ",".join(map(str, value)) or "—"
    return (f"{value:.4g}" if numeric(value) else str(value)).replace("|", r"\|").replace("\n", " ")


def table(lines, title, headings, rows):
    lines.extend(["", "## " + title, "", "| " + " | ".join(headings) + " |", "| " + " | ".join("---" for _ in headings) + " |"])
    lines.extend("| " + " | ".join(cell(v) for v in row) + " |" for row in rows)


def price(scope):
    values = []
    for item in scope.get("api_price_estimates", []):
        parts = []
        if item.get("known_subtotal") is not None:
            parts.append(f"${item['known_subtotal']:.5f}")
        bounds = item.get("conditional_range")
        if bounds:
            parts.append(f"${bounds['lower']:.5f}–${bounds['upper']:.5f} conditional")
        if item.get("unpriced_observations"):
            parts.append(f"{item['unpriced_observations']} unpriced")
        values.append("; ".join(parts) or "unknown")
    return "; ".join(values) or "unknown"


def markdown(report):
    status = "COMPLETE" if report["complete"] else "INTERIM — INCOMPLETE"
    lines = [f"# Model / harness comparison — {status}", "", f"Snapshot: {report['generated_at']}",
             f"Candidate commit: {report['candidate_commit']}",
             f"Campaign elapsed seconds: {cell(report['campaign_elapsed_seconds'])}",
             f"Completed primary runs: {report['completed_primary_runs']}/{report['expected_primary_runs']}", "",
             "Primary means first capacity-valid attempt, not best retry. Runtime-clean requires explicit error:null, capacity_invalid:false and compaction_failures:0.",
             "Speed comparisons use matched strict-passing tasks only. Failure activity stays in retained totals. Agent-time sums are not campaign elapsed time.",
             "USD is API-equivalent estimated cost, not subscription cash charges. DeepSeek uses peak-normalized pricing. Stock prices/tokens/calls cover visible messages only; hidden calls and cache-write splits remain unknown. No complete-cost winner is established."]
    if report["baseline_root"] != report["campaign_root"]:
        lines += ["", f"Retained baseline campaign: {report['baseline_root']}",
                  "Counts include retained baseline runs. Elapsed time refers to the candidate campaign. Runs from separate campaigns are not contemporaneous."]
    for effort in report["efforts"]:
        groups = [g for g in report["groups"] if g["effort"] == effort]
        progress = []
        for g in groups:
            for variant, arm in g["variants"].items():
                p = arm["primary"]
                progress.append([g["model"], variant, f"{p['runs']}/{len(report['tasks'])}", p["strict_passes"], p["runtime_clean"],
                                 arm["all_retained"]["runs"], arm["valid_retries"], arm["capacity_invalid"], arm["unfinished_attempts"]])
        table(lines, effort.upper() + " progress / primary accuracy", ["Model", "Harness", "Finished", "Pass", "Runtime-clean", "Retained", "Retries", "Capacity invalid", "Unfinished"], progress)
        if not any(g["variants"][v]["primary"]["runs"] for g in groups for v in g["variants"]):
            continue
        table(lines, effort.upper() + " paired primary accuracy", ["Model", "Scored pairs", "Candidate gained task IDs", "Candidate lost task IDs"],
              [[g["model"], g["scored_pairs"], g["gained_ids"], g["lost_ids"]] for g in groups])
        comparisons = []
        for g in groups:
            for subset in ("matched_pass", "matched_clean_pass"):
                p = g[subset]
                comparisons.append([g["model"], subset, p["task_ids"], p["candidate_seconds"], p["baseline_seconds"],
                                    p["candidate_over_baseline_time"], price(p["candidate"]), price(p["baseline"])])
        table(lines, effort.upper() + " matched candidate vs baseline", ["Model", "Subset", "Tasks", "Candidate s", "Baseline s", "Time C/B", "Candidate USD", "Baseline USD"], comparisons)
        shared = report["common_matched_pass"][effort]
        activity = []
        for row in shared["rows"]:
            m, n = row["metrics"], row["metrics"]["runs"]
            usage = m.get("display_usage") or {}
            cache = usage.get("cacheRead")
            denominator = usage.get("inputTotal")
            activity.append([row["model"], row["variant"], m.get("agent_wall_seconds") / n if n and numeric(m.get("agent_wall_seconds")) else None,
                             usage.get("inputTotal"), usage.get("output"), 100 * cache / denominator if numeric(cache) and denominator else None,
                             f"{cell(m.get('all_model_calls'))}/{cell(m.get('observed_model_calls'))}", m.get("tool_calls"),
                             "/".join(cell(m.get(k)) for k in ("compaction_requests", "compaction_completions", "compaction_failures")), price(m)])
        table(lines, effort.upper() + " common model/harness cohort — tasks " + cell(shared["task_ids"]),
              ["Model", "Harness", "Mean agent s", "Input tokens", "Output tokens", "Cache read %", "Physical/visible calls", "Tools", "Compact req/ok/fail", "Cohort USD"], activity)
        scopes = []
        for g in groups:
            for variant, arm in g["variants"].items():
                for name in ("primary", "all_retained", "nonpass_or_error"):
                    s = arm[name]
                    scopes.append([g["model"], variant, name, s["runs"], s.get("agent_wall_seconds"), s.get("lifecycle_wall_seconds"),
                                   s.get("all_model_calls"), s.get("observed_model_calls"), s.get("tool_calls"), price(s)])
        table(lines, effort.upper() + " all completed activity — unequal cohorts, not a ranking", ["Model", "Harness", "Scope", "Attempts", "Agent s", "Lifecycle s", "Physical calls", "Visible calls", "Tools", "USD"], scopes)
        failures = [[g["model"], f["variant"], f["task_id"], f["attempt"], f["primary"], f["judge"], f["capacity_invalid"],
                     f["compaction_failures"], str(f["error"] or "; ".join(f["rpc_errors"]) or "—")[:240]] for g in groups for f in g["failures"]]
        if failures:
            table(lines, effort.upper() + " retained failures / errors", ["Model", "Harness", "Task", "Attempt", "Primary", "Judge", "Capacity invalid", "Compaction failures", "Error"], failures)
    if report["pending_read_files"]:
        lines.extend(["", "Files being written or unreadable (affected primaries withheld):", *["- " + p for p in report["pending_read_files"]]])
    lines.extend(["", "Only completed attempt result files are metered here. Unfinished requests, activity and cost are not yet included.",
                  "JSON output also includes native/observed usage coverage, price-profile coverage/unpriced observations, purpose counts and matched correctness gains/losses."])
    return "\n".join(lines) + "\n"


def csv(value):
    return [part.strip() for part in value.split(",") if part.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path, help="campaign directory containing invocation.json and effort/model results")
    parser.add_argument("--efforts", type=csv, help="comma-separated effort directories; default: invocation phases")
    parser.add_argument("--models", type=csv, help="comma-separated model labels; default: invocation models")
    parser.add_argument("--candidate", default="current", help="candidate harness directory name")
    parser.add_argument("--baseline", default="vanilla", help="baseline harness directory name")
    parser.add_argument("--baseline-results", type=Path, help="read the baseline arm from a retained campaign; default: results")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    args = parser.parse_args()
    report = compare(args.results.resolve(), efforts=args.efforts, models=args.models, candidate=args.candidate, baseline=args.baseline,
                     baseline_results=args.baseline_results.resolve() if args.baseline_results else None)
    print(json.dumps(report, indent=2) if args.format == "json" else markdown(report), end="\n" if args.format == "json" else "")


if __name__ == "__main__":
    main()
