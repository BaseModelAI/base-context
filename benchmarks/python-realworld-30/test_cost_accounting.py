"""Two focused, offline accounting-bridge cases. No provider or journal access."""
from __future__ import annotations

import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from benchlib import apply_instrumented_accounting, apply_native_incurred_accounting

PROFILES = json.loads(Path(__file__).with_name("api-price-profiles.json").read_text())
SCHEMA = {"schema": "prime-cost-accounting/1", "pid": 7}


def request(model: str = "deepseek-flash", *, written: bool = False) -> dict:
    codex = model != "deepseek-flash"
    identity = {"provider": "openai-codex" if codex else "deepseek",
                "api": "openai-codex-responses" if codex else "openai-completions", "model": model}
    raw = ({"input_tokens": 100, "output_tokens": 10, "total_tokens": 110,
            "input_tokens_details": {"cached_tokens": 40, **({"cache_write_tokens": 0} if written else {})}}
           if codex else {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110,
                          "prompt_cache_hit_tokens": 40, "prompt_cache_miss_tokens": 60})
    return {**SCHEMA, "type": "attempt_settled", "attemptId": "a", "operationId": "op", "purpose": "main",
            "modelContract": identity,
            "source": {"sessionId": "root", "persistent": True, "sourceSequence": 2, "leafId": None},
            "receipt": {**identity, "attemptId": "a", "outcome": "completed", "usageCompleteness": "complete",
                        "usage": {"inputTotal": 100, "input": 60, "output": 10, "cacheRead": 40,
                                  "cacheWrite": 0, "totalTokens": 110}, "rawUsage": [raw]}}


def sidecar(item: dict) -> list[dict]:
    scope = {**SCHEMA, "operationId": item["operationId"], "purpose": item["purpose"],
             "modelContract": item["modelContract"]}
    admission = {key: value for key, value in item.items() if key != "receipt"}
    admission["type"] = "attempt_admitted"
    return [
        {**SCHEMA, "type": "accounting_opened", "patchVersion": "prime-agent-0.9.4-cost-accounting-1",
         "coveredApis": ["openai-completions", "openai-codex-responses"]},
        {**scope, "type": "operation_started"},
        {**scope, "type": "transport_connection_started", "connectionId": "connection"},
        {**scope, "type": "transport_connection_settled", "connectionId": "connection", "outcome": "connected"},
        admission, item,
        {**scope, "type": "operation_settled", "physicalAttempts": 1},
        {**SCHEMA, "type": "accounting_closed", "writeFailures": 0,
         "openAttemptIds": [], "openOperationIds": [], "openConnectionIds": []},
    ]


def write_sidecar(path: Path, records: list[dict], tail: str = "") -> None:
    path.write_text("".join(json.dumps(row) + "\n" for row in records) + tail)


def observational_metrics() -> dict:
    return {"child_sessions": 0, "observed_api_cost": {"total": 999}, "tool_calls": 3,
            "runtime_clean": True, "api_cost": {"total": 999}, "all_model_calls": 42}


class CostAccountingTests(unittest.TestCase):
    def test_happy_closed_physical_scope_and_raw_price_presence(self) -> None:
        original = observational_metrics()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "attempts.jsonl"
            item = request("gpt-5.6-sol", written=True)
            rows = sidecar(item)
            unenhanced = deepcopy(item)
            unenhanced["receipt"].update(rawUsage=[], usage={}, usageCompleteness="none")
            rows.insert(5, unenhanced)  # Later native parsed metadata enriches this same attempt ID.
            write_sidecar(path, rows)
            merged = apply_instrumented_accounting(original, path, PROFILES, invocation_finished=True)
            self.assertEqual(merged["accounting_source"], "instrumented_physical_attempts")
            self.assertTrue(merged["incurred_cost_complete"])
            self.assertEqual(merged["all_model_calls"], 1)
            self.assertEqual(len(merged["transport_connections"]), 1)
            self.assertEqual(merged["observed_physical_attempts"], 1)
            self.assertAlmostEqual(merged["api_cost"]["total"], 0.000456)
            self.assertEqual(merged["observed_api_cost"], {"total": 999})
            self.assertEqual(merged["tool_calls"], 3)
            self.assertTrue(merged["runtime_clean"])
            self.assertEqual(original, observational_metrics())
            # DeepSeek's explicit zero write tariff prices missing write quantity, not synthetic tokens.
            deep = request()
            write_sidecar(path, sidecar(deep))
            merged = apply_instrumented_accounting(original, path, PROFILES, invocation_finished=True)
            self.assertTrue(merged["incurred_cost_complete"])
            self.assertFalse(merged["usage_complete"])
            self.assertIsNone(merged["provider_usage"]["cacheWrite"])
            self.assertAlmostEqual(merged["api_cost"]["total"], 0.00003024)
            native = {**original, "accounting_source": "native_request_receipts", "accounting_incomplete": False,
                      "cost_complete": True, "physical_attempts": [deep]}
            current = apply_native_incurred_accounting(native, PROFILES, invocation_finished=True, capture_qualified=True)
            self.assertTrue(current["incurred_cost_complete"])
            self.assertEqual(current["api_cost"], merged["api_cost"])
            self.assertEqual(deep["receipt"]["usage"]["cacheWrite"], 0)  # Input was not mutated.

    def test_incomplete_failed_scope_and_synthetic_write_stay_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "attempts.jsonl"
            item = request()
            item["receipt"].update(outcome="failed", status=429, usage={}, rawUsage=[], usageCompleteness="none")
            rows = sidecar(item)
            pending = {**rows[4], "attemptId": "pending"}
            rows.insert(6, pending)
            rows[-2]["physicalAttempts"] = 2
            rows[-1].update(writeFailures=1, openAttemptIds=["pending"])
            rows[1]["purpose"] = "unknown"
            rows[1]["modelContract"] = {"api": "opaque"}
            write_sidecar(path, rows, '{"partial":')
            merged = apply_instrumented_accounting(observational_metrics(), path, PROFILES, invocation_finished=True)
            self.assertFalse(merged["incurred_cost_complete"])
            self.assertEqual(merged["invocation_capture"], "unknown")
            self.assertIsNone(merged["api_cost"]["total"])
            self.assertIsNone(merged["all_model_calls"])
            self.assertEqual(merged["observed_physical_attempts"], 2)
            self.assertEqual(merged["unsettled_attempts"], 1)
            self.assertEqual(merged["physical_attempts"][0]["receipt"]["rawUsage"], [])
            self.assertTrue({"partial_sidecar_tail", "sidecar_write_failures", "uncovered_api",
                             "unknown_or_unqualified_purpose"} <= set(merged["invocation_capture_reasons"]))
            missing = apply_instrumented_accounting(observational_metrics(), path.with_name("absent"), PROFILES)
            self.assertFalse(missing["incurred_cost_complete"])
            self.assertIsNone(missing["api_cost"]["total"])
            # Identical profiles and raw absence constrain BOTH harnesses despite normalized write=0.
            codex = request("gpt-5.6-sol")
            write_sidecar(path, sidecar(codex))
            stock = apply_instrumented_accounting(observational_metrics(), path, PROFILES, invocation_finished=True)
            native = {**observational_metrics(), "accounting_source": "native_request_receipts",
                      "accounting_incomplete": False, "cost_complete": True, "physical_attempts": [codex]}
            current = apply_native_incurred_accounting(native, PROFILES, invocation_finished=True, capture_qualified=True)
            for result in (stock, current):
                self.assertEqual(result["invocation_capture"], "complete")
                self.assertFalse(result["incurred_cost_complete"])
                self.assertIsNone(result["api_cost"]["total"])
                self.assertIsNone(result["provider_usage"]["cacheWrite"])
                interval = result["api_price_estimates"][0]["conditional_range"]
                self.assertAlmostEqual(interval["lower"], 0.000456)
                self.assertAlmostEqual(interval["upper"], 0.000516)
            unqualified = apply_native_incurred_accounting(native, PROFILES)
            self.assertEqual(unqualified["invocation_capture"], "unknown")
            self.assertIn("native_capture_scope_unqualified", unqualified["invocation_capture_reasons"])
            self.assertIn("invocation_not_finished", unqualified["invocation_capture_reasons"])


if __name__ == "__main__":
    unittest.main()
