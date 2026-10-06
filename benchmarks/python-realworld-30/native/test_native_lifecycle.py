"""Two offline lifecycle cases: completion/resume and ACK-only/restart-timeout."""
import asyncio
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

from base_protocol import BaseContextProtocol
from codex_protocol import CodexProtocol
from run_one import base_resume_command
from test_base_protocol import FakeRPC, STATE

ROOT = Path(__file__).resolve().parent
SAVED = {"sessionId": "saved-session", "sessionFile": "/home/bench/session.jsonl"}
THREAD = {"thread": {"id": "saved-thread", "status": {"type": "idle"}},
          "model": "model", "modelProvider": "openai", "reasoningEffort": "high"}
PARAMS = {"model": "model", "modelProvider": "openai", "cwd": "/workspace",
          "config": {"model_reasoning_effort": "high"}, "ephemeral": False}


class NativeLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clients, self.tasks, self.processes = [], [], []

    async def asyncTearDown(self):
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        for client in self.clients:
            await client.close()
        for process in self.processes:
            if process.returncode is None:
                process.kill()
            await process.wait()
        self.temp.cleanup()

    def client(self, kind):
        rpc = FakeRPC()
        client = kind(rpc, Path(self.temp.name) / f"events-{len(self.clients)}.jsonl")
        self.clients.append(client)
        return rpc, client

    def task(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.append(task)
        return task

    async def request(self, rpc, method):
        request = await asyncio.wait_for(rpc.requests.get(), 2)
        self.assertEqual(request["method"], method)
        return request

    def reply(self, rpc, request, result):
        rpc.emit({"id": request["id"], "result": result})

    def compact_event(self, thread="saved-thread"):
        return {"method": "item/completed", "params": {"threadId": thread, "turnId": "compact-turn",
                "completedAtMs": 123, "item": {"type": "contextCompaction", "id": "compact-item"}}}

    def completed_turn(self, turn="compact-turn"):
        return {"method": "turn/completed", "params": {"threadId": "saved-thread",
                "turn": {"id": turn, "status": "completed", "error": None}}}

    async def family_snapshot(self, rpc, child=None, root="idle"):
        request = await self.request(rpc, "thread/list")
        self.assertEqual(request["params"]["ancestorThreadId"], "saved-thread")
        self.assertIn("subAgentThreadSpawn", request["params"]["sourceKinds"])
        self.reply(rpc, request, {"data": [{"id": "child"}] if child is not None else [], "nextCursor": None})
        if child is not None:
            request = await self.request(rpc, "thread/read")
            self.assertEqual(request["params"], {"threadId": "child", "includeTurns": False})
            self.reply(rpc, request, {"thread": {"status": {"type": child}}})
        request = await self.request(rpc, "thread/read")
        self.assertEqual(request["params"], {"threadId": "saved-thread", "includeTurns": False})
        self.reply(rpc, request, {"thread": {"status": {"type": root}}})

    async def watcher_restart(self, timeout):
        idle = [sys.executable, "-c", "import signal; signal.pause()"]
        old = await asyncio.create_subprocess_exec(*idle)
        self.processes.append(old)
        watcher = await asyncio.create_subprocess_exec(
            sys.executable, str(ROOT / "deadline_watchdog.py"), "--namespace-init-pid", str(old.pid),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.processes.append(watcher)
        self.assertTrue(json.loads(await watcher.stdout.readline())["ready"])
        start = time.monotonic()
        watcher.stdin.write((json.dumps({"first_prompt_monotonic": start, "timeout_seconds": timeout}) + "\n").encode())
        armed = json.loads(await watcher.stdout.readline())
        watcher.stdin.write(b'{"begin_restart":true}\n')
        self.assertTrue(json.loads(await watcher.stdout.readline())["restart_ready"])
        old.kill()
        await old.wait()
        new = await asyncio.create_subprocess_exec(*idle)
        self.processes.append(new)
        watcher.stdin.write((json.dumps({"namespace_init_pids": [new.pid]}) + "\n").encode())
        registered = json.loads(await watcher.stdout.readline())
        self.assertTrue(registered["namespace_registered"])
        self.assertEqual(registered["generation"], 1)
        self.assertEqual(registered["deadline_monotonic"], armed["deadline_monotonic"])
        return watcher, new

    async def test_completed_compaction_same_identity_and_new_namespace_exit(self):
        initial_command = ["base-context", "--mode", "rpc", "--rpc-protocol-version", "13",
                           "--session-dir", "/home/bench/sessions"]
        self.assertEqual(base_resume_command(initial_command, SAVED),
                         [*initial_command, "--resume", SAVED["sessionFile"]])
        rpc, base = self.client(BaseContextProtocol)
        operation = self.task(base.compact())
        request = await rpc.request("compact")
        event = {"type": "compaction_end", "reason": "manual", "aborted": False,
                 "result": {"summary": "saved", "firstKeptEntryId": "entry"}}
        rpc.emit(event)
        rpc.reply(request, event["result"])
        self.assertEqual((await operation)["event"], event)
        fresh_rpc, fresh_base = self.client(BaseContextProtocol)
        operation = self.task(fresh_base.ready(resume=SAVED))
        fresh_rpc.reply(await fresh_rpc.request("get_state"), {**STATE, **SAVED})
        self.assertEqual((await operation)["sessionId"], SAVED["sessionId"])

        rpc, codex = self.client(CodexProtocol)
        operation = self.task(codex.ready(PARAMS, resume={"threadId": "saved-thread"}))
        self.reply(rpc, await self.request(rpc, "initialize"), {})
        await self.request(rpc, "initialized")
        request = await self.request(rpc, "thread/resume")
        self.assertEqual(request["params"], {**{k:v for k,v in PARAMS.items() if k != "ephemeral"}, "threadId": "saved-thread"})
        self.reply(rpc, request, THREAD)
        await operation
        operation = self.task(codex.compact())
        request = await self.request(rpc, "thread/compact/start")
        rpc.emit(self.compact_event(), self.completed_turn())  # Both can arrive before the ACK.
        self.reply(rpc, request, {})
        completed = await operation
        self.assertEqual(completed["event"]["params"]["item"]["id"], "compact-item")
        self.assertEqual(completed["turn_completed"]["params"]["turn"]["id"], "compact-turn")
        operation = self.task(codex.wait_for_family_idle())
        await self.family_snapshot(rpc)
        self.assertEqual((await operation)["completion_scope"], "observed_native_family_idle")
        self.assertTrue(rpc.requests.empty())

        watcher, new = await self.watcher_restart(30)
        new.kill()
        await new.wait()
        event = json.loads(await asyncio.wait_for(watcher.stdout.readline(), 2))
        self.assertIn("native_exit_monotonic", event)
        self.assertEqual(event["generation"], 1)
        watcher.stdin.write(b'{"done":true}\n')
        await asyncio.wait_for(watcher.wait(), 2)
        self.assertEqual(watcher.returncode, 0)

    async def test_ack_is_not_compaction_and_restart_does_not_reset_timeout(self):
        rpc, base = self.client(BaseContextProtocol)
        operation = self.task(base.compact())
        rpc.reply(await rpc.request("compact"), {"summary": "ACK without event"})
        with self.assertRaisesRegex(RuntimeError, "did not complete"):
            await operation
        rpc, codex = self.client(CodexProtocol)
        codex.thread_id = "saved-thread"
        operation = self.task(codex.compact())
        self.reply(rpc, await self.request(rpc, "thread/compact/start"), {})
        rpc.emit(self.compact_event("unrelated-thread"))
        await asyncio.sleep(0)
        self.assertFalse(operation.done())
        rpc.emit(self.compact_event(), self.completed_turn("unrelated-turn"))
        await asyncio.sleep(0)
        self.assertFalse(operation.done())  # The item alone cannot permit teardown.
        rpc.emit(self.completed_turn())
        self.assertEqual((await operation)["status"], "completed")
        operation = self.task(codex.wait_for_family_idle())
        await self.family_snapshot(rpc, child="active")
        await asyncio.sleep(0)
        self.assertFalse(operation.done())
        rpc.emit({"method": "thread/status/changed", "params": {"threadId": "child", "status": {"type": "idle"}}})
        await self.family_snapshot(rpc, child="idle", root="active")
        await asyncio.sleep(0)
        self.assertFalse(operation.done())  # A child can trigger another parent turn.
        rpc.emit({"method": "thread/status/changed", "params": {"threadId": "saved-thread", "status": {"type": "idle"}}})
        await self.family_snapshot(rpc, child="idle")
        self.assertEqual((await operation)["thread_states"], {"child": "idle", "saved-thread": "idle"})
        operation = self.task(codex.compact())
        self.reply(rpc, await self.request(rpc, "thread/compact/start"), {})
        rpc.emit({"method": "turn/completed", "params": {"threadId": "foreign-thread",
                  "turn": {"id": "failed-compact", "status": "failed", "error": {"message": "foreign"}}}})
        rpc.emit({"method": "item/started", "params": {"threadId": "saved-thread", "turnId": "failed-compact",
                  "startedAtMs": 124, "item": {"type": "contextCompaction", "id": "failed-item"}}})
        await asyncio.sleep(0)
        self.assertFalse(operation.done())
        rpc.emit({"method": "turn/completed", "params": {"threadId": "saved-thread",
                  "turn": {"id": "failed-compact", "status": "failed", "error": {"message": "synthetic"}}}})
        with self.assertRaisesRegex(RuntimeError, "compaction turn failed"):
            await operation
        watcher, new = await self.watcher_restart(0.5)
        event = json.loads(await asyncio.wait_for(watcher.stdout.readline(), 2))
        self.assertEqual(event["reason"], "timeout")
        self.assertEqual(event["generation"], 1)
        await asyncio.wait_for(new.wait(), 2)
        await asyncio.wait_for(watcher.wait(), 2)
        self.assertEqual(new.returncode, -9)
        self.assertEqual(watcher.returncode, 0)


if __name__ == "__main__":
    unittest.main()
