from __future__ import annotations

import argparse
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from benchlib import aggregate_sessions, collect_sessions, parse_session_file

import run as benchmark
import run_codex as codex_benchmark

host_spec = importlib.util.spec_from_file_location("host_setup", Path(__file__).with_name("prepare-hosts.py"))
host_setup = importlib.util.module_from_spec(host_spec)
host_spec.loader.exec_module(host_setup)


def attempt(*, wall: float, cost: float | None, progress: int = 5) -> dict:
    passed = progress == 5
    return {
        "agent_wall_seconds": wall,
        "lifecycle_wall_seconds": wall,
        "judge_seconds": 0.0,
        "judge": {
            "status": "pass" if passed else "fail",
            "progress_level": progress,
            "main_checks_passed": 5 if passed else progress,
            "edge_check_passed": passed,
        },
        "metrics": {
            "api_cost": {"total": cost},
            "cost_complete": cost is not None,
            "provider_usage": {"totalTokens": 100},
        },
    }


def result(variant: str, value: dict, attempts: list[dict] | None = None) -> dict:
    values = attempts or [value]
    return {
        "variant": variant,
        "task_id": 1,
        "task_slug": "example",
        "pressure": "N",
        "primary_attempt": 0,
        "retry_triggers": [],
        "attempts": values,
    }


def native_journal(
    path: Path, *, session_id: str = "root", incomplete: bool = False, request_output: bool = False,
    compaction_output: bool = False, branch_output: bool = False, planner_output: bool = False,
    zero_priced_missing_write: bool = False,
    model_identity: dict[str, str] | None = None, token_usage: dict[str, int] | None = None,
) -> None:
    timestamp = "2026-09-07T00:00:00.000Z"
    descriptor = {
        "api": "openai-completions", "provider": "openai", "model": "fixture",
        "transport": "http", "ordinal": 1, "kind": "initial",
        **(model_identity or {}),
    }
    metadata = {
        "operationId": "operation",
        "source": {"sessionId": "root", "leafId": None, "sourceSequence": 0, "persistent": True},
        "owner": {"sessionId": "root"}, "purpose": "main",
        "modelContract": {
            **{key: descriptor[key] for key in ("api", "provider", "model")},
            "profile": {"id": "native-default", "status": "unvalidated"},
            "pricing": {"status": "unvalidated", "currency": "USD", "unit": "million-tokens",
                        "catalogRates": {"input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1.25}},
        },
    }
    if request_output or compaction_output or branch_output or planner_output:
        # A recorded original path need not be the archive path being parsed.
        metadata["source"]["sessionFile"] = "/recorded/original-session.jsonl"
    if compaction_output:
        metadata["purpose"] = "summary"
        metadata["purposeDetail"] = "compaction"
    if branch_output:
        metadata["purpose"] = "summary"
        metadata["purposeDetail"] = "branch"
        metadata["source"]["leafId"] = "input-leaf"
    if planner_output:
        metadata["purpose"] = "refine"
        metadata["purposeDetail"] = "plan"
    usage = dict(token_usage) if token_usage is not None else {
        "input": 100, "inputTotal": 125, "output": 20, "cacheRead": 25, "cacheWrite": 0, "totalTokens": 145,
    }
    if incomplete or zero_priced_missing_write:
        usage.pop("cacheWrite")
    if zero_priced_missing_write:
        # Hypothetical tariff only; this is not an OpenAI price or physical-write observation.
        metadata["modelContract"]["pricing"]["catalogRates"]["cacheWrite"] = 0
    receipt = {
        **descriptor, "attemptId": "physical-attempt", "outcome": "failed" if incomplete else "completed",
        "rawUsage": [], "usage": usage, "usageCompleteness": "partial" if incomplete else "complete",
        "timing": {"queuedAt": 0, "admittedAt": 1, "sentAt": 1, "settledAt": 2},
        **({"capacityConfirmed": True} if incomplete else {}),
    }
    events = [
        {**metadata, "type": "attempt_admitted", "attemptId": "physical-attempt", "timestamp": 1, "descriptor": descriptor},
        {**metadata, "type": "attempt_settled", "attemptId": "physical-attempt", "timestamp": 2, "receipt": receipt},
    ]
    entries = [
        {"type": "session", "version": 3, "id": session_id, "timestamp": timestamp, "cwd": "/tmp"},
        *[{"type": "request", "id": f"physical-attempt:{event['type']}", "parentId": None,
           "timestamp": timestamp, "request": event} for event in events],
        {"type": "message", "message": {"role": "assistant", "content": [],
                                       "stopReason": "error", "errorMessage": "Selected model is at capacity.",
                                       "usage": {"input": 99999, "output": 99999, "cost": {"total": 99}}}},
    ]
    if request_output:
        entries[-1].update({
            "id": "recorded-assistant",
            "requestOutput": {"operationId": metadata["operationId"], "attemptIds": ["physical-attempt"],
                              "source": dict(metadata["source"])},
        })
    if compaction_output:
        entries[-1]["id"] = "retained-message"
        recorded = {"operationId": metadata["operationId"], "attemptIds": ["physical-attempt"],
                    "source": dict(metadata["source"])}
        entries.append({
            "type": "compaction", "id": "recorded-compaction", "parentId": "retained-message", "timestamp": timestamp,
            "summary": "Saved history projection and file-operation text", "firstKeptEntryId": "retained-message",
            "tokensBefore": 100, "fromHook": False,
            "requestOutputs": [{"part": "history", **recorded}, {"part": "turn-prefix", **recorded}],
        })
    if branch_output:
        recorded = {"operationId": metadata["operationId"], "attemptIds": ["physical-attempt"],
                    "source": dict(metadata["source"])}
        branch = {
            "type": "branch_summary", "id": "recorded-branch-summary", "parentId": "destination-leaf",
            "fromId": "destination-leaf", "timestamp": timestamp, "fromHook": False,
            "summary": "Branch preamble, projected text and file-operation suffix", "requestOutput": recorded,
        }
        entries.extend([branch, {
            **branch, "id": "mismatched-branch-summary",
            "requestOutput": {**recorded, "source": {**recorded["source"], "leafId": "destination-leaf"}},
        }])
    if planner_output:
        result_data = {"id": "partial-refinement-result", "summary": "Projected partial planner result"}
        refinement = {
            "type": "custom", "customType": "prime-agent.refinement", "id": "recorded-refinement-entry",
            "parentId": None, "timestamp": timestamp, "data": result_data,
            "plannerRequest": {"operationId": metadata["operationId"], "attemptIds": ["physical-attempt"],
                               "source": dict(metadata["source"])},
        }
        entries.extend([refinement, {
            **refinement, "id": "rollback-refinement-entry",
            "data": {**result_data, "id": "rollback-result", "rollbackOf": result_data["id"]},
        }])
    # Accounting consumes the documented payload envelope, not frame-integrity validation.
    path.write_text("".join(json.dumps({"journalFrame": 1, "payload": entry}) + "\n" for entry in entries))


class HarnessComparisonTests(unittest.TestCase):
    def test_provider_message_error_is_propagated(self) -> None:
        self.assertIsNone(benchmark.message_end_error({"type": "message_end", "message": {"stopReason": "stop"}}))
        self.assertEqual(
            benchmark.message_end_error({
                "type": "message_end",
                "message": {"stopReason": "error", "errorMessage": "WebSocket closed 1006"},
            }),
            "AgentError: WebSocket closed 1006",
        )

    def test_current_win_uses_primary_and_native_physical_receipts(self) -> None:
        vanilla = result("vanilla", attempt(wall=10.0, cost=0.10))
        current = result("current", attempt(wall=8.0, cost=0.08))
        self.assertEqual(benchmark.primary_attempt_index(current["attempts"]), 0)
        summary = benchmark.comprehensive_summary([vanilla, current])
        self.assertEqual(summary["regressions"], [])
        self.assertFalse(summary["publication_ready"])
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            native_journal(root / "root.jsonl", request_output=True, zero_priced_missing_write=True)
            native_journal(root / "fork.jsonl", session_id="fork", request_output=True, zero_priced_missing_write=True)
            original = parse_session_file(root / "root.jsonl")
            copied = parse_session_file(root / "fork.jsonl")
            association = original["assistant_request_associations"][0]
            self.assertEqual(association, {
                "assistant_entry_id": "recorded-assistant",
                "recorded_request": {
                    "operationId": "operation", "attemptIds": ["physical-attempt"],
                    "source": {"sessionId": "root", "leafId": None, "sourceSequence": 0, "persistent": True,
                               "sessionFile": "/recorded/original-session.jsonl"},
                },
            })
            # The assistant observation's error is not an output-delivery/refusal verdict.
            self.assertIsNone(copied["assistant_request_associations"][0]["recorded_request"])
            metrics = aggregate_sessions(collect_sessions(root))
            self.assertIn(association, next(
                item["associations"] for item in metrics["assistant_request_associations"]
                if item["session_id"] == "root"
            ))
            # Separate fixture: original MAIN/accounting assertions below remain unchanged.
            native_journal(root / "compaction.jsonl", compaction_output=True)
            compacted = parse_session_file(root / "compaction.jsonl")
            compaction_association = compacted["compaction_request_associations"][0]
            self.assertEqual(compaction_association, {
                "compaction_entry_id": "recorded-compaction",
                "recorded_requests": [
                    {"part": "history", "recorded_request": association["recorded_request"]},
                    # A history request cannot also match the prefix's different purposeDetail.
                    {"part": "turn-prefix", "recorded_request": None},
                ],
            })
            compaction_metrics = aggregate_sessions([compacted])
            self.assertEqual(compaction_metrics["compaction_request_associations"][0]["associations"],
                             [compaction_association])
            native_journal(root / "branch.jsonl", branch_output=True)
            branched = parse_session_file(root / "branch.jsonl")
            branch_associations = branched["branch_summary_request_associations"]
            self.assertEqual(branch_associations, [
                {"branch_summary_entry_id": "recorded-branch-summary", "recorded_request": {
                    **association["recorded_request"],
                    "source": {**association["recorded_request"]["source"], "leafId": "input-leaf"},
                }},
                # Destination facts cannot replace the original request's input leaf.
                {"branch_summary_entry_id": "mismatched-branch-summary", "recorded_request": None},
            ])
            branch_metrics = aggregate_sessions([branched])
            self.assertEqual(branch_metrics["branch_summary_request_associations"][0]["associations"],
                             branch_associations)
            native_journal(root / "planner.jsonl", planner_output=True)
            planned = parse_session_file(root / "planner.jsonl")
            planner_associations = planned["refinement_planner_associations"]
            self.assertEqual(planner_associations, [
                {"refinement_entry_id": "recorded-refinement-entry",
                 "recorded_request": association["recorded_request"]},
                # A known rollback is ineligible even with a matching copied plannerRequest.
                {"refinement_entry_id": "rollback-refinement-entry", "recorded_request": None},
            ])
            planner_metrics = aggregate_sessions([planned])
            self.assertEqual(planner_metrics["refinement_planner_associations"][0]["associations"],
                             planner_associations)
            priced_attempt = {**current["attempts"][0], "metrics": metrics}
            priced_result = result("current", priced_attempt)
            priced_summary = benchmark.comprehensive_summary([vanilla, priced_result])
            self.assertAlmostEqual(priced_summary["by_variant"]["current"]["all_attempts"]["prompt_cache_reuse"], 0.2)
            report_path = root / "priced-summary.md"
            benchmark.write_summary_markdown(report_path, priced_summary, [vanilla, priced_result])
            report = report_path.read_text()
            self.assertIn("All API estimate USD", report)
            self.assertIn("not subscription cash charges", report)
            self.assertIn("not verified debits", report)
            self.assertIn("usage complete=False; estimate computable=True", report)
            profiles = json.loads(Path(__file__).with_name("api-price-profiles.json").read_text())
            sol = next(item for item in profiles if item["model"] == "gpt-5.6-sol")
            identity = {key: sol[key] for key in ("provider", "api", "model")}
            profiled_dir = root / "profiled"
            profiled_dir.mkdir()
            long_usage = {"input": 210000, "inputTotal": 272001, "cacheRead": 60000,
                          "cacheWrite": 2001, "output": 1000, "totalTokens": 273001}
            native_journal(profiled_dir / "root.jsonl", model_identity=identity, token_usage=long_usage)
            native_journal(profiled_dir / "fork.jsonl", session_id="fork", model_identity=identity, token_usage=long_usage)
            native_price = aggregate_sessions(collect_sessions(profiled_dir, profiles), profiles)
            self.assertEqual(native_price["all_model_calls"], 1)
            self.assertAlmostEqual(native_price["api_cost"]["total"], 1.77801)
            self.assertAlmostEqual(native_price["api_cost"]["output"], 0.03)
            self.assertTrue(native_price["cost_complete"])
            self.assertEqual(native_price["physical_attempts"][0]["modelContract"]["pricing"]["catalogRates"]["input"], 1)
            self.assertEqual(native_price["api_price_estimates"][0]["observations"], 1)
            stock_path = root / "stock-sol.jsonl"
            stock_usage = {"input": 212001, "cacheRead": 60000, "cacheWrite": 0, "output": 1000, "totalTokens": 273001}
            stock_path.write_text(json.dumps({"type": "session", "id": "stock", "version": 3}) + "\n" +
                                  json.dumps({"type": "message", "message": {**identity, "role": "assistant", "usage": stock_usage}}) + "\n")
            stock_price = aggregate_sessions([parse_session_file(stock_path, profiles)], profiles)
            conditional = stock_price["api_price_estimates"][0]
            self.assertEqual(conditional["coverage"], "stock_messages_conditional")
            self.assertAlmostEqual(conditional["conditional_range"]["lower"], 1.774008)
            self.assertAlmostEqual(conditional["conditional_range"]["upper"], 2.19801)
            self.assertIsNone(stock_price["observed_api_cost"]["total"])
            self.assertFalse(stock_price["cost_complete"])
            self.assertEqual(stock_price["assistant_price_observations"][0]["observations"][0]["usage"]["cacheWrite"], 0)
            native_result = result("current", {**attempt(wall=8, cost=None), "metrics": native_price})
            stock_result = result("vanilla", {**attempt(wall=10, cost=None), "metrics": stock_price})
            profile_summary = benchmark.comprehensive_summary([native_result, stock_result])
            self.assertFalse(profile_summary["matched_strict_pass_comparisons"][0]["complete"])
            benchmark.write_summary_markdown(report_path, profile_summary, [native_result, stock_result])
            self.assertIn("Conditional seen range USD", report_path.read_text())
            self.assertIn("not guaranteed whole-run bounds", report_path.read_text())
        self.assertEqual(metrics["accounting_source"], "native_request_receipts")
        self.assertEqual(metrics["all_model_calls"], 1)
        self.assertEqual(metrics["model_calls_by_purpose"], {"main": 1})
        self.assertEqual(metrics["provider_usage"]["totalTokens"], 145)
        self.assertAlmostEqual(metrics["api_cost"]["total"], 0.0001425)
        self.assertEqual(metrics["cost_basis"], "catalog_estimate")
        self.assertTrue(metrics["cost_complete"])
        self.assertEqual(metrics["api_cost"]["cacheWrite"], 0)
        self.assertFalse(metrics["usage_complete"])
        self.assertIsNone(metrics["provider_usage"]["cacheWrite"])
        self.assertNotIn("cacheWrite", metrics["physical_attempts"][0]["receipt"]["usage"])
        self.assertFalse(metrics["provider_capacity_confirmed"])
        # The actual runner gates compaction on its matched response, not a
        # nonexistent needs_input/extra agent_end event. This is mocked RPC,
        # with no provider, fixture service, judge, or subprocess execution.
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            node = Path("/usr/bin/node")
            host = {"package_name": benchmark.NATIVE_PACKAGE, "package_root": str(root / "image/unpacked/base-context/package"),
                    "argv": [str(node), "/frozen/cli.js"]}
            args = argparse.Namespace(
                host_openai_codex_auth_file=root / "host-auth.json", model="gpt-5.6-sol", thinking="medium",
                bwrap="/usr/bin/bwrap", timeout_seconds=10, hosts={"current": host},
                host_manifest={"node_executable": str(node), "dependency_root": str(root / "dependencies"), "hosts": {"current": host}},
            )
            events = [
                {"type": "agent_end"},
                {"type": "compaction_end", "result": {"tokensBefore": 100}},
                {"type": "response", "id": "request-2-after-initial", "command": "compact", "success": True},
                {"type": "agent_end"},
            ]
            process = Mock(pid=1234)
            process.stdout = io.StringIO("".join(json.dumps(event) + "\n" for event in events))
            process.wait.return_value = 0
            process.poll.return_value = 0
            scenario = {"initial_prompt": "initial", "timeout_seconds": 10, "editable_paths": [],
                        "stages": [{"id": "initial", "compact_after": True}, {"id": "followup", "message": "continue"}]}
            with patch.object(benchmark.subprocess, "Popen", return_value=process) as launch, \
                    patch.object(benchmark, "inject_stage"), patch.object(benchmark, "stop_process"), \
                    patch.object(benchmark, "stop_attempt_processes"):
                observed = benchmark.run_rpc("current", root, scenario, workspace, root, args)
            self.assertIsNone(observed["error"])
            self.assertEqual(observed["metrics"]["compaction_completions"], 1)
            sent = [json.loads(call.args[0]) for call in process.stdin.write.call_args_list]
            self.assertEqual([item["type"] for item in sent], ["prompt", "compact", "prompt"])
            self.assertEqual(sent[-1]["streamingBehavior"], "followUp")
            process.stdin.close.assert_called_once()
            process.wait.assert_called_once_with(timeout=30)
            command, environment = launch.call_args.args[0], launch.call_args.kwargs["env"]
            self.assertEqual(command[:4], ["/usr/bin/bwrap", "--die-with-parent", "--unshare-pid", "--new-session"])
            self.assertIn("--ro-bind", command)
            self.assertNotIn(["--ro-bind", "/", "/"], [command[index:index + 3] for index in range(len(command) - 2)])
            self.assertEqual(command[-1], str(root / "rpc-bootstrap.mjs"))
            self.assertNotIn("prime_context", command)
            self.assertNotIn("OPENAI_API_KEY", environment)
            self.assertEqual(environment["TMPDIR"], "/tmp")
            self.assertNotIn("--daemon-socket", command)
            self.assertIn(["--ro-bind", str(args.host_openai_codex_auth_file), "/run/host-openai-codex-auth.json"],
                          [command[index:index + 3] for index in range(len(command) - 2)])
            self.assertNotIn(str(args.host_openai_codex_auth_file), (root / "bash").read_text())
            self.assertNotIn("/run/host-openai-codex-auth.json", (root / "bash").read_text())
            isolated = benchmark.isolated_python_command(
                ["/usr/bin/python3.12", "judge.py"], root, workspace, "/usr/bin/bwrap", task_dir=root,
            )
            self.assertIn("--unshare-pid", isolated)
            self.assertIn("--clearenv", isolated)
            self.assertNotIn(["--bind", "/", "/"], [isolated[index:index + 3] for index in range(len(isolated) - 2)])
            self.assertIn("BASE_CONTEXT_HOME", environment)
            self.assertFalse((root / "config/auth.json").exists())

            # Existing native receipt parser -> real runner/attempt/case retention.
            # Only the RPC process and judge are mocked; no provider call is made.
            receipt_scenario = {**scenario, "id": 1, "slug": "receipt-capacity", "pressure": "N",
                                "stages": [{"id": "initial"}]}
            args.retry_failed = 0
            receipt_dir = root / "task-01-receipt-capacity/current/attempt-1/sessions"
            receipt_dir.mkdir(parents=True)
            native_journal(receipt_dir / "session.jsonl", incomplete=True)
            processes = []
            for index in range(2):
                child = Mock(pid=1300 + index, stdout=io.StringIO(json.dumps({"type": "agent_end"}) + "\n"))
                child.wait.return_value = child.poll.return_value = 0
                processes.append(child)
            with patch.object(benchmark.subprocess, "Popen", side_effect=processes), \
                    patch.object(benchmark, "inject_stage"), patch.object(benchmark, "stop_process"), \
                    patch.object(benchmark, "stop_attempt_processes"), \
                    patch.object(benchmark, "prepare_workspace", side_effect=lambda _task, _scenario, path: path.mkdir()), \
                    patch.object(benchmark, "run_judge", return_value=(attempt(wall=1, cost=None)["judge"], 0.0, "fixture")) as judge:
                receipt_case = benchmark.run_case("current", root, receipt_scenario, root, args)
            self.assertEqual(receipt_case["capacity_invalid_attempts"], 1)
            self.assertEqual(receipt_case["valid_attempts"], 1)
            self.assertEqual(receipt_case["primary_attempt"], 1)
            self.assertEqual(len(receipt_case["attempts"]), 2)
            first = receipt_case["attempts"][0]
            self.assertTrue(first["capacity_invalid"])
            self.assertFalse(first["rpc_capacity_observed"])
            self.assertEqual(first["judge"]["status"], "invalid")
            self.assertEqual(len(first["metrics"]["physical_attempts"]), 1)
            self.assertIsNone(first["metrics"]["api_cost"]["total"])
            self.assertIsNone(receipt_case["attempts"][1]["metrics"]["all_model_calls"])
            judge.assert_called_once()
            saved = json.loads((root / "task-01-receipt-capacity/current/case.json").read_text())
            self.assertEqual(saved["primary_attempt"], 1)
            self.assertEqual(saved["attempts"][0]["rpc_capacity_observed"], False)

        # Actual candidate Python mount/PID isolation, separate from mocked RPC above.
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "input.txt").write_text("workspace-ok")
            host_only = root / "host-auth.json"
            host_only.write_text("dummy-not-a-credential")
            code = ("from pathlib import Path; "
                    f"assert not Path({str(host_only)!r}).exists(); "
                    "assert not Path('/run/host-openai-codex-auth.json').exists(); "
                    "print(Path('input.txt').read_text())")
            command = benchmark.isolated_python_command(
                [benchmark.service_command(["python3.12"])[0], "-E", "-S", "-c", code],
                workspace, workspace, "/usr/bin/bwrap",
            )
            completed = benchmark.subprocess.run(command, env=benchmark.clean_python_environment(),
                                                  text=True, capture_output=True, timeout=10)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout.strip(), "workspace-ok")

    def test_vanilla_failure_is_a_current_correctness_win(self) -> None:
        vanilla_attempt = attempt(wall=12.0, cost=0.12, progress=3)
        vanilla_attempt["judge"]["main_checks_passed"] = 4
        vanilla_attempt["judge"]["edge_check_passed"] = True
        vanilla = result("vanilla", vanilla_attempt)
        current = result("current", attempt(wall=10.0, cost=0.10))
        summary = benchmark.comprehensive_summary([vanilla, current])
        self.assertEqual(summary["regressions"], [])
        self.assertEqual(len(summary["baseline_failures"]), 1)
        self.assertEqual(len(summary["current_correctness_wins"]), 1)
        self.assertEqual(summary["matched_strict_pass_comparisons"], [])

        full_results = []
        for task_id in range(1, 31):
            full_vanilla = result(
                "vanilla",
                vanilla_attempt if task_id == 30 else attempt(wall=12.0, cost=0.12),
            )
            full_current = result("current", attempt(wall=10.0, cost=0.10))
            full_vanilla["task_id"] = task_id
            full_current["task_id"] = task_id
            full_results.extend((full_vanilla, full_current))
        self.assertTrue(benchmark.comprehensive_summary(full_results)["publication_ready"])

    def test_capacity_invalidations_do_not_replace_primary_or_unknown_cost(self) -> None:
        exact_error = {"type": "message_end", "message": {
            "role": "assistant", "stopReason": "error", "errorMessage": "Selected model is at capacity.",
        }}
        self.assertTrue(benchmark.provider_capacity_error(exact_error))
        self.assertFalse(benchmark.provider_capacity_error({**exact_error, "message": {**exact_error["message"], "stopReason": "stop"}}))
        self.assertFalse(benchmark.provider_capacity_error({**exact_error, "message": {**exact_error["message"], "errorMessage": "Selected model is at capacity. Maybe."}}))
        compact_error = {"type": "response", "command": "compact", "success": False, "error": "Selected model is at capacity."}
        self.assertTrue(benchmark.provider_capacity_error(compact_error))
        self.assertFalse(benchmark.provider_capacity_error({**compact_error, "success": True}))
        self.assertTrue(benchmark.provider_capacity_error({"type": "compaction_end", "errorMessage": compact_error["error"]}))
        with patch.dict("os.environ", {"OPENAI_API_KEY": "ambient-key", "PRIME_API_KEY": "ambient-key", "HTTP_PROXY": "ambient-proxy", "NODE_OPTIONS": "ambient-options"}):
            for variant, config_key in (("vanilla", "PRIME_AGENT_CODING_AGENT_DIR"), ("current", "BASE_CONTEXT_HOME")):
                environment = benchmark.clean_environment(
                    Path("/private/config"), Path("/private/home"), variant=variant,
                    node=Path("/private/node/bin/node"), tmpdir=Path("/private/tmp"),
                )
                self.assertNotIn("OPENAI_API_KEY", environment)
                self.assertEqual(environment[config_key], "/private/config")
                for name in ("PRIME_API_KEY", "HTTP_PROXY", "NODE_OPTIONS", "CODEX_HOME", "PRIME_CONTEXT_HOME", "PYTHONPATH"):
                    self.assertNotIn(name, environment)
        sequence = [
            {**attempt(wall=1, cost=0.02), "capacity_invalid": True},
            attempt(wall=12, cost=0.10, progress=3),
            {**attempt(wall=1, cost=0.03), "capacity_invalid": True},
            attempt(wall=8, cost=0.05),
        ]
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            with patch.object(benchmark, "safe_run_attempt", side_effect=sequence) as run:
                current = benchmark.run_case("current", root, {"id": 1, "slug": "example", "pressure": "N"}, root, argparse.Namespace(retry_failed=1))
            self.assertEqual(run.call_count, 4)
            self.assertEqual(current["primary_attempt"], 1)
            self.assertEqual(current["valid_attempts"], 2)
            self.assertEqual(current["capacity_invalid_attempts"], 2)
            self.assertEqual(current["retry_triggers"], [{"attempt": 4, "reasons": ["strict_failure"]}])
            vanilla = result("vanilla", attempt(wall=10, cost=0.10))
            # Historical winner metadata must not promote the diagnostic success.
            current["selected_attempt"] = 3
            summary = benchmark.comprehensive_summary([vanilla, current])
            self.assertEqual(summary["by_variant"]["current"]["strict_passes"], 0)
            self.assertAlmostEqual(summary["by_variant"]["current"]["all_attempts"]["api_cost"]["total"], 0.20)
            self.assertEqual(len(current["attempts"]), 4)
            with patch.object(benchmark, "safe_run_attempt", return_value=attempt(wall=12, cost=0.12)) as run:
                slower = benchmark.run_case("current", root, {"id": 2, "slug": "slower", "pressure": "N"}, root, argparse.Namespace(retry_failed=1))
            self.assertEqual(run.call_count, 1)  # A valid pass never triggers a performance retry.
            self.assertEqual(slower["retry_triggers"], [])
            native_journal(root / "partial.jsonl", incomplete=True, zero_priced_missing_write=True)
            metrics = aggregate_sessions([parse_session_file(root / "partial.jsonl")])
            self.assertTrue(metrics["provider_capacity_confirmed"])
            self.assertIsNone(metrics["provider_usage"]["cacheWrite"])
            self.assertEqual(metrics["api_cost"]["cacheWrite"], 0)
            self.assertIsNone(metrics["api_cost"]["total"])
            self.assertFalse(metrics["cost_complete"])
            legacy_path = root / "legacy.jsonl"
            observed_usage = {"input": 100, "output": 20, "cacheRead": 25, "cacheWrite": 0, "totalTokens": 145,
                              "cost": {"input": 0.1, "output": 0.2, "cacheRead": 0.01, "cacheWrite": 0, "total": 0.31}}
            legacy_path.write_text(json.dumps({"type": "session", "id": "legacy", "version": 3}) + "\n" +
                                   json.dumps({"type": "message", "message": {**exact_error["message"], "usage": observed_usage}}) + "\n")
            legacy = aggregate_sessions([parse_session_file(legacy_path)])
            self.assertEqual(legacy["accounting_source"], "assistant_messages_observational")
            self.assertFalse(legacy["cost_complete"])
            self.assertFalse(legacy["usage_complete"])
            self.assertIsNone(legacy["all_model_calls"])
            self.assertIsNone(legacy["api_cost"]["total"])
            self.assertEqual(legacy["observed_api_cost"]["total"], 0.31)
            self.assertEqual(legacy["observed_provider_usage"]["totalTokens"], 145)
            self.assertEqual(legacy["assistant_usage_observations"][0]["usage"], [observed_usage])
            self.assertTrue(legacy["provider_capacity_confirmed"])
            profiles = json.loads(Path(__file__).with_name("api-price-profiles.json").read_text())
            sol = next(item for item in profiles if item["model"] == "gpt-5.6-sol")
            identity = {key: sol[key] for key in ("provider", "api", "model")}
            missing_path = root / "unreported-writes.jsonl"
            native_journal(missing_path, model_identity=identity, zero_priced_missing_write=True)
            missing = aggregate_sessions([parse_session_file(missing_path, profiles)], profiles)
            self.assertIsNone(missing["api_cost"]["total"])
            self.assertIsNone(missing["provider_usage"]["cacheWrite"])
            duplicate_profiles = profiles + [sol]
            ambiguous = aggregate_sessions([parse_session_file(missing_path, duplicate_profiles)], duplicate_profiles)
            self.assertIsNone(ambiguous["api_price_estimates"][0]["profile_id"])
            self.assertEqual(ambiguous["api_price_estimates"][0]["unpriced_observations"], 1)
            deepseek = next(item for item in profiles if item["model"] == "deepseek-flash")
            returned = {key: deepseek[key] for key in ("provider", "api", "model")}
            deepseek_path = root / "stock-deepseek.jsonl"
            stock_rows = [
                {"type": "session", "id": "deepseek", "version": 3},
                {"type": "message", "message": {**returned, "role": "assistant", "usage": observed_usage}},
                {"type": "message", "message": {**returned, "role": "assistant", "stopReason": "error",
                                                "usage": {key: 0 for key in observed_usage if key != "cost"}}},
            ]
            deepseek_path.write_text("".join(json.dumps(item) + "\n" for item in stock_rows))
            partial_price = aggregate_sessions([parse_session_file(deepseek_path, profiles)], profiles)
            group = partial_price["api_price_estimates"][0]
            self.assertEqual(group["basis"], "deepseek-peak-normalized-api")
            self.assertEqual(group["observations"], 2)
            self.assertEqual(group["unpriced_observations"], 1)
            self.assertAlmostEqual(group["known_subtotal"], 0.00005415)
            self.assertIsNone(partial_price["observed_api_cost"]["total"])
            self.assertIsNone(partial_price["api_cost"]["total"])
            self.assertFalse(partial_price["cost_complete"])

            # Native host selection remains authoritative when no native receipts exist,
            # even if both RPC and a legacy assistant observation say capacity.
            node = Path("/usr/bin/node")
            native_host = {"package_name": benchmark.NATIVE_PACKAGE,
                           "package_root": str(root / "image/unpacked/base-context/package"),
                           "argv": [str(node), "/frozen/cli.js"]}
            legacy_host = {**native_host, "package_name": "@earendil-works/pi-coding-agent",
                           "package_root": str(root / "legacy-package")}
            hosts = {"current": native_host, "vanilla": legacy_host}
            args = argparse.Namespace(
                host_openai_codex_auth_file=root / "host-auth.json", model="gpt-5.6-sol", thinking="medium",
                bwrap="/usr/bin/bwrap", timeout_seconds=10, retry_failed=1, hosts=hosts,
                host_manifest={"node_executable": str(node), "dependency_root": str(root / "dependencies"), "hosts": hosts},
            )
            rpc_scenario = {"id": 3, "slug": "rpc-only", "pressure": "N", "initial_prompt": "initial",
                            "timeout_seconds": 10, "editable_paths": [], "stages": [{"id": "initial"}]}
            sessions = root / "task-03-rpc-only/current/attempt-1/sessions"
            sessions.mkdir(parents=True)
            (sessions / "legacy.jsonl").write_text(legacy_path.read_text())
            processes = []
            for index, event in enumerate([exact_error, {"type": "agent_end"}, exact_error]):
                child = Mock(pid=1400 + index, stdout=io.StringIO(json.dumps(event) + "\n"))
                child.wait.return_value = child.poll.return_value = 0
                processes.append(child)
            with patch.object(benchmark.subprocess, "Popen", side_effect=processes), \
                    patch.object(benchmark, "inject_stage"), patch.object(benchmark, "stop_process"), \
                    patch.object(benchmark, "stop_attempt_processes"), \
                    patch.object(benchmark, "prepare_workspace", side_effect=lambda _task, _scenario, path: path.mkdir()), \
                    patch.object(benchmark, "run_judge", side_effect=[
                        (attempt(wall=1, cost=None, progress=3)["judge"], 0.0, "fixture failure"),
                        (attempt(wall=1, cost=None)["judge"], 0.0, "fixture pass"),
                    ]) as judge:
                rpc_case = benchmark.run_case("current", root, rpc_scenario, root, args)
                legacy_attempt = benchmark.run_attempt("vanilla", root, rpc_scenario, root / "legacy-rpc", args)
            self.assertEqual(rpc_case["primary_attempt"], 0)
            self.assertEqual(rpc_case["capacity_invalid_attempts"], 0)
            self.assertEqual(rpc_case["valid_attempts"], 2)
            self.assertEqual(rpc_case["retry_triggers"], [{"attempt": 2, "reasons": ["strict_failure"]}])
            first = rpc_case["attempts"][0]
            self.assertFalse(first["capacity_invalid"])
            self.assertTrue(first["rpc_capacity_observed"])
            self.assertEqual(first["error"], "AgentError: Selected model is at capacity.")
            self.assertEqual(first["judge"]["status"], "fail")
            self.assertTrue(first["metrics"]["provider_capacity_confirmed"])
            self.assertEqual(first["metrics"]["physical_attempts"], [])
            self.assertIsNone(first["metrics"]["all_model_calls"])
            self.assertIsNone(first["metrics"]["api_cost"]["total"])
            self.assertIsInstance(first["agent_wall_seconds"], float)
            self.assertEqual(benchmark.primary_attempt(rpc_case), first)
            self.assertTrue(legacy_attempt["capacity_invalid"])
            self.assertTrue(legacy_attempt["rpc_capacity_observed"])
            self.assertEqual(judge.call_count, 2)
            saved = json.loads((root / "task-03-rpc-only/current/case.json").read_text())
            self.assertEqual(saved["primary_attempt"], 0)
            self.assertEqual(len(saved["attempts"]), 2)
            self.assertTrue(saved["attempts"][0]["rpc_capacity_observed"])

            fallback_dir = root / "rpc-fallback"
            (fallback_dir / "sessions").mkdir(parents=True)
            (fallback_dir / "sessions/legacy.jsonl").write_text(legacy_path.read_text())
            with patch.object(benchmark, "run_attempt", side_effect=RuntimeError("fixture setup failed")):
                fallback = benchmark.safe_run_attempt("current", root, rpc_scenario, fallback_dir, args)
            self.assertFalse(fallback["capacity_invalid"])
            self.assertIsNone(fallback["rpc_capacity_observed"])
            self.assertEqual(fallback["error"], "RuntimeError: fixture setup failed")
            self.assertIsNone(fallback["metrics"]["api_cost"]["total"])
            current = result("current", attempt(wall=8, cost=None))
            summary = benchmark.comprehensive_summary([vanilla, current])
            self.assertIsNone(summary["matched_strict_pass_comparisons"][0]["api_cost_delta_current_minus_baseline"])
            self.assertEqual(len(summary["incomplete_comparisons"]), 1)
            self.assertFalse(summary["publication_ready"])
            self.assertIsNone(summary["by_variant"]["current"]["all_attempts"]["api_cost"]["total"])
            output = root / "summary.md"
            benchmark.write_summary_markdown(output, summary, [vanilla, current])
            self.assertIn("n/a", output.read_text())


    def test_campaign_balances_windows_models_and_effort_phases(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            args = argparse.Namespace(output=root, max_workers=2, group_size=99,
                                      provider="openai-codex", model="gpt-5.6-sol", thinking="medium",
                                      variants="vanilla,current", efforts="low,medium",
                                      api_price_profiles=[{"marks": []}])
            scenarios = {number: (root / f"source-{number}", {"id": number, "slug": f"example-{number}",
                                                          "pressure": "N", "scratch": []}) for number in range(1, 5)}
            manifest = {"publication_protocol": False, "publication_blockers": ["offline fixture"],
                        "auth_route": "existing-host-openai-codex-subscription", "provider_api": "openai-codex-responses"}
            submitted, completed, calls, paths = [], [], [], set()
            first_calls = set()

            def run_case(variant, task_dir, scenario, output, configured):
                key = (configured.thinking, configured.model, scenario["id"])
                if key not in first_calls:
                    self.assertEqual(configured.api_price_profiles[0]["marks"], [])
                    self.assertEqual(scenario["scratch"], [])
                    first_calls.add(key)
                configured.api_price_profiles[0]["marks"].append(variant)
                scenario["scratch"].append(variant)
                calls.append((*key, variant))
                paths.add(output / f"task-{scenario['id']:02d}-{scenario['slug']}" / variant / "attempt-1")
                return {**result(variant, attempt(wall=1, cost=0.1)), "task_id": scenario["id"], "task_slug": scenario["slug"]}

            def submit(function, *values):
                # The next six-job window cannot even be submitted until the previous one finishes.
                if len(submitted) % 6 == 0:
                    self.assertEqual(len(completed), len(submitted))
                configured, scenario = values[-1], values[3]
                key = (configured.thinking, scenario["id"], configured.model)
                submitted.append(key)
                future = Mock()

                def finish():
                    value = function(*values)
                    completed.append(key)
                    return value

                future.result.side_effect = finish
                return future

            with patch.object(benchmark, "run_case", side_effect=run_case), \
                 patch.object(benchmark.concurrent.futures, "ThreadPoolExecutor") as pool, \
                 patch.object(benchmark.concurrent.futures, "as_completed", side_effect=lambda values: reversed(list(values))):
                pool.return_value.__enter__.return_value.submit.side_effect = submit
                outputs = benchmark.run_campaign(args, scenarios, list(scenarios), manifest)
            pool.assert_called_once_with(max_workers=2)
            models = ["gpt-5.6-sol", "gpt-6-astra", "deepseek-flash"]
            self.assertEqual(submitted, [(phase, task_id, model) for phase in ("low", "medium")
                                         for task_id in range(1, 5) for model in models])
            for phase in ("low", "medium"):
                for model_index, model in enumerate(models):
                    for task_id in range(1, 5):
                        order = [entry[3] for entry in calls if entry[:3] == (phase, model, task_id)]
                        self.assertEqual(order, ["current", "vanilla"] if (task_id - 1 + model_index) % 2 else ["vanilla", "current"])
            self.assertEqual(len(paths), 48)
            self.assertEqual(len(outputs), 6)
            self.assertTrue(all(item["runs"] == 8 for item in outputs))
            for item in outputs:
                rows = json.loads((Path(item["output"]) / "results.json").read_text())
                self.assertEqual(len(rows), 8)
                self.assertEqual({row["task_id"] for row in rows}, {1, 2, 3, 4})
            configured = json.loads((root / "medium/deepseek/invocation.json").read_text())
            self.assertEqual(configured["thinking"], "medium")
            self.assertEqual(configured["expected_wire_effort"], "high")
            self.assertEqual(configured["expected_auth_route"], "deepseek-api")
            self.assertNotIn("auth_route", configured)
            self.assertNotIn("observed_wire_effort", configured)
            self.assertEqual(args.api_price_profiles, [{"marks": []}])
            self.assertTrue(all(not scenario["scratch"] for _, scenario in scenarios.values()))
            self.assertEqual(args.model, "gpt-5.6-sol")
            self.assertEqual(args.group_size, 99)  # Campaign windows do not use the single-model setting.

    def test_current_only_low_campaign_retains_failure_without_admitting_other_arms_or_phases(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            args = benchmark.build_parser().parse_args([
                "--three-model-campaign", "--variants", "current", "--output", str(root),
            ])
            args.api_price_profiles = []
            scenarios = {number: (root / f"source-{number}", {"id": number, "slug": f"example-{number}", "pressure": "N"})
                         for number in (1, 2)}
            manifest = {"publication_protocol": False, "publication_blockers": ["offline fixture"]}
            calls = []

            def run_case(variant, task_dir, scenario, output, configured):
                key = (configured.thinking, configured.model, scenario["id"], variant)
                calls.append(key)
                if key == ("low", "gpt-5.6-sol", 1, "current"):
                    raise RuntimeError("first arm failed")
                return {**result(variant, attempt(wall=1, cost=0.1)), "task_id": scenario["id"], "task_slug": scenario["slug"]}

            def submit(function, *values):
                future = Mock()
                future.result.side_effect = lambda: function(*values)
                return future

            with patch.object(benchmark, "run_case", side_effect=run_case), \
                 patch.object(benchmark.concurrent.futures, "ThreadPoolExecutor") as pool, \
                 patch.object(benchmark.concurrent.futures, "as_completed", side_effect=lambda values: list(values)):
                pool.return_value.__enter__.return_value.submit.side_effect = submit
                outputs = benchmark.run_campaign(args, scenarios, [1, 2], manifest)
                with self.assertRaisesRegex(ValueError, "--max-workers must be 1..6"):
                    benchmark.run_campaign(argparse.Namespace(**{**vars(args), "max_workers": 7}), scenarios, [1, 2], manifest)
            pool.assert_called_once_with(max_workers=6)
            rows = json.loads((root / "low/sol/results.partial.json").read_text())
            by_case = {(row["task_id"], row["variant"]): row for row in rows}
            self.assertEqual(by_case[(1, "current")]["attempts"][0]["error"], "RuntimeError: first arm failed")
            self.assertEqual(by_case[(2, "current")]["attempts"][0]["judge"]["status"], "pass")
            self.assertEqual(len(calls), 6)
            self.assertEqual(len(outputs), 3)
            self.assertEqual({(phase, variant) for phase, _model, _task, variant in calls}, {("low", "current")})
            self.assertIn(("low", "deepseek-flash", 2, "current"), calls)
            self.assertTrue(all(item["runs"] == 2 for item in outputs))
            campaign = json.loads((root / "invocation.json").read_text())
            self.assertEqual(campaign["phases"], ["low"])
            self.assertEqual(campaign["variants"], ["current"])
            self.assertFalse((root / "medium").exists())


    def test_public_host_layout_and_selected_provider_launch(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            artifacts, candidate, dependencies = (root / name for name in ("artifacts", "candidate", "dependencies"))
            for path in (artifacts, candidate, dependencies):
                path.mkdir()
            for name in (*host_setup.PUBLIC_PACKAGES.values(), "@earendil-works", "@ponythewhite", "ordinary"):
                (dependencies / name).mkdir()
            for import_key, name in host_setup.PUBLIC_PACKAGES.items():
                metadata = {"name": name, "version": "0.9.4", "type": "module", "dependencies": {}}
                if name == "prime-agent":
                    metadata["bin"] = {"prime-agent": host_setup.CLI_PATH}
                    metadata["dependencies"] = {"@earendil-works/pi-ai": "https://example.invalid/fixture-ai.tgz"}
                files = {"package/package.json": json.dumps(metadata), "package/dist/index.js": "export {};",
                         "package/" + host_setup.CLI_PATH: "export {};"}
                with tarfile.open(artifacts / f"{name}-0.9.4.tgz", "w:gz") as archive:
                    for path, content in files.items():
                        data = content.encode()
                        member = tarfile.TarInfo(path)
                        member.size = len(data)
                        archive.addfile(member, io.BytesIO(data))
            native = candidate / "unpacked/base-context/package"
            (native / "dist/bundle").mkdir(parents=True)
            native_metadata = {"name": benchmark.NATIVE_PACKAGE, "version": "0.1.0", "dependencies": {}}
            benchmark.json_dump(native / "package.json", native_metadata)
            benchmark.json_dump(native / "dist/build-info.json", {"sourceDirty": False, "sourceCommit": "fixture"})
            (native / host_setup.CLI_PATH).write_text("export {};")
            node = root / "node"
            node.write_text("fixture, never executed")
            output = root / "hosts"
            with patch.object(host_setup, "read_candidate", return_value=(
                    "fixture", {benchmark.NATIVE_PACKAGE: native}, {benchmark.NATIVE_PACKAGE: native_metadata})),                  patch.object(host_setup, "require_node", return_value=(node, "22.12.0")):
                manifest = host_setup.prepare_hosts(None, candidate, dependencies, node, output, public_artifacts=artifacts)
            self.assertEqual(manifest["hosts"]["vanilla"]["package_name"], "prime-agent")
            self.assertEqual(manifest["hosts"]["vanilla"]["version"], "0.9.4")
            self.assertEqual(manifest["hosts"]["vanilla"]["kind"], "public-prime-agent")
            for key, name in host_setup.PUBLIC_PACKAGES.items():
                self.assertEqual((output / "node_modules" / key).resolve(), output / "unpacked" / name / "package")
            self.assertFalse((output / "node_modules/@ponythewhite").exists())
            self.assertFalse((output / "node_modules/prime-agent-ai").exists())
            self.assertEqual((output / "node_modules/ordinary").resolve(), dependencies / "ordinary")
            args = argparse.Namespace(hosts_manifest=output / "hosts.json", bwrap="/usr/bin/bwrap",
                                      host_openai_codex_auth_file=root / "subscription.json",
                                      host_deepseek_api_key_file=root / "deepseek-key", thinking="medium")
            benchmark.apply_hosts_manifest(args)
            args.host_deepseek_api_key_file.write_text("fixture-provider-secret")
            for provider, model, variant, entry, mount, excluded in (
                ("deepseek", "deepseek-flash", "vanilla", "runDeepSeekRpc", "/run/host-deepseek-api-key", "/run/host-openai-codex-auth.json"),
                ("openai-codex", "gpt-5.6-sol", "current", "runSubscriptionRpc", "/run/host-openai-codex-auth.json", "/run/host-deepseek-api-key"),
            ):
                args.provider, args.model = provider, model
                run_dir = root / provider
                roots = benchmark.prepare_agent_home(run_dir, args)
                workspace = run_dir / "workspace"
                workspace.mkdir()
                command = benchmark.agent_command(variant, workspace, roots, args)
                bootstrap = Path(command[-1]).read_text()
                self.assertIn(f"await {entry}(host,", bootstrap)
                self.assertNotIn("fixture-provider-secret", bootstrap)
                settings = json.loads((roots["config"] / "settings.json").read_text())
                self.assertEqual(settings["defaultProvider"], provider)
                models = json.loads((roots["config"] / "models.json").read_text())
                if provider == "deepseek":
                    configured = models["providers"]["deepseek"]["models"][0]
                    self.assertEqual(configured["id"], model)
                    self.assertEqual(configured["thinkingLevelMap"]["medium"], "high")
                    self.assertEqual(configured["compat"]["maxTokensField"], "max_tokens")
                    self.assertNotIn("apiKey", models["providers"]["deepseek"])
                else:
                    self.assertEqual(models, {})
                isolated = benchmark.isolated_agent_command(command, args.hosts[variant], run_dir, args)
                self.assertIn(mount, isolated)
                self.assertNotIn(excluded, isolated)
                shell = roots["launcher"].read_text()
                self.assertNotIn(mount, shell)
                self.assertNotIn(str(args.host_deepseek_api_key_file), shell)

    def test_shared_bash_workspace_devices_and_timeout_recovery(self) -> None:
        node = os.environ.get("PRIME_CONTEXT_BENCHMARK_NODE") or shutil.which("node")
        bwrap = shutil.which("bwrap")
        if not node or not bwrap:
            self.skipTest("Node and bubblewrap are required for the shared Bash contract")
        python = benchmark.python312()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            launcher = benchmark.create_sandbox_scripts(root, argparse.Namespace(bwrap=bwrap))
            (root / "sandbox-runtime/services.json").write_text('{"services": []}')
            script = r"""
import assert from "node:assert/strict";
const { default: extension } = await import(process.argv[1]);
let tool;
extension({ registerTool(value) { tool = value; } });
const controller = new AbortController();
const execute = (params) => tool.execute("contract-test", params, controller.signal, undefined, { cwd: process.argv[2] });
const shell = process.env.PRIME_CONTEXT_BENCHMARK_SHELL;
const happy = await execute({ command: "python -c 'import os; from pathlib import Path; assert os.getcwd() == \"/workspace\"; Path(\"scratch\").mkdir(); Path(\"scratch/persisted.txt\").write_text(\"saved\"); print(\"ok\")' 2>/dev/null" });
assert.equal(happy.content[0].text.trim(), "ok");
// Accelerate only the default deadline; exercise real process-group TERM -> KILL.
process.env.PRIME_CONTEXT_BENCHMARK_SHELL = process.argv[3];
const setTimer = globalThis.setTimeout;
const delays = [];
globalThis.setTimeout = (callback, delay, ...args) => {
  delays.push(delay);
  return setTimer(callback, delay === 60_000 ? 300 : delay, ...args);
};
try {
  await assert.rejects(execute({ command: "import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); signal.alarm(5); print('ready', flush=True); exec('while True: pass')" }), (error) => {
    assert.match(error.message, /ready/);
    assert.match(error.message, /Command timed out after 60000 ms/);
    return true;
  });
} finally {
  globalThis.setTimeout = setTimer;
}
assert.ok(delays.includes(60_000));
assert.ok(delays.includes(1_000));
await assert.rejects(execute({ command: "import signal; signal.alarm(5); exec('while True: pass')", timeout: 30 }), /Command timed out after 30 ms/);
process.env.PRIME_CONTEXT_BENCHMARK_SHELL = shell;
const recovered = await execute({ command: "python -c 'from pathlib import Path; print(Path(\"scratch/persisted.txt\").read_text())' 2>/dev/null" });
assert.equal(recovered.content[0].text.trim(), "saved");
console.log("shared Bash contract passed");
"""
            completed = subprocess.run(
                [node, "--input-type=module", "--eval", script,
                 Path(__file__).with_name("bash-tool.mjs").resolve().as_uri(), str(workspace), python],
                cwd=workspace, capture_output=True, text=True, timeout=10,
                env={"PATH": "/usr/bin:/bin", "PRIME_CONTEXT_BENCHMARK_SHELL": str(launcher)},
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            self.assertIn("shared Bash contract passed", completed.stdout)

    def test_itinerary_module_and_package_entrypoint_parity(self) -> None:
        spec = importlib.util.spec_from_file_location(
            "itinerary_judge", Path(__file__).parent / "tasks/08-travel-itinerary-repair/judge.py")
        judge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(judge)
        with tempfile.TemporaryDirectory() as directory:
            candidate = Path(directory)
            solution = candidate / "solution"
            solution.mkdir()
            (solution / "__init__.py").write_text("")
            for layout in ("itinerary_check.py", "itinerary_check/__main__.py"):
                with self.subTest(layout=layout):
                    entrypoint = solution / layout
                    entrypoint.parent.mkdir(exist_ok=True)
                    entrypoint.write_text("print('entrypoint')\n")
                    self.assertTrue(judge.has_entrypoint(candidate))
                    _, run, temporary = judge.execute(candidate, "main")
                    try:
                        self.assertEqual(run.returncode, 0, run.stderr)
                        self.assertEqual(run.stdout.strip(), "entrypoint")
                    finally:
                        temporary.cleanup()
                        entrypoint.unlink()
            self.assertFalse(judge.has_entrypoint(candidate))
            (solution / "itinerary_check/__main__.py").write_text("raise RuntimeError('invalid entrypoint')\n")
            _, run, temporary = judge.execute(candidate, "edge")
            try:
                self.assertNotEqual(run.returncode, 0)
            finally:
                temporary.cleanup()

    def test_public_host_rejects_foreign_package_before_creation(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            artifacts, candidate, dependencies = (root / name for name in ("artifacts", "candidate", "dependencies"))
            for path in (artifacts, candidate, dependencies):
                path.mkdir()
            data = json.dumps({"name": "@earendil-works/pi-coding-agent", "version": "0.9.4", "type": "module"}).encode()
            with tarfile.open(artifacts / "prime-agent-0.9.4.tgz", "w:gz") as archive:
                member = tarfile.TarInfo("package/package.json")
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            output = root / "hosts"
            with patch.object(host_setup, "require_node") as node:
                with self.assertRaisesRegex(ValueError, "expected ESM prime-agent@0.9.4"):
                    host_setup.prepare_hosts(None, candidate, dependencies, root / "node", output, public_artifacts=artifacts)
            node.assert_not_called()
            self.assertFalse(output.exists())


class CodexAdapterTests(unittest.TestCase):
    def test_commands_use_stdin_and_safe_resume_placement(self) -> None:
        initial = codex_benchmark.initial_command("codex", Path("/tmp/work"), Path("/tmp/last"))
        resumed = codex_benchmark.resume_command("codex", Path("/tmp/work"), "thread-1", Path("/tmp/last-2"))
        self.assertEqual(initial[-1], "-")
        self.assertEqual(resumed[-1], "-")
        self.assertIn('features.network_proxy.domains={ "127.0.0.1" = "allow" }', initial)
        self.assertLess(resumed.index('features.network_proxy.domains={ "127.0.0.1" = "allow" }'), resumed.index("resume"))
        self.assertEqual(resumed[-2], "thread-1")

    def test_codex_environment_is_an_explicit_allowlist(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            codex_home = Path(temporary) / "codex-home"
            codex_home.mkdir()
            environment = codex_benchmark.clean_codex_environment(codex_home)
        self.assertEqual(environment["CODEX_HOME"], str(codex_home))
        self.assertEqual(environment["HOME"], str(codex_home.parent / "empty-home"))
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertNotIn("PRIME_API_KEY", environment)
        self.assertEqual(set(environment), {
            "PATH", "HOME", "CODEX_HOME", "TERM", "LANG", "LC_ALL", "TZ",
            "PIP_NO_INDEX", "PIP_DISABLE_PIP_VERSION_CHECK", "UV_OFFLINE",
            "npm_config_offline", "npm_config_audit", "npm_config_fund",
            "PYTHONUTF8", "PYTHONDONTWRITEBYTECODE",
        })


class ComparisonReportTests(unittest.TestCase):
    def write_attempt(self, root, effort, model, variant, number, value):
        value = {**value, "task_id": 1, "variant": variant}
        value.setdefault("error", None)
        value.setdefault("capacity_invalid", False)
        value["metrics"].setdefault("compaction_failures", 0)
        path = root / effort / model / "task-01-example" / variant / f"attempt-{number}" / "result.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
        return path

    def test_reusable_effort_model_and_harness_selection(self):
        import compare
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "invocation.json").write_text(json.dumps({
                "phases": ["low", "medium"], "models": [{"label": m} for m in ("sol", "astra", "deepseek")],
                "tasks": [1], "candidate_commit": "future-build",
            }))
            baseline_root = root / "retained"
            for model in ("sol", "astra", "deepseek"):
                self.write_attempt(root, "medium", model, "optimized", 1, attempt(wall=10, cost=None))
                self.write_attempt(root, "medium", model, "reference", 1, attempt(wall=999, cost=None))
                self.write_attempt(baseline_root, "medium", model, "reference", 1, attempt(wall=20, cost=None))
            report = compare.compare(root, efforts=["medium"], models=["sol", "astra"],
                                     candidate="optimized", baseline="reference", baseline_results=baseline_root)
            self.assertFalse(report["complete"])
            self.assertEqual(report["candidate_commit"], "future-build")
            self.assertEqual(report["baseline_root"], str(baseline_root))
            self.assertEqual(report["completed_primary_runs"], 4)
            self.assertEqual(report["expected_primary_runs"], 4)
            self.assertEqual(report["common_matched_pass"]["medium"]["task_ids"], [1])
            self.assertEqual(report["groups"][0]["matched_pass"]["candidate_over_baseline_time"], 0.5)
            self.assertIsNone(report["groups"][0]["variants"]["reference"]["primary"]["all_model_calls"])
            text = compare.markdown(report)
            self.assertIn("MEDIUM progress", text)
            self.assertNotIn("LOW progress", text)
            self.assertIn("optimized", text)
            self.assertIn("Retained baseline campaign:", text)
            self.assertIn("not contemporaneous", text)

    def test_keeps_failed_primary_retry_capacity_and_partial_write(self):
        import compare
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "invocation.json").write_text(json.dumps({
                "phases": ["low"], "models": [{"label": "sol"}, {"label": "astra"}], "tasks": [1],
            }))
            invalid = {**attempt(wall=1, cost=None), "capacity_invalid": True}
            failed = {**attempt(wall=3, cost=None, progress=1), "error": "timeout"}
            for number, value in enumerate((invalid, failed, attempt(wall=5, cost=None)), 1):
                self.write_attempt(root, "low", "sol", "current", number, value)
            self.write_attempt(root, "low", "sol", "vanilla", 1, attempt(wall=2, cost=None))
            torn = self.write_attempt(root, "low", "astra", "current", 1, attempt(wall=1, cost=None))
            torn.write_text("{")
            report = compare.compare(root)
            sol = report["groups"][0]
            current = sol["variants"]["current"]
            self.assertEqual(current["primary"]["strict_passes"], 0)
            self.assertEqual(current["primary"]["agent_wall_seconds"], 3)
            self.assertEqual(current["all_retained"]["runs"], 3)
            self.assertEqual(current["all_retained"]["agent_wall_seconds"], 9)
            self.assertEqual(current["nonpass_or_error"]["runs"], 2)
            self.assertEqual(current["capacity_invalid"], 1)
            self.assertEqual(current["valid_retries"], 1)
            self.assertEqual(sol["lost_ids"], [1])
            self.assertEqual(sol["matched_pass"]["task_ids"], [])
            self.assertEqual(report["pending_read_files"], [str(torn)])
            self.assertEqual(report["groups"][1]["variants"]["current"]["primary"]["runs"], 0)


if __name__ == "__main__":
    unittest.main()
