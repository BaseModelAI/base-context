"""Small client for the installed Codex app-server stdio protocol.

The caller owns process launch, stderr, deadlines, and process-group cleanup.
This module never retries a request or starts an extra task turn.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Callable


# Native provider/response error variants. Unknown native errors are retained in
# `errors`, but tool output and untyped message text are never classified here.
_PROVIDER_CODES = {
    "rateLimitExceeded", "flexUnavailable", "serverOverloaded", "unauthorized",
}
_PROVIDER_TRANSPORT_CODES = {
    "httpConnectionFailed", "responseStreamConnectionFailed",
    "responseStreamDisconnected", "responseTooManyFailedAttempts",
}


def _provider_error(error: dict[str, Any]) -> bool:
    info = error.get("codexErrorInfo")
    if isinstance(info, str):
        return info in _PROVIDER_CODES
    return isinstance(info, dict) and bool(_PROVIDER_TRANSPORT_CODES.intersection(info))


class CodexRequestError(RuntimeError):
    """A native JSON-RPC error response, retained without reclassifying its text."""

    def __init__(self, response: dict[str, Any]):
        self.response = response
        super().__init__(f"Codex request failed: {response.get('error')}")


class CodexProtocol:
    def __init__(self, process: asyncio.subprocess.Process, raw_event_path: str | Path):
        self.process = process
        self.raw_event_path = Path(raw_event_path)
        self.provider_errors: list[dict[str, Any]] = []
        self.errors: list[dict[str, Any]] = []
        self.usage_events: list[dict[str, Any]] = []
        self.model_events: list[dict[str, Any]] = []
        self.thread_metadata: dict[str, Any] | None = None
        self.thread_id: str | None = None
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._reader_error: BaseException | None = None
        self._turn_waiter: asyncio.Future | None = None
        self._active_turn_id: str | None = None
        self._completed_turns: dict[tuple[str, str], dict[str, Any]] = {}
        self._compaction_waiter: asyncio.Future | None = None
        self._compaction_event: dict[str, Any] | None = None
        self._compaction_turn_id: str | None = None
        self._activity = asyncio.Event()
        self._raw = self.raw_event_path.open("wb")
        self._reader_task = asyncio.create_task(self._read_loop())

    async def ready(self, params: dict[str, Any], resume: dict[str, str] | None = None) -> dict[str, Any]:
        """Start or reopen the native saved thread without injecting task history."""
        if self.thread_metadata is not None:
            raise RuntimeError("CodexProtocol.ready may only be called once")
        if any(params.get(key) is not None for key in ("baseInstructions", "developerInstructions")):
            raise ValueError("Custom system/developer instructions are not allowed")
        await self._request("initialize", {
            "clientInfo": {"name": "published-codex160-benchmark", "version": "1"},
            "capabilities": {"experimentalApi": True},
        })
        await self._write({"method": "initialized", "params": {}})
        if resume is None:
            result = await self._request("thread/start", params)
        else:
            resume_params = {key: value for key, value in params.items() if key != "ephemeral"}
            if any(key in resume_params for key in ("history", "path", "threadId")):
                raise ValueError("Resume must use only the saved native thread ID")
            result = await self._request("thread/resume", {**resume_params, "threadId": resume["threadId"]})
            if result["thread"]["id"] != resume["threadId"]:
                raise RuntimeError("Codex reopened a different saved thread")
        self.thread_metadata = result
        status = result["thread"].get("status", {}).get("type")
        if status != "idle":
            raise RuntimeError(f"Codex thread is not ready: {status!r}")
        self.thread_id = result["thread"]["id"]
        return result

    async def resume_identity(self) -> dict[str, str]:
        if self.thread_id is None:
            raise RuntimeError("Call ready before resume_identity")
        return {"threadId": self.thread_id}

    async def compact(self) -> dict[str, Any]:
        """Await both the compaction item and its matching terminal turn."""
        if self.thread_id is None or self._turn_waiter is not None or self._compaction_waiter is not None:
            raise RuntimeError("Compaction requires an idle initialized thread")
        waiter = self._compaction_waiter = asyncio.get_running_loop().create_future()
        self._compaction_event = None
        self._compaction_turn_id = None
        try:
            await self._request("thread/compact/start", {"threadId": self.thread_id})
            completed = await waiter
            return {"status": "completed", **completed}
        finally:
            self._compaction_waiter = None
            self._compaction_event = None
            self._compaction_turn_id = None
            if not waiter.done():
                waiter.cancel()
            elif not waiter.cancelled():
                waiter.exception()

    def _finish_compaction(self) -> None:
        if self._compaction_turn_id is None or self._compaction_waiter is None or self._compaction_waiter.done():
            return
        terminal = self._completed_turns.get((self.thread_id, self._compaction_turn_id))
        if terminal is None:
            return
        turn = terminal["params"]["turn"]
        if turn["status"] != "completed" or turn.get("error"):
            self._compaction_waiter.set_exception(RuntimeError("Codex compaction turn failed: " + str(turn)))
        elif self._compaction_event is not None:
            self._compaction_waiter.set_result({"event": self._compaction_event, "turn_completed": terminal})

    async def wait_for_family_idle(self) -> dict[str, Any]:
        """Observe native root/descendant status; this is not an atomic admission barrier."""
        if self.thread_id is None:
            raise RuntimeError("Call ready before waiting for native idle")
        while True:
            self._raise_reader_error()
            self._activity.clear()
            descendants = set()
            cursor = None
            while True:
                page = await self._request("thread/list", {
                    "ancestorThreadId": self.thread_id, "cursor": cursor,
                    "sourceKinds": ["subAgent", "subAgentReview", "subAgentCompact",
                                    "subAgentThreadSpawn", "subAgentOther"],
                })
                descendants.update(thread["id"] for thread in page["data"])
                cursor = page.get("nextCursor")
                if cursor is None:
                    break
            states = {}
            # Read the root last so a child-triggered parent turn is not mistaken for idle.
            for thread_id in [*sorted(descendants), self.thread_id]:
                result = await self._request("thread/read", {"threadId": thread_id, "includeTurns": False})
                states[thread_id] = result["thread"]["status"]["type"]
            if "systemError" in states.values():
                raise RuntimeError("Codex native thread entered systemError: " + str(states))
            settled = states[self.thread_id] == "idle" and all(
                state in {"idle", "notLoaded"} for state in states.values())
            if settled and not self._activity.is_set():
                return {"completion_scope": "observed_native_family_idle", "thread_states": states}
            if not settled:
                try:
                    await asyncio.wait_for(self._activity.wait(), 0.5)
                except TimeoutError:
                    pass  # Descendant notifications may not be subscribed; re-read native status.

    async def prompt(
        self, text: str, effort: str,
        before_send: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        """Submit one native turn and await its completion; no internal retry."""
        if self.thread_metadata is None or self.thread_id is None:
            raise RuntimeError("Call ready before prompt")
        if self._turn_waiter is not None:
            raise RuntimeError("Only one prompt may be active")
        self._raise_reader_error()
        self._turn_waiter = asyncio.get_running_loop().create_future()
        self._active_turn_id = None
        usage_start = len(self.usage_events)
        try:
            accepted = await self._request("turn/start", {
                "threadId": self.thread_id,
                "input": [{"type": "text", "text": text}],
                "effort": effort,
            }, before_send=before_send)
            self._active_turn_id = accepted["turn"]["id"]
            key = (self.thread_id, self._active_turn_id)
            completed = self._completed_turns.pop(key, None)
            terminal = completed if completed is not None else await self._turn_waiter
            self._completed_turns.pop(key, None)
            turn = terminal["params"]["turn"]
            turn_usage = [event for event in self.usage_events[usage_start:]
                          if event["params"].get("threadId") == self.thread_id
                          and event["params"].get("turnId") == turn["id"]]
            return {
                "status": turn["status"],
                "error": turn.get("error"),
                "threadId": self.thread_id,
                "turnId": turn["id"],
                "turn": turn,
                "providerErrors": list(self.provider_errors),
                "errors": list(self.errors),
                "usageEvents": turn_usage,
                "usage": turn_usage[-1]["params"]["tokenUsage"] if turn_usage else None,
                "modelEvents": list(self.model_events),
            }
        finally:
            waiter, self._turn_waiter = self._turn_waiter, None
            self._active_turn_id = None
            if waiter is not None:
                if not waiter.done():
                    waiter.cancel()
                elif not waiter.cancelled():
                    # A request failure may prevent awaiting the completion future.
                    waiter.exception()

    async def close(self) -> None:
        """Stop only this reader. The caller owns stdin/process/group cleanup."""
        self._reader_task.cancel()
        try:
            await self._reader_task
        except asyncio.CancelledError:
            pass
        finally:
            self._fail_pending(RuntimeError("Codex protocol reader closed"))
            self._raw.close()

    def _raise_reader_error(self) -> None:
        if self._reader_error is not None:
            raise self._reader_error

    async def _write(
        self, message: dict[str, Any],
        before_send: Callable[[], None] | None = None,
    ) -> None:
        self._raise_reader_error()
        payload = (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        if before_send is not None:
            before_send()
        self.process.stdin.write(payload)
        await self.process.stdin.drain()

    async def _request(
        self, method: str, params: dict[str, Any],
        before_send: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        self._raise_reader_error()
        request_id = self._next_id
        self._next_id += 1
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._write({"id": request_id, "method": method, "params": params}, before_send)
            return await future
        finally:
            self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()

    def _record_error(self, event: dict[str, Any], error: dict[str, Any]) -> None:
        self.errors.append(event)
        if _provider_error(error):
            self.provider_errors.append(event)

    def _receive(self, message: dict[str, Any]) -> None:
        if "id" in message and "method" not in message:
            future = self._pending.get(message["id"])
            if future is not None and not future.done():
                if "error" in message:
                    future.set_exception(CodexRequestError(message))
                else:
                    future.set_result(message["result"])
            return
        if "id" in message:
            # This client does not invent approval/auth/tool responses.
            raise RuntimeError(f"Unhandled Codex server request: {message.get('method')}")
        method = message.get("method")
        params = message.get("params", {})
        if method in {"thread/started", "thread/status/changed", "turn/started", "turn/completed"}:
            self._activity.set()
        if method == "error":
            self._record_error(message, params["error"])
            if (params.get("threadId") == self.thread_id and self._compaction_waiter is not None
                    and not self._compaction_waiter.done() and not params.get("willRetry", False)):
                self._compaction_waiter.set_exception(RuntimeError("Codex compaction failed: " + str(params["error"])))
        elif (method == "turn/started" and params.get("threadId") == self.thread_id
              and self._compaction_waiter is not None and self._compaction_turn_id is None):
            self._compaction_turn_id = params["turn"]["id"]
        elif (method in {"item/started", "item/completed"} and params.get("threadId") == self.thread_id
              and (params.get("item") or {}).get("type") == "contextCompaction"):
            if self._compaction_waiter is not None and not self._compaction_waiter.done():
                self._compaction_turn_id = params["turnId"]
                if method == "item/completed":
                    self._compaction_event = message
                self._finish_compaction()
        elif method == "thread/tokenUsage/updated":
            self.usage_events.append(message)
        elif method in {"model/rerouted", "model/verification", "thread/started"}:
            self.model_events.append(message)
        elif method == "turn/completed":
            turn = params["turn"]
            if turn.get("error"):
                self._record_error(message, turn["error"])
            key = (params["threadId"], turn["id"])
            self._completed_turns[key] = message
            self._finish_compaction()
            if (self._turn_waiter is not None and not self._turn_waiter.done()
                    and key == (self.thread_id, self._active_turn_id)):
                self._turn_waiter.set_result(message)

    def _fail_pending(self, error: BaseException) -> None:
        if self._reader_error is None:
            self._reader_error = error
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        if self._turn_waiter is not None and not self._turn_waiter.done():
            self._turn_waiter.set_exception(error)
        if self._compaction_waiter is not None and not self._compaction_waiter.done():
            self._compaction_waiter.set_exception(error)

    async def _read_loop(self) -> None:
        buffer = bytearray()
        try:
            while chunk := await self.process.stdout.read(65536):
                self._raw.write(chunk)
                self._raw.flush()
                buffer.extend(chunk)
                while (end := buffer.find(b"\n")) >= 0:
                    line = bytes(buffer[:end])
                    del buffer[:end + 1]
                    if line.strip():
                        self._receive(json.loads(line))
            if buffer.strip():
                self._receive(json.loads(buffer))
            self._fail_pending(EOFError("Codex app-server stdout closed"))
        except asyncio.CancelledError:
            self._fail_pending(RuntimeError("Codex protocol reader closed"))
            raise
        except Exception as error:
            self._fail_pending(error)
