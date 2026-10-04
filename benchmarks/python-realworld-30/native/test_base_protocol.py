"""Offline RPC framing tests; no process, provider, or benchmark is launched."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from base_protocol import BaseContextProtocol


STATE = {"protocolVersion": 13, "schemaRevision": 51,
         "capabilities": ["rlm_quiescence_barrier"]}


def user(text):
    return {"type": "message_start", "message": {
        "role": "user", "content": [{"type": "text", "text": text}]}}


def end(reason):
    return {"type": "agent_end", "messages": [{"role": "assistant", "stopReason": reason}]}


class FakeRPC:
    def __init__(self):
        self.stdout = asyncio.StreamReader()
        self.stdin = self
        self.requests = asyncio.Queue()
        self.closed = False

    def write(self, frame):
        self.requests.put_nowait(json.loads(frame))

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    def emit(self, *events):
        self.stdout.feed_data("".join(json.dumps(event) + "\n" for event in events).encode())

    async def request(self, kind):
        request = await asyncio.wait_for(self.requests.get(), 1)
        if request["type"] != kind:
            raise AssertionError(f"Expected {kind}, got {request}")
        return request

    def reply(self, request, data=None):
        self.emit({"id": request["id"], "type": "response", "command": request["type"],
                   "success": True, "data": data or {}})


class BaseProtocolTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.rpc = FakeRPC()
        self.client = BaseContextProtocol(self.rpc, Path(self.directory.name) / "events.jsonl")
        self.prompts = []

    async def asyncTearDown(self):
        for task in self.prompts:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.prompts, return_exceptions=True)
        await self.client.close()
        self.directory.cleanup()

    def prompt(self, text):
        task = asyncio.create_task(self.client.prompt(text))
        self.prompts.append(task)
        return task

    async def test_capability_negotiation_and_native_completion(self):
        for old_state in ({"protocolVersion": 13, "schemaRevision": 50},
                          {**STATE, "capabilities": []}, {**STATE, "schemaRevision": 50}):
            with self.subTest(old_state=old_state):
                task = self.prompt("must not be admitted")
                self.rpc.reply(await self.rpc.request("get_state"), old_state)
                with self.assertRaisesRegex(RuntimeError, "rlm_quiescence_barrier"):
                    await asyncio.wait_for(task, 1)
                self.assertTrue(self.rpc.requests.empty())

        task = self.prompt("initial")
        self.rpc.reply(await self.rpc.request("get_state"), STATE)
        request = await self.rpc.request("prompt")
        self.rpc.reply(request)
        self.rpc.emit({"type": "agent_start"}, user("initial"), end("stop"))
        barrier = await self.rpc.request("wait_for_completion")
        self.assertFalse(task.done())
        self.assertFalse(self.rpc.closed)
        self.rpc.reply(barrier)
        # A later, unrelated event in the same read must not change this outcome.
        self.rpc.emit(end("error"))
        result = await asyncio.wait_for(task, 1)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["completion_scope"], "native_family_quiescence")
        self.assertEqual(result["family_quiescence"], "confirmed")
        self.assertFalse(self.rpc.closed)

    async def test_unrelated_end_steering_followup_and_truncation(self):
        # Read a stale identical prompt before admission of the new request.
        self.rpc.emit(user("ordinance"), end("stop"))
        ready = asyncio.create_task(self.client.ready())
        self.rpc.reply(await self.rpc.request("get_state"), STATE)
        await ready
        task = self.prompt("ordinance")
        request = await self.rpc.request("prompt")
        self.rpc.reply(request)
        queued = {"queuedCount": 2, "steering": ["child reply"], "followUps": ["corrections"]}
        self.rpc.emit(
            end("stop"),  # An unrelated run ends before this prompt is consumed.
            {"type": "agent_start"}, user("ordinance"),
            {"type": "rlm_child_update", "child": {"id": "child", "status": "running"}},
            {"type": "session_action_update", "actions": queued}, end("toolUse"),
            {"type": "agent_start"}, end("stop"),
            {"type": "rlm_child_update", "child": {"id": "child", "status": "done"}})
        barrier = await self.rpc.request("wait_for_completion")
        # Neither root stop nor child done settles delayed parent/follow-up work.
        self.assertFalse(task.done())
        self.assertFalse(self.rpc.closed)
        self.assertTrue(self.rpc.requests.empty())
        self.rpc.emit({"type": "agent_start"}, user("corrections"), end("length"))
        self.rpc.reply(barrier)
        result = await asyncio.wait_for(task, 1)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["stop_reason"], "length")
        self.assertIn("truncated", result["error"])
        self.assertEqual(result["family_quiescence"], "confirmed")
        self.assertFalse(self.rpc.closed)


if __name__ == "__main__":
    unittest.main()
