"""Contained job-watch probes and completion callbacks. No notebook evaluation."""
from __future__ import annotations

import asyncio
import json
import math
import uuid
from decimal import Decimal
import weakref
from datetime import datetime, timezone
from typing import Any, Callable

from .bash import BashHandle, BashResult, bash

_identities: weakref.WeakKeyDictionary[BashHandle, str] = weakref.WeakKeyDictionary()
_handles: weakref.WeakValueDictionary[str, BashHandle] = weakref.WeakValueDictionary()
_results: weakref.WeakKeyDictionary[BashHandle, BashResult] = weakref.WeakKeyDictionary()
_callbacks: dict[tuple[str, str], Callable[[], None]] = {}
_probes: dict[str, asyncio.Task[None]] = {}


def identity(handle: BashHandle) -> str:
    if not isinstance(handle, BashHandle):
        raise TypeError("job must be a live BashHandle")
    resource = _identities.setdefault(handle, uuid.uuid4().hex)
    _handles[resource] = handle
    return resource


def _observed(job_id: str, result: BashResult | None) -> dict[str, Any]:
    return {
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "job_id": job_id,
        "state": "running" if result is None else "succeeded" if result.exit_code == 0 else "failed",
        "progress": {} if result is None else {"exit_code": result.exit_code, "duration_seconds": result.duration},
        "attention": [], "evidence": [],
    }


def bind(handle: BashHandle, watch_id: str, generation: str, job_id: str) -> None:
    from . import host_request
    loop = asyncio.get_running_loop()
    key = (watch_id, generation)
    if key in _callbacks:
        return

    async def deliver(observation: dict[str, Any]) -> None:
        try:
            await host_request("job_watch.observation", {
                "id": watch_id, "generation": generation,
                "result": {"source": "handle", "observation": observation},
            })
        except RuntimeError:
            pass  # Host teardown owns recovery; never restart a monitored process.

    def completed(result: BashResult) -> None:
        _results[handle] = result
        observation = _observed(job_id, result)
        try:
            loop.call_soon_threadsafe(lambda: asyncio.create_task(deliver(observation)))
        except RuntimeError:
            pass

    _callbacks[key] = handle.add_done_callback(completed)


def unbind(watch_id: str) -> None:
    for key in list(_callbacks):
        if key[0] == watch_id:
            _callbacks.pop(key)()


_SAFE_INTEGER = 2**53 - 1
_NUMERIC_ERROR = "probe numeric precision is unavailable; encode exact identifiers and precision-sensitive values as strings"


def _exact_integer(token: str) -> int:
    try:
        value = int(token)
    except ValueError:
        raise ValueError(_NUMERIC_ERROR) from None
    if abs(value) > _SAFE_INTEGER or token == "-0":
        raise ValueError(_NUMERIC_ERROR)
    return value


def _exact_decimal(token: str) -> float:
    value = float(token)
    if (not math.isfinite(value) or abs(value) > _SAFE_INTEGER
            or (value == 0 and token.startswith("-")) or Decimal(str(value)) != Decimal(token)):
        raise ValueError(_NUMERIC_ERROR)
    return value


async def _probe(request: dict[str, Any]) -> None:
    from . import host_request
    request_id = request["id"]
    try:
        command = request.get("command")
        handle = _handles.get(request["resourceId"])
        if request.get("completionSource") == "handle" and handle is None:
            result = {"source": "handle", "error": "handle unavailable after kernel restart"}
        elif command is None:
            result = ({"source": "handle", "observation": _observed(request["jobId"], _results.get(handle))}
                      if handle is not None else {"source": "handle", "error": "handle unavailable after kernel restart"})
        else:
            # The first await owns this new probe only. Cancellation never reaches the monitored job.
            finished = await asyncio.wait_for(bash(command), timeout=request["timeoutMs"] / 1000)
            output = finished.output
            result = {"source": "probe", "output": output, "capture_complete": False}
            if finished.exit_code != 0:
                result["error"] = f"probe exited {finished.exit_code}"
            elif len(output.encode("utf-8")) > 16384:
                result["error"] = "probe JSON exceeds 16 KiB; use a project summary producer"
            else:
                try:
                    result["observation"] = json.loads(output, parse_int=_exact_integer,
                                                       parse_float=_exact_decimal, parse_constant=_exact_decimal)
                except (ValueError, TypeError) as error:
                    result["error"] = (str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
                                       else "probe JSON unavailable or incomplete")
        await host_request("job_watch.probe_result", {"request_id": request_id, "result": result})
    except asyncio.CancelledError:
        raise
    except Exception as error:
        try:
            await host_request("job_watch.probe_result", {
                "request_id": request_id, "result": {"source": "probe", "error": f"{type(error).__name__}: {error}"[:256]},
            })
        except RuntimeError:
            pass
    finally:
        _probes.pop(request_id, None)


def dispatch(request: dict[str, Any]) -> None:
    """Called only by the REPL protocol dispatcher, not by notebook eval."""
    request_id = request.get("id")
    if not isinstance(request_id, str):
        raise ValueError("job_watch_probe requires an id")
    if request.get("cancel"):
        task = _probes.get(request_id)
        if task:
            task.cancel()
        return
    if request_id in _probes:
        return
    if not isinstance(request.get("jobId"), str) or not isinstance(request.get("resourceId"), str):
        raise ValueError("job_watch_probe requires resource and job identity")
    command = request.get("command")
    if command is not None and (not isinstance(command, str) or not command or len(command.encode()) > 8192):
        raise ValueError("invalid probe command")
    timeout = request.get("timeoutMs")
    if not isinstance(timeout, (int, float)) or not 1 <= timeout <= 300000:
        raise ValueError("invalid probe timeout")
    _probes[request_id] = asyncio.create_task(_probe(request))
