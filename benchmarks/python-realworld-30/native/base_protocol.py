"""RPC 13 client requiring the native family-completion capability."""
import asyncio
import contextlib
import json
import time
from pathlib import Path


PROVIDER_KINDS = {"transport", "overloaded", "rate_limit", "server_error", "auth",
                  "invalid_request", "malformed_response"}


class BaseContextProtocol:
    def __init__(self, process, raw_event_path):
        self.process = process
        self.raw_event_path = Path(raw_event_path)
        self.pending = {}
        self.events = asyncio.Queue()
        self.sequence = 0
        self.event_sequence = 0
        self.consumed_event_sequence = 0
        self.state = None
        self.provider_errors = []
        self.message_usage = []
        self.reader = asyncio.create_task(self._read())

    def _observe(self, event):
        if event.get("type") != "message_end":
            return
        message = event.get("message") or {}
        if message.get("role") != "assistant":
            return
        if isinstance(message.get("usage"), dict):
            self.message_usage.append({key: message.get(key) for key in
                                       ("id", "provider", "model", "api", "usage", "timestamp", "stopReason")})
        for diagnostic in message.get("diagnostics") or []:
            if diagnostic.get("type") != "provider_stream_failure":
                continue
            details = diagnostic.get("details") or {}
            status = details.get("status")
            lifecycle_failure = any(item.get("type") == "agent_lifecycle_failure" for item in message.get("diagnostics") or [])
            native_timeout = (not lifecycle_failure and message.get("stopReason") == "error"
                              and details.get("kind") == "unknown"
                              and (diagnostic.get("error") or {}).get("name") == "Error"
                              and (diagnostic.get("error") or {}).get("message") == "Request timed out.")
            if native_timeout or details.get("kind") in PROVIDER_KINDS or (isinstance(status, int) and status >= 400):
                self.provider_errors.append({"diagnostic": diagnostic, "observed_monotonic": time.monotonic()})

    async def _read(self):
        buffer = b""
        error = RuntimeError("Base Context RPC stdout closed")
        try:
            with self.raw_event_path.open("wb") as raw:
                while chunk := await self.process.stdout.read(65536):
                    raw.write(chunk)
                    raw.flush()
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not line.strip():
                            continue
                        event = json.loads(line)
                        self._observe(event)
                        if event.get("type") == "response" and event.get("id") in self.pending:
                            self.pending.pop(event["id"]).set_result((event, self.event_sequence))
                        else:
                            self.event_sequence += 1
                            await self.events.put((self.event_sequence, event))
                if buffer.strip():
                    raise RuntimeError("Partial Base Context RPC frame at EOF")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            error = exc
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)
            self.pending.clear()
            await self.events.put(error)

    async def request(self, command, before_send=None, with_event_watermark=False):
        self.sequence += 1
        identifier = f"benchmark-{self.sequence}"
        frame = (json.dumps({"id": identifier, **command}, ensure_ascii=False) + "\n").encode()
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        if before_send is not None:
            before_send()
        self.process.stdin.write(frame)
        await self.process.stdin.drain()
        response, watermark = await future
        if not response.get("success"):
            raise RuntimeError(response.get("error") or "Base Context RPC rejected command")
        data = response.get("data") or {}
        return (data, watermark) if with_event_watermark else data

    async def ready(self, params=None, resume=None):
        state = await self.request({"type": "get_state"})
        if (state.get("protocolVersion", 0) < 13 or state.get("schemaRevision", 0) < 51
                or "rlm_quiescence_barrier" not in (state.get("capabilities") or [])):
            raise RuntimeError("Base Context RPC requires schema 51 and rlm_quiescence_barrier")
        if resume is not None and any(state.get(key) != resume[key] for key in ("sessionId", "sessionFile")):
            raise RuntimeError("Base Context reopened a different saved session")
        self.state = state
        return state

    async def compact(self):
        """Require the manual compaction event as well as the RPC response."""
        after_event = self.event_sequence
        response, through_event = await self.request({"type": "compact"}, with_event_watermark=True)
        completed = None
        while self.consumed_event_sequence < through_event:
            item = await self.events.get()
            if isinstance(item, Exception):
                raise item
            sequence, event = item
            self.consumed_event_sequence = sequence
            if sequence > after_event and event.get("type") == "compaction_end" and event.get("reason") == "manual":
                completed = event
        if not completed or completed.get("aborted") or not completed.get("result"):
            raise RuntimeError("Base Context manual compaction did not complete: " + str(completed))
        return {"status": "completed", "event": completed, "response": response}

    async def resume_identity(self):
        state = await self.request({"type": "get_state"})
        return {key: state[key] for key in ("sessionId", "sessionFile")}

    async def prompt(self, text, effort=None, before_send=None):
        """Admit this prompt, await native family settlement, then read its outcome."""
        if self.state is None:
            await self.ready()
        after_event = self.event_sequence
        await self.request({"type": "prompt", "message": text,
                            "streamingBehavior": "followUp"}, before_send)
        _, through_event = await self.request({"type": "wait_for_completion"},
                                               with_event_watermark=True)
        consumed = False
        terminal = None
        completion_error = None
        # The barrier response follows all settled family events. Do not consume
        # events beyond its watermark, even if the reader already received them.
        while self.consumed_event_sequence < through_event:
            item = await self.events.get()
            if isinstance(item, Exception):
                raise item
            sequence, event = item
            self.consumed_event_sequence = sequence
            if sequence <= after_event:
                continue
            kind = event.get("type")
            if (kind == "extension_error" and event.get("extensionPath") == "<session-input>"
                    and event.get("event") == "prompt_completion"):
                completion_error = event.get("error") or "Native prompt completion failed"
            if kind == "message_start":
                message = event.get("message") or {}
                content = message.get("content", [])
                message_text = content if isinstance(content, str) else "".join(
                    block.get("text", "") for block in content if block.get("type") == "text")
                if message.get("role") == "user" and message_text == text:
                    consumed = True
                    terminal = None
            if kind in {"agent_start", "auto_retry_start", "auto_compaction_start"}:
                terminal = None
            # A native refusal may precede commitment of the submitted user input.
            if kind == "agent_end" and (consumed or event.get("refusal")):
                refusal = event.get("refusal")
                last = next((message for message in reversed(event.get("messages") or [])
                             if message.get("role") == "assistant"), {})
                reason = last.get("stopReason")
                terminal = {"status": "completed" if consumed and not refusal and reason == "stop" else "failed",
                            "refusal": refusal, "stop_reason": reason,
                            "error": last.get("errorMessage") or (
                                "Assistant response was truncated (length)" if reason == "length" else
                                "Native completion ended with a nonterminal assistant response" if reason not in
                                {"stop", "error", "aborted"} and not refusal else None)}
        result = terminal or {"status": "failed", "error": "Native completion lacked a correlated prompt outcome"}
        if completion_error:
            result = {**result, "status": "failed", "error": completion_error}
        return {**result, "provider_errors": list(self.provider_errors),
                "message_usage": list(self.message_usage), "terminal_monotonic": time.monotonic(),
                "completion_scope": "native_family_quiescence", "family_quiescence": "confirmed"}

    async def close(self):
        self.reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.reader
