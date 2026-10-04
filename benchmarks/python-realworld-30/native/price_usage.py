#!/usr/bin/env python3.12
"""Apply published API list rates to captured per-attempt/per-response numeric usage.

Never uses cumulative snapshots, message usage, external model defaults, or bills.
Usage: price_usage.py --usage PATH --harness base-context|codex --out NEW_PATH
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
import math
from pathlib import Path

METADATA_PATH = Path(__file__).with_name("pricing-metadata.json")


def numeric(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def amount(parts, rates, input_factor=1, output_factor=1, tier_factor=1):
    cost = Decimal(0)
    for key, quantity in parts.items():
        factor = output_factor if key == "output" else input_factor
        cost += Decimal(str(quantity)) * Decimal(str(rates[key])) * Decimal(str(factor))
    return float(cost * Decimal(str(tier_factor)) / Decimal(1_000_000))


def request_time(row, harness):
    if harness == "base-context":
        for field, value in (("timing.sentAt", (row.get("timing") or {}).get("sentAt")),
                             ("timing.admittedAt", (row.get("timing") or {}).get("admittedAt")),
                             ("admission_timestamp", row.get("admission_timestamp"))):
            if numeric(value) is not None:
                try:
                    return datetime.fromtimestamp(value / 1000, timezone.utc), field
                except (OverflowError, OSError, ValueError):
                    return None, "unavailable"
    elif isinstance(row.get("timestamp"), str):
        try:
            value = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
            if value.tzinfo is not None:
                return value.astimezone(timezone.utc), "rollout_record_timestamp_proxy"
        except ValueError:
            pass
    return None, "unavailable"


def usage_fields(row, harness):
    raw = row.get("usage") or {}
    keys = ({"input": "input", "input_total": "inputTotal", "cache_read": "cacheRead",
             "cache_write": "cacheWrite", "output": "output"} if harness == "base-context" else
            {"input_total": "input_tokens", "cache_read": "cached_input_tokens",
             "cache_write": "cache_write_input_tokens", "output": "output_tokens"})
    return {key: numeric(raw.get(source)) for key, source in keys.items()}


def price_record(row, harness, metadata):
    native_id = row.get("attempt_id" if harness == "base-context" else "response_id")
    model = row.get("model")  # Only the request/turn metadata already in this numeric source.
    canonical = metadata["model_aliases"].get(model, model)
    rates = metadata["models"].get(canonical)
    usage = usage_fields(row, harness)
    timestamp, time_basis = request_time(row, harness)
    record = {"native_id": native_id, "model": model, "pricing_model": canonical,
              "model_source": row.get("model_source", "native_request_metadata" if harness == "base-context" else "unknown"),
              "provider": row.get("provider" if harness == "base-context" else "model_provider"),
              "purpose": row.get("purpose"), "usage_used": usage,
              "cost_usd": None, "cost_bounds_usd": None, "pricing_status": "unpriced",
              "timestamp_utc": timestamp.isoformat() if timestamp else None,
              "timestamp_basis": time_basis, "assumptions": [], "missing": []}
    if not isinstance(native_id, str) or not native_id:
        record["missing"].append("native_id")
    if rates is None:
        record["missing"].append("supported_recorded_model")
    if row.get("conflicting_observations"):
        record["missing"].append("unambiguous_native_receipt")
    if record["missing"]:
        return record
    family = rates["provider_family"]
    required = ["input_total", "cache_read", "output"]
    if family == "openai":
        required += ["cache_write"] + (["input"] if harness == "base-context" else [])
    record["missing"] = [f"usage.{key}" for key in required if usage.get(key) is None]
    if record["missing"]:
        return record
    if usage["cache_read"] > usage["input_total"]:
        record["missing"].append("consistent_input_breakdown")
        return record
    if family == "openai":
        ordinary = usage.get("input") if harness == "base-context" else usage["input_total"] - usage["cache_read"] - usage["cache_write"]
        if ordinary < 0 or ordinary + usage["cache_read"] + usage["cache_write"] != usage["input_total"]:
            record["missing"].append("consistent_input_breakdown")
            return record
        parts = {"input": ordinary, "cache_read": usage["cache_read"], "cache_write": usage["cache_write"], "output": usage["output"]}
        modifiers = metadata["openai_modifiers"]
        long_context = usage["input_total"] > modifiers["long_input_above_tokens"]
        tier = row.get("service_tier")
        tier_name = tier.lower() if isinstance(tier, str) else None
        tier_factor = modifiers["tier_multipliers"].get(tier_name, 1)
        record.update(service_tier=tier, service_tier_multiplier=tier_factor, long_context=long_context)
        if tier_name not in modifiers["tier_multipliers"]:
            record["assumptions"].append("standard_list_rate_assumption_for_unknown_service_tier")
        record["cost_usd"] = amount(parts, rates, 2 if long_context else 1, 1.5 if long_context else 1, tier_factor)
        record["pricing_status"] = "priced_list_rate"
        return record
    # DeepSeek does not publish a separate cache-write tariff. Price all observed misses.
    parts = {"input": usage["input_total"] - usage["cache_read"], "cache_read": usage["cache_read"], "output": usage["output"]}
    schedule = metadata["deepseek_schedule"]
    if timestamp is None:
        unresolved = "request_timestamp_unavailable"
    elif timestamp.weekday() in schedule["peak_weekdays"] and any(start <= timestamp.hour < end for start, end in schedule["peak_hour_intervals"]):
        unresolved = "chinese_holiday_calendar_unavailable_for_possible_peak"
    else:
        unresolved = None
    record["assumptions"].append("list_rate_at_recorded_timestamp_not_invoice_or_boundary_crossing_rule")
    if unresolved:
        record["missing"].append(unresolved)
        record["cost_bounds_usd"] = {"lower": amount(parts, rates["off_peak"]), "upper": amount(parts, rates["peak"])}
        record["pricing_status"] = "bounded_time_rate"
    else:
        record["rate_window"] = "off_peak"
        record["cost_usd"] = amount(parts, rates["off_peak"])
        record["pricing_status"] = "priced_list_rate"
    return record


def price_usage(source, harness, metadata):
    key = "attempts" if harness == "base-context" else "response_receipts"
    raw_records = source.get(key)
    if not isinstance(raw_records, list):
        raise ValueError(f"numeric collector output must contain {key}[]")
    id_key = "attempt_id" if harness == "base-context" else "response_id"
    dedup, missing_ids = {}, []
    for row in raw_records:
        native_id = row.get(id_key)
        if isinstance(native_id, str) and native_id:
            dedup[native_id] = row
        else:
            missing_ids.append(row)
    records = [price_record(row, harness, metadata) for row in [*dedup.values(), *missing_ids]]
    priced = [record["cost_usd"] for record in records if record["cost_usd"] is not None]
    known_subtotal = sum(priced) if priced else None
    all_priced = bool(records) and len(priced) == len(records)
    return {"schema": "published-api-rate-cost/v1", "harness": harness,
            "basis": "observed captured-request API list-rate cost, not an invoice or full-family spend",
            "pricing_metadata": str(METADATA_PATH), "currency": "USD", "records": records,
            "captured_receipts": len(records), "priced_receipts": len(priced),
            "duplicate_receipts_removed": len(raw_records) - len(records),
            "all_captured_receipts_priced": all_priced,
            "known_subtotal_usd": known_subtotal,
            "observed_api_rate_cost_usd": known_subtotal if all_priced else None,
            "source_coverage": source.get("coverage"), "full_family_cost_complete": None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--usage", type=Path, required=True)
    parser.add_argument("--harness", choices=("base-context", "codex"), required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    source = json.loads(args.usage.read_text())
    metadata = json.loads(METADATA_PATH.read_text())
    result = price_usage(source, args.harness, metadata)
    with args.out.open("x") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"out": str(args.out), "priced_receipts": result["priced_receipts"],
                      "captured_receipts": result["captured_receipts"]}))


if __name__ == "__main__":
    main()
