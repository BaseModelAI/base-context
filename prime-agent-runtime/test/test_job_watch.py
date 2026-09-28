import asyncio
import unittest
from rlm.bash import bash
from rlm.job_watch import identity, _probe, _handles
from unittest.mock import AsyncMock, patch
import gc
import threading


class JobWatchCallbackTest(unittest.IsolatedAsyncioTestCase):
    async def test_callback_and_identity_preserve_first_await_ownership(self):
        handle = bash("python3 -c 'import time; time.sleep(10)'")
        resource = identity(handle)
        remove = handle.add_done_callback(lambda result: None)
        with patch("rlm.host_request", new=AsyncMock()):
            await _probe({"id": "probe", "resourceId": resource, "jobId": "job", "completionSource": "handle", "command": None})
        self.assertFalse(handle._released)
        async def wait():
            return await handle
        task = asyncio.create_task(wait())
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIsNotNone(handle.poll())
        self.assertNotEqual(handle.poll().exit_code, 0)
        remove()

    async def test_background_await_stays_nonowning_and_unregister_never_kills(self):
        handle = bash("python3 -c 'import time; time.sleep(10)'")
        _ = handle.pid
        remove = handle.add_done_callback(lambda result: None)
        async def wait():
            return await handle
        task = asyncio.create_task(wait())
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        remove()
        self.assertIsNone(handle.poll())
        handle.kill(grace=0)
        await handle

    async def test_completed_callback_is_immediate_and_idempotently_removable(self):
        workers = []
        real_thread = threading.Thread
        def worker_thread(*args, **kwargs):
            thread = real_thread(*args, **kwargs)
            workers.append(thread)
            return thread
        with patch("rlm.bash.threading.Thread", side_effect=worker_thread):
            handle = bash("printf done")
        resource = identity(handle)
        result = await handle
        seen = []
        remove = handle.add_done_callback(seen.append)
        remove(); remove()
        self.assertEqual(seen, [result])
        # Foreground result delivery precedes containment-worker retirement.
        # Their bound methods legitimately retain the handle until they exit.
        for worker in workers:
            await asyncio.to_thread(worker.join, 1)
            self.assertFalse(worker.is_alive())
        del remove, handle
        gc.collect()
        self.assertNotIn(resource, _handles)
