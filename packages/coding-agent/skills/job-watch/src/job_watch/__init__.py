"""Monitor authorized jobs without model polling. Launch with bash(), not this skill."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
import json
import math
from typing import Any, Literal
from rlm import host_request
from rlm.bash import BashHandle
try:
    from rlm import job_watch as _runtime
except ImportError:
    _runtime = None


async def watch(
    job: BashHandle | None = None, *, job_id: str | None = None,
    completion_source: Literal["handle", "probe"], probe_command: str | None = None,
    interval: str = "5m", notify: Literal["terminal", "changes"] = "terminal",
    fields: list[str] | None = None, report_every: str | None = None,
    deadline: str | None = None, wait_budget: float | None = None, probe_timeout: float = 30,
) -> dict[str, Any]:
    """Register once. Probe commands must be authorized, noninteractive, and read-only.

    A probe prints JSON: observed_at, job_id, state, progress, attention, evidence.
    fields selects top-level progress keys; timestamps never trigger progress changes.
    completion_source='probe' is required for detached remote jobs, including SSH launchers.
    wait_budget is total seconds until an owner wake-up, not a probe timeout or cancellation.
    Probe watches default to 15 minutes unless deadline or wait_budget is supplied.
    """
    if _runtime is None:
        raise RuntimeError("job-watch requires a runtime with job_watch_probe_v1; no watch was registered")
    if completion_source not in {"handle", "probe"}:
        raise ValueError("completion_source must be handle or probe")
    if job is None and (completion_source == "handle" or not job_id):
        raise ValueError("handle completion requires a BashHandle; probe-only watches require job_id")
    if deadline is not None and wait_budget is not None:
        raise ValueError("specify deadline or wait_budget, not both")
    if deadline is None:
        budget = wait_budget if wait_budget is not None else (900 if completion_source == "probe" else None)
        if budget is not None:
            if isinstance(budget, bool) or not isinstance(budget, (int, float)) or budget <= 0:
                raise ValueError("wait_budget must be positive finite seconds")
            try:
                if not math.isfinite(budget):
                    raise ValueError("wait_budget must be positive finite seconds")
                deadline = (datetime.now(timezone.utc) + timedelta(seconds=budget)).isoformat()
            except OverflowError:
                raise ValueError("wait_budget exceeds the supported ISO deadline range (year 9999)") from None
    resource = _runtime.identity(job) if job is not None else f"probe:{job_id}"
    result = await host_request("job_watch.watch", {
        "job_id": job_id or resource, "resource_id": resource,
        "completion_source": completion_source, "probe_command": probe_command,
        "interval": interval, "notify": notify, "fields": fields or [],
        "report_every": report_every, "deadline": deadline, "timeout_ms": probe_timeout * 1000,
    })
    if job is not None and completion_source == "handle":
        _runtime.bind(job, result["id"], result["generation"], job_id or resource)
    return result


async def status(id: str | None = None) -> dict[str, Any]:
    """Return cached state only; never launch a probe or a model turn."""
    return await host_request("job_watch.status", {} if id is None else {"id": id})


async def consume(id: str | None = None) -> dict[str, Any]:
    """Transfer retained notification bodies and IDs to this Python caller.

    Retain or inspect the returned evidence. This is not a model-delivery ACK.
    Selected/in-flight notifications stay pending and appear in deferred_event_ids.
    Unregistered watches remain consumable while they retain evidence.
    """
    result = await host_request("job_watch.consume", {} if id is None else {"id": id})
    terminal = [event for event in result["events"] if event.get("state") in {"succeeded", "failed", "cancelled"}]
    if terminal:
        receipt = {
            "terminal_events": [
                {key: str(event[key])[:64] for key in ("event_id", "watch_id", "state")}
                for event in terminal[:8]
            ],
            "additional_terminal_events": max(0, len(terminal) - 8),
            "action": "Inspect the full returned events before acting or reporting the outcome.",
        }
        print("job_watch.consume: " + json.dumps(receipt, ensure_ascii=True, separators=(",", ":")))
    return result


async def park(ids: list[str]) -> dict[str, Any]:
    """Declare no further owned continuation until a selected event. Returns immediately.

    User messages and unrelated queued work still run. This does not pause the goal.
    """
    result = await host_request("job_watch.park", {"ids": ids})
    if result.get("parked") is False and result.get("reason") == "event_available":
        print("job_watch.park: no new continuation hold for the requested watches. An earlier hold may remain. "
              "Inspect already-consumed events, or use consume/status for available evidence; "
              "then act or report the actual outcome. Queued/in-flight events can still arrive. "
              "Do not assume a later automatic turn.")
    elif result.get("parked") is False and result.get("reason") == "monitoring_unavailable":
        print("job_watch.park: monitoring unavailable; no new continuation hold. An earlier hold may remain. "
              "Inspect status and retained partial evidence, then report the unresolved outcome. "
              "Do not relaunch the job or assume completion.")
    return result


async def unregister(id: str) -> dict[str, Any]:
    """Stop watching, not the job. Repeated calls are harmless."""
    result = await host_request("job_watch.unregister", {"id": id})
    if _runtime is not None:
        _runtime.unbind(id)
    return result
