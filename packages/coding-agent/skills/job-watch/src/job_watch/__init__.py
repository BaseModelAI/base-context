"""Monitor authorized jobs without model polling. Launch with bash(), not this skill."""
from __future__ import annotations
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
    deadline: str | None = None, probe_timeout: float = 30,
) -> dict[str, Any]:
    """Register once. Probe commands must be authorized, noninteractive, and read-only.

    A probe prints JSON: observed_at, job_id, state, progress, attention, evidence.
    fields selects top-level progress keys; timestamps never trigger progress changes.
    completion_source='probe' is required for detached remote jobs, including SSH launchers.
    """
    if _runtime is None:
        raise RuntimeError("job-watch requires a runtime with job_watch_probe_v1; no watch was registered")
    if completion_source not in {"handle", "probe"}:
        raise ValueError("completion_source must be handle or probe")
    if job is None and (completion_source == "handle" or not job_id):
        raise ValueError("handle completion requires a BashHandle; probe-only watches require job_id")
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


async def park(ids: list[str]) -> dict[str, Any]:
    """Declare no further owned continuation until a selected event. Returns immediately.

    User messages and unrelated queued work still run. This does not pause the goal.
    """
    return await host_request("job_watch.park", {"ids": ids})


async def unregister(id: str) -> dict[str, Any]:
    """Stop watching, not the job. Repeated calls are harmless."""
    result = await host_request("job_watch.unregister", {"id": id})
    if _runtime is not None:
        _runtime.unbind(id)
    return result
