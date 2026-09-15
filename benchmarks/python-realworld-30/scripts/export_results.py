#!/usr/bin/env python3
"""Export allowlisted benchmark numbers. Never copy native result objects."""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from datetime import datetime
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH))
from paired_medium_reference import outcome

COUNTERS = ("session_compactions", "compaction_completions", "compaction_failures",
            "compaction_requests", "child_sessions", "session_count")
TIMES = ("agent_wall_seconds", "lifecycle_wall_seconds")
FLAGS = ("completed", "strict_pass", "runtime_clean", "strict_runtime_clean")
MODELS = {"astra": "gpt-6-astra", "deepseek": "deepseek-flash", "sol": "gpt-5.6-sol"}
PROFILES = {p["id"]: p["basis"] for p in json.loads((BENCH / "api-price-profiles.json").read_text())}


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def total(values):
    return sum(values) if all(v is not None for v in values) else None


def tally(rows, field):
    values = [number(r.get(field)) for r in rows]
    known = [v for v in values if v is not None]
    return {"total": total(values), "known_subtotal": sum(known) if known else None,
            "observed_attempts": len(known), "attempts": len(values)}


def safe_outcome(record):
    # outcome() implements the original strict and runtime-clean rules.
    value = outcome(record)
    return {key: bool(value[key]) for key in FLAGS}


def attempt_row(cell, record):
    result = record.get("result") or {}
    metrics = result.get("metrics") or {}
    prices = metrics.get("api_price_estimates") or []
    profiles = {p.get("profile_id") for p in prices}
    if not profiles <= PROFILES.keys() or any(PROFILES[p["profile_id"]] != p.get("basis") for p in prices):
        raise ValueError("Unknown price profile/basis; review the public profile list first")
    row = {"task_id": cell["task_id"], "model": cell["model"], "harness": cell["variant"],
           "attempt": record["number"], **safe_outcome(record),
           "capacity_invalid": result.get("capacity_invalid") if type(result.get("capacity_invalid")) is bool else None,
           "runtime_error_present": result.get("error") is not None,
           "whole_cost_complete": metrics.get("incurred_cost_complete") is True,
           "whole_cost_usd": number((metrics.get("api_cost") or {}).get("total"))
                             if metrics.get("incurred_cost_complete") is True else None,
           "known_cost_subtotal_usd": total([number(p.get("known_subtotal")) for p in prices]) if prices else None,
           "price_profile": ";".join(sorted(profiles)),
           "price_observations": total([number(p.get("observations")) for p in prices]) if prices else None,
           "unpriced_observations": total([number(p.get("unpriced_observations")) for p in prices]) if prices else None}
    row.update({key: number(result.get(key)) for key in TIMES})
    row.update({key: number(metrics.get(key)) for key in COUNTERS})
    return row


def span(records):
    # Runner-error fallback timestamps do not represent invocation boundaries.
    first, last = records[0].get("result") or {}, records[-1].get("result") or {}
    if number(first.get("lifecycle_wall_seconds")) is None or number(last.get("lifecycle_wall_seconds")) is None:
        return None
    try:
        value = (datetime.fromisoformat(last["completed_at"]) - datetime.fromisoformat(first["started_at"])).total_seconds()
        return number(value)
    except (KeyError, TypeError, ValueError):
        return None


def summarize(cells, attempts):
    out = {"cells": len(cells), "attempts": len(attempts), "retries": len(attempts) - len(cells)}
    for stage in ("primary", "terminal"):
        out[stage] = {key: sum(c[f"{stage}_{key}"] for c in cells) for key in FLAGS}
    out["whole_cost_complete_attempts"] = sum(a["whole_cost_complete"] for a in attempts)
    out["unknown_cost_attempts"] = len(attempts) - out["whole_cost_complete_attempts"]
    out["whole_cost_usd"] = total([a["whole_cost_usd"] for a in attempts])
    out["known_cost_subtotal_usd"] = sum(a["known_cost_subtotal_usd"] for a in attempts if a["known_cost_subtotal_usd"] is not None)
    out["known_cost_subtotal_observed_attempts"] = sum(a["known_cost_subtotal_usd"] is not None for a in attempts)
    out["price_profiles"] = sorted({a["price_profile"] for a in attempts if a["price_profile"]})
    out["timing"] = {key: tally(attempts, key) for key in TIMES}
    out["retry_timing"] = {key: tally([a for a in attempts if a["attempt"] > 1], key) for key in TIMES}
    out["counters"] = {key: tally(attempts, key) for key in COUNTERS}
    seconds = out["timing"]["lifecycle_wall_seconds"]["total"]
    out["cumulative_attempt_hours"] = seconds / 3600 if seconds is not None else None
    passes = out["terminal"]["strict_pass"]
    out["attempt_minutes_per_terminal_strict_pass"] = seconds / 60 / passes if seconds is not None and passes else None
    return out


def export_rows(raw_cells):
    cells, attempts = [], []
    for cell in sorted(raw_cells, key=lambda c: (c["task_id"], c["model"], c["variant"])):
        if cell["model"] not in MODELS or cell["variant"] not in ("current", "vanilla"):
            raise ValueError("Unexpected model or harness")
        if type(cell["task_id"]) is not int or not 1 <= cell["task_id"] <= 30:
            raise ValueError("Unexpected task ID")
        records = sorted(cell["attempts"], key=lambda r: r["number"])
        if [r["number"] for r in records] not in ([1], [1, 2]):
            raise ValueError("Expected first primary and at most one terminal retry")
        rows = [attempt_row(cell, r) for r in records]
        attempts.extend(rows)
        row = {"task_id": cell["task_id"], "model": cell["model"], "harness": cell["variant"],
               "attempts": len(rows), "retries": len(rows) - 1}
        for stage, selected in (("primary", rows[0]), ("terminal", rows[-1])):
            row.update({f"{stage}_{key}": selected[key] for key in FLAGS})
        row["primary_span_seconds"] = span(records[:1])
        row["terminal_span_seconds"] = span(records)
        row["whole_cost_usd"] = total([a["whole_cost_usd"] for a in rows])
        row["known_cost_subtotal_usd"] = total([a["known_cost_subtotal_usd"] for a in rows])
        row["whole_cost_complete_attempts"] = sum(a["whole_cost_complete"] for a in rows)
        row["price_profile"] = ";".join(sorted({a["price_profile"] for a in rows if a["price_profile"]}))
        for stage, selected in (("primary", rows[:1]), ("all", rows)):
            for key in (*TIMES, *COUNTERS):
                values = tally(selected, key)
                row[f"{stage}_{key}"] = values["total"]
                row[f"{stage}_{key}_known_subtotal"] = values["known_subtotal"]
                row[f"{stage}_{key}_observed_attempts"] = values["observed_attempts"]
        cells.append(row)
    groups = []
    for model in (*sorted(MODELS), "TOTAL"):
        for harness in ("current", "vanilla"):
            selected = [c for c in cells if c["harness"] == harness and (model == "TOTAL" or c["model"] == model)]
            if selected:
                charged = [a for a in attempts if a["harness"] == harness and (model == "TOTAL" or a["model"] == model)]
                groups.append({"model": model, "harness": harness, **summarize(selected, charged)})
    return cells, attempts, {"schema": "python-realworld-30-public/v1", "cells": len(cells),
                             "effective_attempts": len(attempts), "models": MODELS, "groups": groups}


def display(value):
    if value is None:
        return "UNKNOWN"
    if type(value) is bool:
        return "1" if value else "0"
    return str(value)


def write_csv(path, rows):
    fields = [key for key in rows[0] if any(row.get(key) is not None for row in rows)]
    with path.open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows({k: display(row[k]) for k in fields} for row in rows)


def write_markdown(path, cells):
    fields = ["task_id", "model", "harness", "attempts", "retries",
              "primary_strict_pass", "primary_runtime_clean", "primary_strict_runtime_clean",
              "terminal_strict_pass", "terminal_runtime_clean", "terminal_strict_runtime_clean",
              "all_agent_wall_seconds", "all_lifecycle_wall_seconds", "terminal_span_seconds",
              "whole_cost_usd", "known_cost_subtotal_usd", "whole_cost_complete_attempts",
              "all_session_compactions", "all_compaction_completions", "all_compaction_failures",
              "all_compaction_requests", "all_child_sessions", "all_session_count"]
    fields = [key for key in fields if any(c[key] is not None for c in cells)]
    lines = ["# Detailed cells", "", "All cells, sorted by task/model/harness. 1 = true; 0 = false. UNKNOWN is not zero.",
             "Times and counters prefixed `all_` charge every attempt, including retries and failures.",
             "`terminal_span_seconds` includes deferred queue waits. It does not mean clean completion.",
             "Compaction session entries include CURRENT working-set materializations, not only LLM summaries.",
             "CSV contains full precision and per-counter attempt coverage; see [methodology](../REPORT.md).", "",
             "| " + " | ".join(fields) + " |", "| " + " | ".join("---" for _ in fields) + " |"]
    for row in cells:
        lines.append("| " + " | ".join(f"{row[k]:.6f}" if type(row[k]) is float else display(row[k]) for k in fields) + " |")
    path.write_text("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Local paired-driver output directory; stays private")
    parser.add_argument("--output", type=Path, required=True, help="Public numeric export directory")
    args = parser.parse_args()
    cells, attempts, summary = export_rows(json.loads((args.input / "results.json").read_text()))
    args.output.mkdir(parents=True, exist_ok=True)
    write_csv(args.output / "cells.csv", cells)
    write_csv(args.output / "attempts.csv", attempts)
    write_markdown(args.output / "cells.md", cells)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")
    print(f"Exported {len(cells)} cells and {len(attempts)} effective attempts")


if __name__ == "__main__":
    main()
