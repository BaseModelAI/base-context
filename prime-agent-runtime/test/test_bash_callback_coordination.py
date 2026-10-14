from __future__ import annotations

import asyncio
import contextlib
import threading
import unittest
from unittest import mock

from rlm.bash import BashHandle, bash


class BashCallbackCoordinationTest(unittest.IsolatedAsyncioTestCase):
    async def test_completion_observers_cannot_strand_awaiters(self):
        original_read_status = BashHandle._read_status
        for failing_callback in (False, True):
            with self.subTest(failing_callback=failing_callback):
                release = threading.Event()

                def gated_status(handle):
                    if not release.wait(2):
                        raise TimeoutError("test reporter gate did not open")
                    return original_read_status(handle)

                observed = []

                def callback(result):
                    observed.append(result)
                    if failing_callback:
                        raise ValueError("observer failed")

                logging = self.assertLogs("rlm.bash", level="ERROR") if failing_callback else contextlib.nullcontext()
                with logging, mock.patch.object(BashHandle, "_read_status", gated_status):
                    handle = bash("printf complete")
                    handle.add_done_callback(callback)
                    waiter = asyncio.create_task(handle._wait())
                    await asyncio.sleep(0)  # Register the waiter behind the observer before releasing the reporter.
                    release.set()
                    result = await asyncio.wait_for(waiter, timeout=2)
                    self.assertEqual(result.output, "complete")
                    self.assertEqual(result.exit_code, 0)
                    self.assertEqual(observed, [result])


if __name__ == "__main__":
    unittest.main()
