#!/usr/bin/env python3.12
"""Judge task 22 against fresh deterministic main and edge fixtures."""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

PYTHON = "/usr/bin/python3.12"
OUTPUT_LIMIT = 4096
TASK_DIR = Path(__file__).resolve().parent


def copy_candidate(workspace: Path, target: Path) -> bool:
    for relative in (Path("solution/__init__.py"), Path("solution/payroll.py")):
        source = workspace / relative
        if source.is_file():
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    return (target / "solution" / "payroll.py").is_file()


def materialize_stage(stage: str, fixture: str, workspace: Path) -> None:
    source = TASK_DIR / "stages" / stage
    with tempfile.TemporaryDirectory(prefix="pcbench-22-stage-") as td:
        payload = Path(td)
        for item in source.rglob("*"):
            rel = item.relative_to(source)
            if item.is_file() and item.name != "_generate.py":
                (payload / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, payload / rel)
        generator = source / "_generate.py"
        if generator.is_file():
            subprocess.run(
                [PYTHON, "-E", "-S", str(generator), "--output", str(payload), "--fixture", fixture],
                cwd=source, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=30,
            )
        for item in payload.rglob("*"):
            if item.is_file():
                destination = workspace / item.relative_to(payload)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, destination)


def fresh_run(candidate: Path, fixture: str) -> tuple[Path, int, str]:
    holder = Path(tempfile.mkdtemp(prefix=f"pcbench-22-{fixture}-"))
    work = holder / "workspace"
    subprocess.run(
        [PYTHON, "-E", "-S", str(TASK_DIR / "seed.py"), "--workspace", str(work), "--fixture", fixture],
        cwd=TASK_DIR, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
    )
    materialize_stage("corrections", fixture, work)
    materialize_stage("union-rules", fixture, work)
    copy_candidate(candidate, work)
    out = work / "output"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    week_ending = "2025-11-02" if fixture == "edge" else "2025-11-09"
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            completed = subprocess.run(
                [PYTHON, "-E", "-S", "-m", "solution.payroll", "inputs", "--week-ending", week_ending, "--output", "output"],
                cwd=work, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, timeout=45,
                env={"PATH": os.environ.get("PATH", "")},
            )
            code = completed.returncode
        except subprocess.TimeoutExpired:
            code = 124
        stdout.seek(0)
        stderr.seek(0)
        diagnostic = (stdout.read(OUTPUT_LIMIT) + stderr.read(OUTPUT_LIMIT)).decode("utf-8", "replace")
    return holder, code, diagnostic[:OUTPUT_LIMIT]


HEADERS = {
    "payroll.csv": "employee_id,regular_hours,overtime_hours,doubletime_hours,night_minutes,holiday_hours,gross_pay".split(","),
    "shift_detail.csv": "employee_id,shift_id,paid_minutes,regular_minutes,overtime_minutes,doubletime_minutes,night_minutes,holiday_minutes,gross_pay".split(","),
    "exceptions.csv": "employee_id,shift_id,record_id,reason".split(","),
    "correction_summary.csv": "employee_id,old_gross_pay,corrected_gross_pay,delta".split(","),
}


def rows(path: Path, header: list[str] | None = None) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames):
            raise ValueError("missing or duplicate CSV header")
        if header is not None and reader.fieldnames != header:
            raise ValueError("wrong CSV header")
        result = list(reader)
    if any(None in row or None in row.values() for row in result):
        raise ValueError("malformed CSV row")
    return result


def reference_tables(work: Path, fixture: str) -> dict[str, list[dict[str, str]]]:
    # Independent fixture arithmetic: minute columns followed by shift gross.
    if fixture == "edge":
        values = {("E9", "DST"): (180, 180, 0, 0, 180, 0, "198.00")}
    else:
        values = {
            **{("E1", f"E1-{d}"): (510, 510, 0, 0, 0, 0, "170.00") for d in range(3, 7)},
            ("E1", "E1-7"): (450, 360, 90, 0, 0, 0, "165.00"),
            ("E2", "U-LONG"): (750, 480, 240, 30, 0, 0, "450.00"),
            ("E2", "U-NIGHT"): (570, 570, 0, 0, 450, 0, "307.50"),
            ("E3", "HOLIDAY"): (120, 120, 0, 0, 0, 120, "88.00"),
        }
        rates = {r["employee_id"]: Decimal(r["hourly_rate"]) for r in rows(work / "inputs/employees.csv")}
        for n in range(10, 30):
            values[(f"E{n}", f"F{n}")] = (450, 450, 0, 0, 0, 0, f"{rates[f'E{n}'] * Decimal('7.5'):.2f}")
    starts = {}
    for punch in rows(work / "inputs/punches.csv"):
        key = (punch["employee_id"], punch["shift_id"])
        instant = datetime.fromisoformat(punch["timestamp"])
        starts[key] = min(starts.get(key, instant), instant)
    ordered = sorted(values, key=lambda key: (key[0], starts[key], key[1]))
    shifts = [dict(zip(HEADERS["shift_detail.csv"], map(str, (*key, *values[key])))) for key in ordered]
    payroll = []
    for employee in sorted({key[0] for key in values}):
        totals = [sum(Decimal(row[i]) for key, row in values.items() if key[0] == employee) for i in range(7)]
        hours = lambda minutes: str((minutes / 60).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
        payroll.append(dict(zip(HEADERS["payroll.csv"], (
            employee, hours(totals[1]), hours(totals[2]), hours(totals[3]),
            str(totals[4]), hours(totals[5]), f"{totals[6]:.2f}",
        ))))
    return {
        "payroll.csv": payroll,
        "shift_detail.csv": shifts,
        "exceptions.csv": [] if fixture == "edge" else [dict(zip(HEADERS["exceptions.csv"], ("E4", "BROKEN", "R0019", "invalid punch")))],
        "correction_summary.csv": [] if fixture == "edge" else [dict(zip(HEADERS["correction_summary.csv"], ("E1", "875.00", "845.00", "-30.00")))],
    }


def output_checks(work: Path, fixture: str) -> list[bool]:
    actual = {name: rows(work / "output" / name, header) for name, header in HEADERS.items()}
    expected = reference_tables(work, fixture)

    def identity(name: str) -> bool:
        keys = [field for field in HEADERS[name] if field.endswith("_id")]
        return [[r[k] for k in keys] for r in actual[name]] == [[r[k] for k in keys] for r in expected[name]]

    def columns(name: str, fields: list[str]) -> bool:
        if not identity(name):
            return False
        for got, want in zip(actual[name], expected[name]):
            for field in fields:
                text = got[field]
                if not field.endswith("_minutes") and re.fullmatch(r"-?\d+\.\d{2}", text) is None:
                    return False
                try:
                    number = Decimal(text)
                    if not number.is_finite() or number != Decimal(want[field]):
                        return False
                except ArithmeticError:
                    return False
        return True

    exceptions = actual["exceptions.csv"]
    pairing = (
        columns("shift_detail.csv", ["paid_minutes"])
        and identity("exceptions.csv")
        and all(r["reason"].strip() for r in exceptions)
        and exceptions == sorted(exceptions, key=lambda r: tuple(r[k] for k in HEADERS["exceptions.csv"]))
    )
    tiers = columns("payroll.csv", ["regular_hours", "overtime_hours", "doubletime_hours"]) and columns(
        "shift_detail.csv", ["regular_minutes", "overtime_minutes", "doubletime_minutes"])
    premiums = columns("payroll.csv", ["night_minutes", "holiday_hours"]) and columns(
        "shift_detail.csv", ["night_minutes", "holiday_minutes"])
    correction = columns("correction_summary.csv", ["old_gross_pay", "corrected_gross_pay", "delta"])
    totals = columns("payroll.csv", ["gross_pay"]) and columns("shift_detail.csv", ["gross_pay"])
    return [pairing, tiers, premiums, correction, totals]


def check_main(candidate: Path) -> tuple[list[bool], bool, bool, str]:
    holder, code, diagnostic = fresh_run(candidate, "main")
    try:
        if code != 0:
            return [False] * 5, False, False, diagnostic
        try:
            return output_checks(holder / "workspace", "main"), True, True, diagnostic
        except (OSError, UnicodeError, csv.Error, ValueError, KeyError):
            return [False] * 5, True, False, diagnostic
    finally:
        shutil.rmtree(holder, ignore_errors=True)


def check_edge(candidate: Path) -> tuple[bool, str]:
    holder, code, diagnostic = fresh_run(candidate, "edge")
    try:
        if code != 0:
            return False, diagnostic
        try:
            return all(output_checks(holder / "workspace", "edge")), diagnostic
        except (OSError, UnicodeError, csv.Error, ValueError, KeyError):
            return False, diagnostic
    finally:
        shutil.rmtree(holder, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True, type=Path)
    args = parser.parse_args()
    candidate = args.workspace.resolve()
    artifact = (candidate / "solution" / "payroll.py").is_file()
    notes: list[str] = []
    if artifact:
        try:
            checks, runnable, parsed, diagnostic = check_main(candidate)
        except Exception as exc:
            checks, runnable, parsed, diagnostic = [False] * 5, True, False, f"malformed main output: {exc}"
        try:
            edge, edge_diagnostic = check_edge(candidate)
        except Exception as exc:
            edge, edge_diagnostic = False, f"malformed edge output: {exc}"
        if diagnostic and not runnable:
            notes.append("main command failed: " + diagnostic[:240].replace("\n", " "))
        if edge_diagnostic and not edge:
            notes.append("edge command/check failed: " + edge_diagnostic[:240].replace("\n", " "))
    else:
        checks, runnable, parsed, edge = [False] * 5, False, False, False
    passed = sum(checks)
    if not artifact:
        level = 0
    elif not runnable:
        level = 1
    elif not parsed:
        level = 1
    elif passed == 5:
        level = 5 if edge else 4
    else:
        level = 3 if passed else 2
    result = {
        "status": "pass" if level == 5 else "fail",
        "progress_level": level,
        "main_checks_passed": passed,
        "main_checks_total": 5,
        "edge_check_passed": edge,
        "notes": notes[:3],
    }
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
