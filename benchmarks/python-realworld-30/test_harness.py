from __future__ import annotations

import argparse
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from benchlib import aggregate_sessions, collect_sessions, parse_session_file

import run as benchmark
import run_codex as codex_benchmark


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
) -> None:
    timestamp = "2026-09-07T00:00:00.000Z"
    descriptor = {
        "api": "openai-completions", "provider": "openai", "model": "fixture",
        "transport": "http", "ordinal": 1, "kind": "initial",
    }
    metadata = {
        "operationId": "operation",
        "source": {"sessionId": "root", "leafId": None, "sourceSequence": 0, "persistent": True},
        "owner": {"sessionId": "root"}, "purpose": "main",
        "modelContract": {
            "api": "openai-completions", "provider": "openai", "model": "fixture",
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
    usage = {"input": 100, "inputTotal": 125, "output": 20, "cacheRead": 25, "cacheWrite": 0, "totalTokens": 145}
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


if __name__ == "__main__":
    unittest.main()
