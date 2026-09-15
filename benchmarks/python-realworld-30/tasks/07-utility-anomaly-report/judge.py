#!/usr/bin/env python3
"""Direct main-and-edge judge for Task 07."""
from __future__ import annotations

import argparse
import csv
import json
import re
from html.parser import HTMLParser
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent
ANOMALY_FIELDS = ["meter_id", "month", "kwh", "baseline_median", "mad", "severity", "direction"]
GAP_FIELDS = ["meter_id", "month"]
SIX = Decimal("0.000001")


def median(values: list[Decimal]) -> Decimal:
    ordered = sorted(values)
    size = len(ordered)
    middle = size // 2
    return ordered[middle] if size % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def month_index(value: str) -> int:
    year, month = map(int, value.split("-"))
    return year * 12 + month - 1


def month_text(index: int) -> str:
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


def expected(inputs: Path) -> tuple[list[dict[str, str]], list[dict[str, str]], int]:
    by_meter: dict[str, list[tuple[str, Decimal]]] = defaultdict(list)
    with (inputs / "monthly_usage.csv").open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != ["meter_id", "month", "kwh"]:
            raise ValueError("input header")
        for row in reader:
            by_meter[row["meter_id"]].append((row["month"], Decimal(row["kwh"])))
    anomalies: list[dict[str, str]] = []
    gaps: list[dict[str, str]] = []
    for meter_id, values in by_meter.items():
        values.sort(key=lambda item: item[0])
        observed: list[Decimal] = []
        present = {month_index(month) for month, _ in values}
        for missing in range(min(present), max(present) + 1):
            if missing not in present:
                gaps.append({"meter_id": meter_id, "month": month_text(missing)})
        for month, value in values:
            if len(observed) >= 6:
                window = observed[-6:]
                baseline = median(window)
                mad = median([abs(item - baseline) for item in window])
                difference = abs(value - baseline)
                if difference > max(Decimal(3) * mad, Decimal("0.25") * baseline):
                    severity = difference / baseline if baseline > 0 else Decimal(0)
                    anomalies.append({
                        "meter_id": meter_id,
                        "month": month,
                        "kwh": f"{value.quantize(SIX):.6f}",
                        "baseline_median": f"{baseline.quantize(SIX):.6f}",
                        "mad": f"{mad.quantize(SIX):.6f}",
                        "severity": f"{severity.quantize(SIX):.6f}",
                        "direction": "high" if value > baseline else "low",
                    })
            observed.append(value)
    anomalies.sort(key=lambda row: (-Decimal(row["severity"]), row["meter_id"], row["month"]))
    gaps.sort(key=lambda row: (row["meter_id"], row["month"]))
    return anomalies, gaps, len(by_meter)


def read_csv(path: Path, fields: list[str]) -> tuple[bytes, list[dict[str, str]]]:
    raw = path.read_bytes()
    if b"\r" in raw or (raw and not raw.endswith(b"\n")):
        raise ValueError("line endings")
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != fields:
            raise ValueError("header")
        rows = list(reader)
        if any(None in row or any(value is None for value in row.values()) for row in rows):
            raise ValueError("malformed CSV row")
        return raw, rows


def generate(root: Path, fixture: str) -> None:
    subprocess.run([sys.executable, str(TASK_DIR / "seed.py"), "--workspace", str(root), "--fixture", fixture], check=True, capture_output=True, timeout=20)
    subprocess.run([sys.executable, str(TASK_DIR / "visible" / "_generate.py"), "--output", str(root), "--fixture", fixture], check=True, capture_output=True, timeout=20)


def execute(candidate: Path, fixture: str):
    temporary = tempfile.TemporaryDirectory(prefix=f"pcbench-07-{fixture}-")
    root = Path(temporary.name)
    generate(root, fixture)
    if (candidate / "solution").is_dir():
        shutil.rmtree(root / "solution")
        shutil.copytree(candidate / "solution", root / "solution")
    completed = subprocess.run([sys.executable, "-E", "-S", "-m", "solution.utility_anomalies", "inputs/monthly_usage.csv", "--output", "output"], cwd=root, text=True, capture_output=True, timeout=30)
    return root, completed, temporary


class ReportParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text=[]; self.tables=[]; self.table=None; self.row=None; self.cell=None
        self.hidden=0; self.unsafe=False

    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs)
        if tag in {"script","iframe","object","embed"} or any(name.lower().startswith("on") for name in attrs):
            self.unsafe=True
        if any(name in attrs and not attrs[name].startswith(("#","data:")) for name in ("src","href")):
            self.unsafe=True
        if tag in {"style","script","template"}: self.hidden+=1
        if self.hidden: return
        if tag=="table": self.table=[]
        elif tag=="tr" and self.table is not None: self.row=[]
        elif tag in {"td","th"} and self.row is not None: self.cell=[]

    def handle_endtag(self, tag):
        if tag in {"style","script","template"}:
            self.hidden=max(0,self.hidden-1); return
        if self.hidden: return
        if tag in {"td","th"} and self.cell is not None:
            self.row.append("".join(self.cell).strip()); self.cell=None
        elif tag=="tr" and self.row is not None:
            self.table.append(self.row); self.row=None
        elif tag=="table" and self.table is not None:
            self.tables.append(self.table); self.table=None

    def handle_data(self, data):
        if self.hidden:
            if re.search(r"@import|url\s*\(",data,re.I): self.unsafe=True
            return
        self.text.append(data)
        if self.cell is not None: self.cell.append(data)


def report_ok(raw, anomalies, meters, gaps):
    if b"\r" in raw or not raw.endswith(b"\n"): return False
    parser=ReportParser(); parser.feed(raw.decode("utf-8")); parser.close()
    if parser.unsafe: return False
    text=" ".join(" ".join(parser.text).split()).casefold()
    for label,count in (("meters",meters),("anomalies",len(anomalies)),("gaps",gaps)):
        word=r"anomal(?:y|ies)" if label=="anomalies" else label.rstrip("s")+"s?"
        if not re.search(rf"\b(?:total\s+)?{word}\s*[:=]?\s*{count}\b|\b{count}\s+(?:total\s+)?{word}\b",text):
            return False
    wanted=anomalies[:10]
    for table in parser.tables:
        rows=table
        if rows and any(cell.casefold() in {"meter", "meter_id", "meter id"} for cell in rows[0]): rows=rows[1:]
        if len(rows)==len(wanted) and all(row["meter_id"] in cells and row["month"] in cells for cells,row in zip(rows,wanted)):
            return True
    return False


def module_imports(root):
    result=subprocess.run([sys.executable,"-E","-S","-c","import solution.utility_anomalies"],cwd=root,text=True,capture_output=True,timeout=10)
    return result.returncode==0

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True, type=Path)
    args = parser.parse_args()
    candidate = args.workspace.resolve()
    artifact = (candidate / "solution" / "utility_anomalies.py").is_file()
    main_checks = [False] * 5
    notes: list[str] = []
    runnable = parseable = False
    main_tmp = edge_tmp = None
    try:
        if artifact:
            root, completed, main_tmp = execute(candidate, "main")
            runnable = completed.returncode == 0 or module_imports(root)
            if completed.returncode != 0:
                notes.append("main command failed")
            else:
                try:
                    _, anomalies = read_csv(root / "output/anomalies.csv", ANOMALY_FIELDS)
                    _, gaps = read_csv(root / "output/gaps.csv", GAP_FIELDS)
                    report_raw = (root / "output/report.html").read_bytes()
                    expected_anomalies, expected_gaps, meters = expected(root / "inputs")
                    parseable = True
                    main_checks[0] = anomalies == expected_anomalies
                    main_checks[1] = gaps == expected_gaps
                    main_checks[2] = [Decimal(row["severity"]) for row in anomalies] == sorted((Decimal(row["severity"]) for row in anomalies), reverse=True) and all(len(row[field].partition(".")[2]) == 6 for row in anomalies for field in ANOMALY_FIELDS[2:6])
                    main_checks[3] = all(row in anomalies for row in expected_anomalies if row["meter_id"] in {"METER-0003", "METER-0012", "METER-0028", "METER-&<50>"})
                    main_checks[4] = report_ok(report_raw, expected_anomalies, meters, len(expected_gaps))
                except (OSError, UnicodeError, csv.Error, ValueError, KeyError, TypeError, AttributeError) as exc:
                    notes.append(f"main outputs invalid: {type(exc).__name__}")
        edge_ok = False
        if artifact:
            edge_root, edge_run, edge_tmp = execute(candidate, "edge")
            if edge_run.returncode == 0:
                try:
                    _, rows = read_csv(edge_root / "output/anomalies.csv", ANOMALY_FIELDS)
                    expected_rows, expected_gaps, meters = expected(edge_root / "inputs")
                    _, gaps = read_csv(edge_root / "output/gaps.csv", GAP_FIELDS)
                    edge_ok = rows == expected_rows and len(rows) == 1 and rows[0]["severity"] == "0.300000" and gaps == expected_gaps and report_ok((edge_root / "output/report.html").read_bytes(), expected_rows, meters, len(expected_gaps))
                except (OSError, UnicodeError, csv.Error, ValueError, KeyError, TypeError, AttributeError):
                    pass
            else:
                notes.append("edge command failed")
    except (OSError, subprocess.SubprocessError) as exc:
        edge_ok = False
        notes.append(f"judge execution failed: {type(exc).__name__}")
    finally:
        if main_tmp is not None:
            main_tmp.cleanup()
        if edge_tmp is not None:
            edge_tmp.cleanup()
    passed = sum(main_checks)
    if not artifact or not runnable:
        level = 0
    elif not parseable:
        level = 1
    elif passed == len(main_checks):
        level = 5 if edge_ok else 4
    elif passed:
        level = 3
    else:
        level = 2
    print(json.dumps({"status": "pass" if level == 5 else "fail", "progress_level": level, "main_checks_passed": passed, "main_checks_total": len(main_checks), "edge_check_passed": edge_ok, "notes": notes}, sort_keys=True))


if __name__ == "__main__":
    main()
