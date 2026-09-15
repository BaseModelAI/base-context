"""Offline paired campaign happy path and bounded-retry edge; no native/provider runner."""
import argparse
import contextlib
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path

import paired_medium_reference as campaign


class PairedMediumReferenceTest(unittest.TestCase):
    @staticmethod
    def make_result(task, variant, model):
        result = {
            "task_id": task, "variant": variant, "capacity_invalid": False, "error": None,
            "judge": {"status": "pass", "progress_level": 5},
            "agent_wall_seconds": 2, "lifecycle_wall_seconds": 3,
            "metrics": {"compaction_failures": 0,
                        "accounting_source": ("native_request_receipts" if variant == "current"
                                              else "instrumented_physical_attempts"),
                        "cost_basis": "fake-api-equivalent",
                        "api_price_estimates": [{"profile_id": model, "basis": "fake-api-equivalent",
                            "coverage": "native_recorded_attempts" if variant == "current" else "instrumented_physical_attempts",
                            "observations": 2, "unpriced_observations": 0,
                            "known_subtotal": 1, "conditional_range": None, "models": []}],
                        "accounting_incomplete": False, "cost_complete": True, "usage_complete": True,
                        "incurred_cost_complete": True, "api_cost": {"total": 1},
                        "physical_attempts": [{"purpose": "main"}, {"purpose": "provider-recovery"}],
                        "all_model_calls": 2, "unsettled_attempts": 0},
        }
        return result

    def make_source(self, root, failures=False):
        manifest = {"schema": "prime-context.python-realworld-paired-medium-reference/v1",
                    "output": str(root), "tasks": list(range(1, 31)),
                    "candidate_commit": "source-sdk84", "hosts": {"vanilla": {"version": "0.9.4"}},
                    "api_price_profiles": [{"id": "unchanged-profile"}],
                    "primaries_completed_at": "original-180-done", "completed_at": "source-done"}
        cells = []
        for task in range(1, 31):
            for label, _, model, *_ in campaign.MODELS:
                for variant in campaign.VARIANTS:
                    cell = {"task_id": task, "model": label, "variant": variant,
                            "source_id": f"original-{task}-{label}-{variant}", "attempts": []}
                    retry = failures and (task, label, variant) in ((1, "sol", "current"), (2, "astra", "vanilla"))
                    for number in range(1, 3 if retry else 2):
                        result = self.make_result(task, variant, model)
                        if retry and number == 1:
                            result["error"] = "source runtime failure"
                        if retry and label == "sol" and number == 1:
                            result["metrics"].update(incurred_cost_complete=None, cost_complete=False,
                                                     api_cost={"total": None})
                            result["metrics"]["api_price_estimates"][0]["known_subtotal"] = None
                        if retry and label == "astra" and number == 2:
                            result.update(capacity_invalid=True, error="worse sole retry")
                        raw = root / label / str(task) / variant / f"attempt-{number}"
                        campaign.harness.json_dump(raw / "result.json", result)
                        cell["attempts"].append({"number": number, "kind": "primary" if number == 1 else "benchmark_retry",
                                                 "raw_dir": str(raw), "result_path": str(raw / "result.json"),
                                                 "result": result})
                    cells.append(cell)
        campaign.save(root, manifest, cells)
        return manifest, cells

    def run_fake(self, root, failures=False, restart_from=None):
        scenarios = {task: (root, {"id": task, "slug": f"case-{task}"}) for task in range(1, 31)}
        args = argparse.Namespace(output=root)
        manifest = {"output": str(root), "tasks": list(scenarios)}
        if restart_from:
            manifest.update(restart_deepseek_from=str(restart_from), candidate_commit="corrected-deep-sdk",
                            hosts={"vanilla": {"version": "0.9.4"}}, api_price_profiles=[{"id": "unchanged-profile"}])
        count = 60 if restart_from else 180
        pairs = 2 if restart_from else 6
        starts, finishes = [], []
        lock, first_tasks = threading.Lock(), threading.Barrier(pairs)
        advanced = threading.Event()
        fast, slow = (("deepseek-flash", "current"), ("deepseek-flash", "vanilla")) if restart_from else (
            ("gpt-5.6-sol", "current"), ("gpt-6-astra", "vanilla"))
        maximum, active = 0, 0
        active_by_pair, maximum_by_pair, maximum_retry_by_pair = {}, {}, {}
        primary_counts_at_retry, retries_after_previous = [], []
        independent_progress = []

        def runner(variant, task_dir, scenario, attempt_dir, configured):
            nonlocal maximum, active
            task, model = scenario["id"], configured.model
            number = int(attempt_dir.name.split("-")[-1])
            pair = (model, variant)
            with lock:
                if number == 2:
                    primary_counts_at_retry.append(sum(n == 1 for _, _, _, n in finishes))
                    earlier = [s for s in starts if s[1:3] == pair and s[3] == 2]
                    retries_after_previous.append(all(s in finishes for s in earlier))
                starts.append((task, model, variant, number))
                active += 1
                maximum = max(maximum, active)
                active_by_pair[pair] = active_by_pair.get(pair, 0) + 1
                maximum_by_pair[pair] = max(maximum_by_pair.get(pair, 0), active_by_pair[pair])
                if number == 2:
                    maximum_retry_by_pair[pair] = max(maximum_retry_by_pair.get(pair, 0), active_by_pair[pair])
                if number == 1 and task == 2 and pair == fast:
                    independent_progress.append((1, *slow, 1) not in finishes)
                    advanced.set()
            self.assertEqual(configured.thinking, "medium")
            if number == 1 and task == 1:
                first_tasks.wait(timeout=5)
                if pair == slow:
                    self.assertTrue(advanced.wait(timeout=5))
            result = self.make_result(task, variant, model)
            if failures and pair == fast and task in (1, 4) and number == 1:
                result.update(capacity_invalid=True, error="capacity interruption")
            if failures and task == 2 and pair == slow:
                if number == 1:
                    result["error"] = "runtime failure after strict pass"
                else:
                    result.update(capacity_invalid=True, error="retry capacity interruption")
            if failures and (task, model, variant) == (3, "deepseek-flash", "vanilla"):
                result["metrics"].update(cost_complete=False, incurred_cost_complete=None, api_cost={"total": None})
                result["metrics"]["api_price_estimates"][0].update(known_subtotal=None, unpriced_observations=2)
                if number == 1:
                    result["judge"] = {"status": "fail", "progress_level": 2}
            with lock:
                active -= 1
                active_by_pair[pair] -= 1
                finishes.append((task, model, variant, number))
            return result

        with contextlib.redirect_stdout(io.StringIO()):
            cells = campaign.run_campaign(args, scenarios, manifest, runner=runner)
        self.assertEqual(maximum, pairs)
        self.assertEqual(independent_progress, [True])
        self.assertEqual(len(maximum_by_pair), pairs)
        self.assertTrue(all(count == 1 for count in maximum_by_pair.values()))
        for pair in maximum_by_pair:
            self.assertEqual([t for t, m, v, n in starts if (m, v) == pair and n == 1], list(range(1, 31)))
        self.assertEqual(len(starts[:count]), count)
        self.assertTrue(all(n == 1 for _, _, _, n in starts[:count]))
        self.assertEqual(primary_counts_at_retry, [count] * (4 if failures else 0))
        self.assertTrue(all(retries_after_previous))
        self.assertTrue(all(count == 1 for count in maximum_retry_by_pair.values()))
        self.assertTrue(all(len(c["attempts"]) <= 2 for c in cells))
        self.assertTrue(all(Path(r["result_path"]).is_file() for c in cells for r in c["attempts"]))
        summary = json.loads((root / "summary.json").read_text())
        return cells, summary, starts

    def test_180_independent_pair_medium_primaries(self):
        with tempfile.TemporaryDirectory() as directory:
            cells, summary, starts = self.run_fake(Path(directory))
            self.assertEqual(len(starts), 180)
            self.assertTrue(summary["complete"])
            self.assertEqual(summary["benchmark_retries"], 0)
            self.assertEqual(sum(e["known_subtotal"] for e in summary["all_incurred"]["api_price_estimates"]), 180)
            self.assertTrue(all(g["matched_clean_first_primary"]["current_over_vanilla_cost"] == 1 for g in summary["groups"]))
            self.assertEqual(summary["all_incurred"]["physical_attempt_records"], 360)
            self.assertTrue(all(len(g["matched_clean_first_primary"]["task_ids"]) == 30 for g in summary["groups"]))
            incomplete = campaign.activity([{"result": None}])
            self.assertIsNone(incomplete["incurred_cost_complete"])
            self.assertIsNone(incomplete["api_cost"]["total"])
            self.assertIsNone(incomplete["physical_attempt_records"])

    def test_retry_queue_keeps_invalid_unpriced_and_never_selects_best(self):
        with tempfile.TemporaryDirectory() as directory:
            cells, summary, starts = self.run_fake(Path(directory), failures=True)
            self.assertEqual(len(starts), 184)
            self.assertTrue(summary["complete"])
            self.assertEqual(summary["benchmark_retries"], 4)
            retries = starts[180:]
            self.assertTrue(all(n == 2 for _, _, _, n in retries))
            self.assertEqual(len({(t, m, v) for t, m, v, _ in retries}), 4)
            self.assertEqual([t for t, m, v, _ in retries if (m, v) == ("gpt-5.6-sol", "current")], [1, 4])
            sol, astra, deep = summary["groups"]
            self.assertEqual(sol["variants"]["current"]["first_primary_accuracy"]["strict_pass"], 28)
            self.assertEqual(sol["variants"]["current"]["retry_assisted_accuracy"]["strict_runtime_clean"], 30)
            self.assertEqual(astra["variants"]["vanilla"]["first_primary_accuracy"]["strict_pass"], 30)
            self.assertEqual(astra["variants"]["vanilla"]["retry_assisted_accuracy"]["strict_pass"], 29)
            self.assertNotIn(1, sol["matched_clean_first_primary"]["task_ids"])
            self.assertIn(1, sol["matched_clean_retry_assisted"]["task_ids"])
            self.assertEqual(sol["matched_clean_retry_assisted"]["variants"]["current"]["api_cost"]["total"], 32)
            self.assertNotIn(2, astra["matched_clean_first_primary"]["task_ids"])
            self.assertIsNone(deep["matched_clean_retry_assisted"]["current_over_vanilla_cost"])
            self.assertEqual(summary["all_incurred"]["admitted_attempts"], 184)
            self.assertEqual(summary["all_incurred"]["capacity_invalid_runs"], 3)
            self.assertEqual(summary["retry_overhead"]["admitted_attempts"], 4)
            self.assertIsNone(summary["all_incurred"]["incurred_cost_complete"])
            self.assertIsNone(summary["all_incurred"]["api_cost"]["total"])
            self.assertEqual(summary["all_incurred"]["physical_attempt_records"], 368)
            # The same completed clean cohort must not compare absent/mismatched prices or relabeled stock.
            sol_cells = [c for c in cells if c["model"] == "sol"]
            changed = next(c for c in sol_cells if c["variant"] == "vanilla" and c["task_id"] == 2)
            metrics = changed["attempts"][0]["result"]["metrics"]
            estimate = metrics["api_price_estimates"][0]
            for profile in (None, "other-profile"):
                estimate["profile_id"] = profile
                self.assertIsNone(campaign.matched(sol_cells, range(1, 31), True)["current_over_vanilla_cost"])
            estimate["profile_id"] = "gpt-5.6-sol"
            metrics["cost_basis"] = estimate["basis"] = "other-basis"
            self.assertFalse(campaign.matched(sol_cells, range(1, 31), True)["cost_comparable"])
            metrics["cost_basis"] = estimate["basis"] = "fake-api-equivalent"
            metrics["accounting_source"] = "native_request_receipts"
            self.assertFalse(campaign.matched(sol_cells, range(1, 31), True)["cost_comparable"])


    def test_deepseek_restart_retains_source_and_runs_only_two_fresh_queues(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, fresh = root / "source", root / "fresh"
            original, source_cells = self.make_source(source)
            source_text = (source / "results.json").read_text()
            cells, summary, starts = self.run_fake(fresh, restart_from=source)
            self.assertEqual(len(starts), 60)
            self.assertEqual({model for _, model, _, _ in starts}, {"deepseek-flash"})
            self.assertTrue(summary["complete"])
            self.assertEqual(summary["completed_primaries"], 180)
            self.assertEqual(summary["all_incurred"]["admitted_attempts"], 180)
            self.assertEqual((source / "results.json").read_text(), source_text)
            for cell in cells:
                if cell["model"] != "deepseek":
                    old = next(c for c in source_cells if (c["task_id"], c["model"], c["variant"]) ==
                               (cell["task_id"], cell["model"], cell["variant"]))
                    self.assertEqual(cell, {**old, "source_output": str(source)})
                else:
                    self.assertEqual(cell["source_output"], str(fresh))
            manifest = json.loads((fresh / "invocation.json").read_text())
            self.assertEqual(manifest["current_commits_by_model"],
                             {"sol": "source-sdk84", "astra": "source-sdk84", "deepseek": "corrected-deep-sdk"})
            self.assertEqual(manifest["retained_source_manifest"], original)
            self.assertNotIn("candidate_commit", manifest)
            self.assertEqual(manifest["max_workers"], 2)
            self.assertIn("partial restart", " ".join(summary["notes"]))
            with self.assertRaisesRegex(ValueError, "must differ"):
                campaign.prepare_deepseek_restart({"output": str(source), "restart_deepseek_from": str(source)})

    def test_deepseek_restart_pending_source_finalizes_report_only_with_actual_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, fresh = root / "source", root / "fresh"
            original, source_cells = self.make_source(source, failures=True)
            pending = json.loads(json.dumps(source_cells))
            missing = next(c for c in pending if (c["task_id"], c["model"], c["variant"]) == (2, "astra", "vanilla"))
            missing["attempts"][-1]["result"] = None
            campaign.save(source, {k: v for k, v in original.items() if k != "completed_at"}, pending)
            cells, summary, starts = self.run_fake(fresh, failures=True, restart_from=source)
            self.assertEqual(len(starts), 64)
            self.assertFalse(summary["complete"])
            self.assertIn("source", summary["finalization_pending"])
            deep_before = [c for c in cells if c["model"] == "deepseek"]
            campaign.save(source, original, pending)  # A marker alone does not finalize missing retained trials.
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(campaign.finalize_deepseek_restart(fresh))
            campaign.save(source, original, source_cells)
            from unittest.mock import patch
            with patch.object(campaign.harness, "safe_run_attempt", side_effect=AssertionError("provider call")), \
                    patch.object(campaign.harness, "apply_hosts_manifest", side_effect=AssertionError("host setup")), \
                    patch("sys.argv", ["paired_medium_reference.py", "--output", str(fresh), "--finalize-deepseek-restart"]):
                self.assertEqual(campaign.main(), 0)
            merged = json.loads((fresh / "results.json").read_text())
            self.assertEqual([c for c in merged if c["model"] == "deepseek"], deep_before)
            summary = json.loads((fresh / "summary.json").read_text())
            self.assertTrue(summary["complete"])
            self.assertEqual(summary["completed_primaries"], 180)
            self.assertEqual(summary["benchmark_retries"], 6)  # Two retained, four fresh; discarded DeepSeek contributes none.
            sol, astra, deep = summary["groups"]
            self.assertIsNone(sol["matched_clean_retry_assisted"]["variants"]["current"]["api_cost"]["total"])
            self.assertFalse(sol["matched_clean_retry_assisted"]["cost_comparable"])
            self.assertEqual(astra["variants"]["vanilla"]["retry_assisted_accuracy"]["strict_pass"], 29)
            self.assertEqual(deep["variants"]["current"]["all_incurred"]["api_cost"]["total"], 32)
            self.assertEqual(deep["variants"]["vanilla"]["retry_assisted_accuracy"]["strict_pass"], 29)
            self.assertIsNone(deep["matched_clean_retry_assisted"]["current_over_vanilla_cost"])
            self.assertEqual(summary["all_incurred"]["admitted_attempts"], 186)
            for cell in merged:
                if cell["model"] != "deepseek":
                    old = next(c for c in source_cells if c["source_id"] == cell["source_id"])
                    self.assertEqual(cell["attempts"], old["attempts"])


if __name__ == "__main__":
    unittest.main()
