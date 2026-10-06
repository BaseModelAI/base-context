"""Load the five-task corpus and reuse the native isolated judge with Node available."""
import json
import subprocess
import time
from pathlib import Path

from benchlib import (clean_python_environment, isolated_python_command, last_json_object,
                      load_scenarios, python312)

SCHEMA = "context-workflow-stress-task/v1"
SUITE_SCHEMA = "context-workflow-stress-suite/v1"


def load_task(root, task_id):
    root = Path(root)
    index = json.loads((root / "tasks.json").read_text())
    if index.get("schema") != SUITE_SCHEMA:
        return load_scenarios(root)[task_id]
    item = next(item for item in index["tasks"] if item["id"] == task_id)
    path = root / item["scenario"]
    scenario = json.loads(path.read_text())
    if scenario.get("schema") != SCHEMA or scenario.get("id") != task_id:
        raise ValueError("Stress task manifest and scenario disagree")
    if scenario.get("candidate_service") or scenario.get("fixture_service"):
        raise ValueError("Stress lifecycle tasks do not use fixture-service containers")
    return path.parent, scenario


def run_stress_judge(task_dir, scenario, workspace, node):
    task_dir, workspace = Path(task_dir).resolve(), Path(workspace).resolve()
    command = [str(workspace) if part == "{workspace}" else part for part in scenario["judge_command"]]
    command[0:1] = [python312(), "-E", "-S"]
    command = isolated_python_command(command, task_dir, workspace, "/usr/bin/bwrap", task_dir=task_dir)
    at = command.index("--")
    command[at:at] = ["--ro-bind", str(Path(node).resolve()), "/opt/node/bin/node",
                     "--setenv", "PATH", "/opt/node/bin:/usr/bin:/bin"]
    started = time.monotonic()
    completed = subprocess.run(command, cwd=task_dir, env=clean_python_environment(),
                               capture_output=True, text=True, timeout=600)
    elapsed = time.monotonic() - started
    transcript = completed.stdout + completed.stderr
    try:
        result = last_json_object(completed.stdout)
    except ValueError as error:
        result = {"status": "error", "progress_level": 0, "main_checks_passed": 0,
                  "main_checks_total": 0, "edge_check_passed": False, "notes": [str(error)]}
    if completed.returncode:
        result["status"] = "error"
        result.setdefault("notes", []).append(f"judge exit code {completed.returncode}")
    return result, elapsed, transcript
