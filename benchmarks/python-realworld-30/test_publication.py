"""Offline happy path and missing-data/admission edge for publication helpers."""
import argparse
import copy
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


exporter = module("export_results")
reproduce = module("reproduce")


def sample():
    result = {"error": None, "capacity_invalid": False,
              "judge": {"status": "pass", "progress_level": 5},
              "agent_wall_seconds": 10.0, "lifecycle_wall_seconds": 12.0,
              "started_at": "2026-09-01T00:00:00+00:00", "completed_at": "2026-09-01T00:00:12+00:00",
              "command": ["DO_NOT_EXPORT"], "responses": [{"body": "DO_NOT_EXPORT"}],
              "metrics": {**{key: 0 for key in exporter.COUNTERS}, "session_count": 1,
                          "incurred_cost_complete": True, "api_cost": {"total": 0.2},
                          "api_price_estimates": [{"profile_id": "openai-standard-astra-2026-09-11",
                            "basis": "openai-standard-api-equivalent", "known_subtotal": 0.2,
                            "observations": 1, "unpriced_observations": 0}]}}
    return [{"task_id": 1, "model": "astra", "variant": "current",
             "source_output": "DO_NOT_EXPORT", "attempts": [{"number": 1, "result": result}]}]


def run_args():
    return argparse.Namespace(qualification_complete=True, admit_provider_calls=True,
                              hosts_manifest=Path("hosts.json"), current_commit="a" * 40,
                              api_price_profiles=ROOT / "api-price-profiles.json",
                              host_openai_codex_auth_file=Path("user-supplied-auth"),
                              host_deepseek_api_key_file=Path("user-supplied-key"), output=Path("fresh-output"))


def candidate_archives(directory):
    archives, dependencies = directory / "archives", directory / "dependencies"
    archives.mkdir()
    dependencies.mkdir()
    preparer = reproduce.load_preparer()
    for name in preparer.NATIVE_PACKAGES:
        with tarfile.open(archives / f"{name}.tgz", "w:gz") as archive:
            files = {"package/package.json": {"name": f"@ponythewhite/{name}", "version": "1.0.0"}}
            if name == "base-context":
                files["package/dist/build-info.json"] = {"sourceCommit": "a" * 40, "sourceDirty": False}
            for path, data in files.items():
                payload = json.dumps(data).encode()
                info = tarfile.TarInfo(path)
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
    return archives, dependencies, preparer


class PublicationTest(unittest.TestCase):
    def test_happy_export_and_explicit_run_command(self):
        cells, attempts, summary = exporter.export_rows(sample())
        self.assertEqual((summary["cells"], summary["effective_attempts"]), (1, 1))
        self.assertTrue(cells[0]["terminal_strict_runtime_clean"])
        self.assertEqual(summary["groups"][-1]["whole_cost_usd"], 0.2)
        self.assertNotIn("DO_NOT_EXPORT", json.dumps([cells, attempts, summary]))
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            exporter.write_csv(output / "cells.csv", cells)
            exporter.write_markdown(output / "cells.md", cells)
            self.assertIn("task_id,model,harness", (output / "cells.csv").read_text())
            archives, dependencies, preparer = candidate_archives(output)
            reproduce.candidate(archives, dependencies, output / "candidate", "a" * 40, preparer)
            info = json.loads((output / "candidate/package-inspection.json").read_text())
            self.assertEqual(info["commit"], "a" * 40)
            self.assertEqual(len(info["privateCoreRoots"]), 4)
        self.assertTrue(reproduce.supported_node("22.12.0"))
        self.assertTrue(reproduce.supported_node("23.3.0"))
        self.assertTrue(reproduce.supported_node("24.0.0"))
        command = reproduce.live_command(run_args())
        self.assertIn("--qualified-current-commit", command)
        self.assertIn("--qualification-complete", command)
        self.assertIn("--admit-provider-calls", command)

    def test_unknown_failed_retry_and_unadmitted_run(self):
        raw = sample()
        retry = copy.deepcopy(raw[0]["attempts"][0])
        retry["number"] = 2
        retry["result"].update(error="DO_NOT_EXPORT", judge={"status": "fail", "progress_level": 0},
                               lifecycle_wall_seconds=None)
        retry["result"]["metrics"].update(incurred_cost_complete=False, compaction_completions=None)
        raw[0]["attempts"].append(retry)
        cells, attempts, summary = exporter.export_rows(raw)
        self.assertFalse(cells[0]["terminal_strict_runtime_clean"])
        self.assertIsNone(cells[0]["all_lifecycle_wall_seconds"])
        self.assertEqual(cells[0]["all_lifecycle_wall_seconds_known_subtotal"], 12)
        self.assertEqual(cells[0]["all_compaction_completions_observed_attempts"], 1)
        self.assertIsNone(cells[0]["whole_cost_usd"])
        self.assertEqual(cells[0]["known_cost_subtotal_usd"], 0.4)
        self.assertEqual(summary["effective_attempts"], 2)
        self.assertNotIn("DO_NOT_EXPORT", json.dumps([cells, attempts, summary]))
        self.assertFalse(reproduce.supported_node("22.11.0"))
        self.assertFalse(reproduce.supported_node("23.0.0"))
        self.assertFalse(reproduce.supported_node("23.2.0"))
        args = run_args()
        args.admit_provider_calls = False
        with self.assertRaisesRegex(ValueError, "admit-provider-calls"):
            reproduce.live_command(args)
        args.admit_provider_calls, args.qualification_complete = True, False
        with self.assertRaisesRegex(ValueError, "qualification"):
            reproduce.live_command(args)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            archives, dependencies, preparer = candidate_archives(output)
            with self.assertRaisesRegex(ValueError, "clean build"):
                reproduce.candidate(archives, dependencies, output / "candidate", "b" * 40, preparer)


if __name__ == "__main__":
    unittest.main()
