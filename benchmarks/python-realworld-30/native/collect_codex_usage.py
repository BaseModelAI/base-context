#!/usr/bin/env python3
"""Offline, metadata-only collection of owned Codex rollouts and safe stderr."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


TOKENS = {
    "input_tokens", "cached_input_tokens", "cache_write_input_tokens",
    "output_tokens", "reasoning_output_tokens", "total_tokens",
}
# Rollout CodexErrorInfo uses snake_case; app-server's camelCase is a different wire format.
PROVIDER_CODES = {"rate_limit_exceeded", "flex_unavailable", "server_overloaded", "unauthorized"}
TRANSPORT_CODES = {
    "http_connection_failed", "response_stream_connection_failed",
    "response_stream_disconnected", "response_too_many_failed_attempts",
}
LOG_EVENTS = {
    "codex.conversation_starts", "codex.api_request", "codex.websocket_connect",
    "codex.websocket_request", "codex.sse_event", "codex.auth_recovery",
}
LOG_FIELDS = {
    "event.name", "event.kind", "event.timestamp", "conversation.id", "model", "slug",
    "provider_name", "reasoning_effort", "service_tier", "endpoint", "attempt",
    "duration_ms", "http.response.status_code", "error.message", "success",
    "auth.retry_after_unauthorized", "auth.recovery_mode", "auth.recovery_phase",
    "auth.connection_reused", "auth.mode", "auth.step", "auth.outcome",
    "input_token_count", "output_token_count", "cached_token_count",
    "cache_write_token_count", "reasoning_token_count", "tool_token_count", "ttft_ms",
}
DECODER = json.JSONDecoder()


def _space(text, pos):
    while pos < len(text) and text[pos].isspace():
        pos += 1
    return pos


def _skip_string(text, pos):
    pos += 1
    while pos < len(text):
        if text[pos] == "\\":
            pos += 2
        elif text[pos] == '"':
            return pos + 1
        else:
            pos += 1
    raise ValueError("unterminated JSON string")


def _skip_value(text, pos):
    """Locate a value's end without decoding discarded text/body values."""
    if text[pos] == '"':
        return _skip_string(text, pos)
    if text[pos] in "{[":
        depth = 1
        pos += 1
        while pos < len(text) and depth:
            char = text[pos]
            if char == '"':
                pos = _skip_string(text, pos)
                continue
            if char in "{[":
                depth += 1
            elif char in "}]":
                depth -= 1
            pos += 1
        if depth:
            raise ValueError("unterminated JSON container")
        return pos
    while pos < len(text) and text[pos] not in ",}] \t\r\n":
        pos += 1
    return pos


def _members(text, span=None):
    """Return value spans for one object. Do not deserialize its payload bodies."""
    pos = _space(text, span[0] if span else 0)
    if text[pos] != "{":
        return {}
    result = {}
    pos = _space(text, pos + 1)
    while text[pos] != "}":
        key, pos = DECODER.raw_decode(text, pos)
        pos = _space(text, pos)
        if text[pos] != ":":
            raise ValueError("expected JSON colon")
        start = _space(text, pos + 1)
        end = _skip_value(text, start)
        result[key] = (start, end)
        pos = _space(text, end)
        if text[pos] == "}":
            break
        if text[pos] != ",":
            raise ValueError("expected JSON comma")
        pos = _space(text, pos + 1)
    return result


def _value(text, fields, key, default=None):
    span = fields.get(key)
    return json.loads(text[span[0]:span[1]]) if span else default


def _pick(text, fields, keys):
    return {key: _value(text, fields, key) for key in keys if key in fields}


def _number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and re.fullmatch(r"-?\d+(?:\.\d+)?", value):
        return float(value) if "." in value else int(value)
    return None


def _usage(text, span):
    if span is None or text[span[0]:span[1]].strip() == "null":
        return None
    fields = _members(text, span)
    result = {key: _number(_value(text, fields, key)) for key in TOKENS if key in fields}
    return {key: value for key, value in result.items() if value is not None} or None


def _native_error(text, fields):
    # Native error messages are allowed metadata, not message/tool/reasoning bodies.
    code = _value(text, fields, "codex_error_info")
    error = {"message": _value(text, fields, "message"), "codex_error_info": code}
    provider = code in PROVIDER_CODES if isinstance(code, str) else (
        isinstance(code, dict) and bool(TRANSPORT_CODES.intersection(code)))
    return error, provider


def read_rollout(path):
    rows = {"path": str(path), "session_meta": {}, "turn_contexts": [],
            "token_count_events": [], "response_usage_records": [], "turn_events": [],
            "errors": [], "read_issues": []}
    turn_id = None
    turn_contexts = {}
    with path.open(encoding="utf-8") as stream:
        for line_number, text in enumerate(stream, 1):
            if not text.strip():
                continue
            try:
                outer = _members(text)
                kind = _value(text, outer, "type")
                if kind not in {"session_meta", "turn_context", "token_usage_record", "event_msg"}:
                    continue
                payload = _members(text, outer["payload"])
                event_kind = _value(text, payload, "type") if kind == "event_msg" else None
                if kind == "event_msg" and event_kind not in {
                    "token_count", "error", "task_started", "task_complete", "turn_aborted",
                }:
                    continue
                common = {"timestamp": _value(text, outer, "timestamp"),
                          "ordinal": _value(text, outer, "ordinal"),
                          "rollout_path": str(path), "line": line_number}
                if kind == "session_meta":
                    meta = _pick(text, payload, {
                        "id", "session_id", "parent_thread_id", "timestamp", "cli_version",
                        "model_provider", "forked_from_id", "history_mode",
                        "subagent_history_start_ordinal",
                    })
                    source_span = payload.get("source")
                    if source_span:
                        if text[source_span[0]] == '"':
                            meta["source_kind"] = _value(text, payload, "source")
                        else:
                            source = _members(text, source_span)
                            meta["source_kind"] = next(iter(source), None)
                            if "subagent" in source:
                                sub = _members(text, source["subagent"])
                                if "thread_spawn" in sub:
                                    spawn = _members(text, sub["thread_spawn"])
                                    meta.setdefault("parent_thread_id", _value(text, spawn, "parent_thread_id"))
                    rows["session_meta"] = meta
                elif kind == "turn_context":
                    row = common | _pick(text, payload, {"turn_id", "root_turn_id", "model", "effort"})
                    row["model_provider"] = rows["session_meta"].get("model_provider")
                    turn_id = row.get("turn_id", turn_id)
                    turn_contexts[turn_id] = row
                    rows["turn_contexts"].append(row)
                elif kind == "token_usage_record":
                    row = common | _pick(text, payload, {
                        "thread_id", "turn_id", "session_id", "root_turn_id", "response_id",
                    })
                    for key in ("usage", "turn_token_usage", "thread_token_usage"):
                        row[key] = _usage(text, payload.get(key))
                    context = turn_contexts.get(row.get("turn_id"), {})
                    row.update({key: context.get(key) for key in ("model", "effort", "model_provider")})
                    row["model_source"] = "turn_context" if context else "unknown"
                    row["context_timestamp"] = context.get("timestamp")
                    rows["response_usage_records"].append(row)
                elif event_kind == "token_count":
                    info_span = payload.get("info")
                    info = _members(text, info_span) if info_span else {}
                    rows["token_count_events"].append(common | {
                        "turn_id": turn_id,
                        "total_token_usage": _usage(text, info.get("total_token_usage")),
                        "last_token_usage": _usage(text, info.get("last_token_usage")),
                        "model_context_window": _number(_value(text, info, "model_context_window")),
                    })
                elif event_kind == "error":
                    error, provider = _native_error(text, payload)
                    rows["errors"].append(common | {"turn_id": turn_id, "error": error,
                                                    "provider_error": provider})
                else:
                    row = common | {"event": event_kind} | _pick(text, payload, {
                        "turn_id", "started_at", "completed_at", "duration_ms", "reason",
                    })
                    turn_id = row.get("turn_id", turn_id)
                    rows["turn_events"].append(row)
                    error_span = payload.get("error")
                    if error_span and text[error_span[0]:error_span[1]].strip() != "null":
                        error, provider = _native_error(text, _members(text, error_span))
                        rows["errors"].append(common | {"turn_id": turn_id, "error": error,
                                                        "provider_error": provider})
            except (ValueError, IndexError, KeyError, TypeError):
                rows["read_issues"].append({"line": line_number, "reason": "unreadable metadata record"})
    return rows


def read_stderr(path):
    rows, issues = [], []
    if not path.exists():
        return rows, [{"reason": "stderr file missing"}]
    with path.open(encoding="utf-8", errors="replace") as stream:
        for line_number, text in enumerate(stream, 1):
            if not text.lstrip().startswith("{"):
                continue
            try:
                outer = _members(text)
                if _value(text, outer, "target") != "codex_otel.trace_safe":
                    continue
                fields = _members(text, outer["fields"])
                event = _value(text, fields, "event.name")
                if event not in LOG_EVENTS:
                    continue
                data = _pick(text, fields, LOG_FIELDS)
                status = _number(data.get("http.response.status_code"))
                error = data.get("error.message")
                has_error = isinstance(error, str) and bool(error)
                provider = False
                if event == "codex.api_request":
                    provider = (status is not None and status >= 400) or has_error
                elif event in {"codex.websocket_connect", "codex.websocket_request"}:
                    provider = ((status is not None and status >= 400) or has_error
                                or data.get("success") in (False, "false"))
                # SSE error strings lack typed refusal/transport distinctions. Retain them,
                # but do not turn semantic refusals into provider outages by text matching.
                row = {"timestamp": _value(text, outer, "timestamp"),
                       "event_timestamp": data.get("event.timestamp"),
                       "thread_id": data.get("conversation.id"),
                       "event": event, "fields": data, "http_status": status,
                       "provider_error": provider,
                       "unclassified_error": has_error and not provider,
                       "stderr_path": str(path), "line": line_number}
                token_fields = {
                    "input_token_count": "input_tokens", "output_token_count": "output_tokens",
                    "cached_token_count": "cached_input_tokens", "cache_write_token_count": "cache_write_input_tokens",
                    "reasoning_token_count": "reasoning_output_tokens", "tool_token_count": "total_tokens",
                }
                numeric_usage = {name: _number(data[field]) for field, name in token_fields.items()
                                 if field in data and _number(data[field]) is not None}
                if numeric_usage:
                    row["numeric_usage"] = numeric_usage
                rows.append(row)
            except (ValueError, IndexError, KeyError, TypeError):
                issues.append({"line": line_number, "reason": "unreadable JSON stderr metadata"})
    return rows, issues


def physical_response_receipts(threads):
    """Prefer response usage, deduplicated by native response ID, without summing."""
    observations = []
    for thread in threads:
        for record in thread["response_usage_records"]:
            row = {key: record.get(key) for key in (
                "response_id", "thread_id", "session_id", "turn_id", "root_turn_id",
                "timestamp", "usage", "model", "effort", "model_provider", "model_source",
                "context_timestamp", "rollout_path", "line",
            )}
            row["rollout_thread_id"] = thread["thread_id"]
            row["inherited_prefix"] = record.get("inherited_prefix")
            observations.append(row)
    # Original thread records take priority over copied parent history in a child.
    observations.sort(key=lambda row: (row["thread_id"] != row["rollout_thread_id"],
                                       row["inherited_prefix"] is True,
                                       row["timestamp"] or "", row["rollout_path"], row["line"]))
    identified, unidentified = {}, []
    duplicates = 0
    for row in observations:
        response_id = row["response_id"]
        if not isinstance(response_id, str) or not response_id:
            unidentified.append(row)
            continue
        if response_id not in identified:
            identified[response_id] = row | {"occurrences": 1, "conflicting_observations": []}
            continue
        duplicates += 1
        stored = identified[response_id]
        stored["occurrences"] += 1
        comparison = ("usage", "thread_id", "turn_id", "model", "effort", "model_provider")
        conflict = any(stored[key] is not None and row[key] is not None and stored[key] != row[key]
                       for key in comparison)
        if conflict:
            stored["conflicting_observations"].append(row)
        elif stored["usage"] is None and row["usage"] is not None:
            stored["usage"] = row["usage"]
            stored["usage_source"] = {"rollout_path": row["rollout_path"], "line": row["line"]}
    receipts = list(identified.values())
    coverage = {
        "preferred_source": "deduplicated token_usage_record.usage",
        "duplicate_response_records": duplicates,
        "records_without_response_id": len(unidentified),
        "response_ids_without_usage": [row["response_id"] for row in receipts if row["usage"] is None],
        "response_ids_with_incomplete_usage": [row["response_id"] for row in receipts
            if row["usage"] is not None and not {"input_tokens", "cached_input_tokens", "output_tokens"}.issubset(row["usage"])],
        "response_ids_without_model_metadata": [row["response_id"] for row in receipts if row["model"] is None],
        "conflicting_response_ids": [row["response_id"] for row in receipts if row["conflicting_observations"]],
        "physical_usage_coverage": "partial_or_unknown",
        "model_execution_verified": False,
    }
    return receipts, unidentified, coverage


def collect(codex_home, stderr_path):
    home = Path(codex_home).resolve()
    files, excluded = [], []
    for subdir in ("sessions", "archived_sessions"):
        directory = home / subdir
        if not directory.is_dir() or directory.is_symlink():
            continue
        for path in sorted(directory.rglob("rollout-*")):
            if not path.is_file() or path.is_symlink():
                continue
            if not path.resolve().is_relative_to(home):
                continue
            if path.suffix == ".jsonl":
                files.append(path)
            elif path.name.endswith(".jsonl.zst"):
                excluded.append({"path": str(path), "reason": "compressed rollout not read"})
    threads = {}
    read_issues = []
    for path in files:
        rollout = read_rollout(path)
        meta = rollout["session_meta"]
        thread_id = meta.get("id")
        if not thread_id and rollout["response_usage_records"]:
            thread_id = rollout["response_usage_records"][-1].get("thread_id")
        key = thread_id or "unknown:" + str(path)
        thread = threads.setdefault(key, {
            "thread_id": thread_id, "session_id": None, "parent_thread_id": None,
            "role": "unknown", "rollout_paths": [], "session_meta": [],
            "turn_contexts": [], "token_count_events": [], "response_usage_records": [],
            "turn_events": [], "errors": [], "stderr_events": [],
        })
        thread["rollout_paths"].append(str(path))
        if meta:
            thread["session_meta"].append(meta)
            thread["session_id"] = meta.get("session_id", thread["session_id"])
            thread["parent_thread_id"] = meta.get("parent_thread_id", thread["parent_thread_id"])
        for name in ("turn_contexts", "token_count_events", "response_usage_records", "turn_events", "errors"):
            for row in rollout[name]:
                start = meta.get("subagent_history_start_ordinal")
                ordinal = row.get("ordinal")
                row["inherited_prefix"] = (ordinal < start if isinstance(start, int)
                                            and isinstance(ordinal, int) else None)
            thread[name].extend(rollout[name])
        read_issues.extend({"path": str(path), **issue} for issue in rollout["read_issues"])
    native_events, stderr_issues = read_stderr(Path(stderr_path))
    for event in native_events:
        thread_id = event["thread_id"]
        if thread_id not in threads:
            threads[thread_id] = {"thread_id": thread_id, "session_id": None,
                "parent_thread_id": None, "role": "unknown", "rollout_paths": [],
                "session_meta": [], "turn_contexts": [], "token_count_events": [],
                "response_usage_records": [], "turn_events": [], "errors": [], "stderr_events": []}
        threads[thread_id]["stderr_events"].append(event)
    for thread in threads.values():
        if thread["parent_thread_id"]:
            thread["role"] = "child"
        elif thread["session_id"] and thread["thread_id"] == thread["session_id"]:
            thread["role"] = "root"
        for name in ("turn_contexts", "token_count_events", "response_usage_records", "turn_events"):
            thread[name].sort(key=lambda row: (row.get("timestamp") or "", row["rollout_path"], row["line"]))
        counts = [row for row in thread["token_count_events"] if row["inherited_prefix"] is not True]
        receipts = [row for row in thread["response_usage_records"]
                    if row.get("thread_id") == thread["thread_id"] and row["inherited_prefix"] is not True]
        thread["latest_token_count_event"] = counts[-1] if counts else None
        thread["latest_response_thread_usage"] = receipts[-1].get("thread_token_usage") if receipts else None
        thread["usage_observed"] = (
            any(row.get("total_token_usage") is not None or row.get("last_token_usage") is not None for row in counts)
            or any(row.get("usage") is not None for row in receipts)
            or any(row.get("numeric_usage") for row in thread["stderr_events"])
        )
    provider_errors = [row for thread in threads.values() for row in thread["errors"] if row["provider_error"]]
    provider_errors.extend(row for row in native_events if row["provider_error"])
    unclassified_errors = [row for thread in threads.values() for row in thread["errors"]
                           if not row["provider_error"]]
    unclassified_errors.extend(row for row in native_events if row["unclassified_error"])
    response_receipts, unidentified_responses, response_coverage = physical_response_receipts(threads.values())
    response_coverage["native_completions_without_usage"] = sum(
        row["event"] == "codex.sse_event" and row["fields"].get("event.kind") == "response.completed"
        and not row.get("numeric_usage") for row in native_events
    )
    return {
        "format": "codex-native-usage-v1", "codex_home": str(home),
        "threads": list(threads.values()),
        "response_receipts": response_receipts,
        "response_records_without_id": unidentified_responses,
        "request_receipts": [row for row in native_events if row["event"] == "codex.api_request"],
        "transport_events": [row for row in native_events if row["event"] in {
            "codex.websocket_connect", "codex.websocket_request", "codex.sse_event", "codex.auth_recovery"}],
        "provider_error_observed": bool(provider_errors), "provider_errors": provider_errors,
        "unclassified_errors": unclassified_errors,
        "coverage": {"root_totals_include_children": "unknown", "whole_run_usage": None,
                     "physical_responses": response_coverage,
                     "rollout_files_read": len(files), "unread_rollouts": excluded,
                     "missing_usage_is_zero": False,
                     "timing_filter": "none; includes native startup/pre-prompt events"},
        "read_issues": read_issues + [{"path": str(stderr_path), **issue} for issue in stderr_issues],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", required=True, type=Path)
    parser.add_argument("--stderr", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    result = collect(args.codex_home, args.stderr)
    args.out.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
