from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from rlm.harness import HarnessState


class HarnessSaveHandoverCoordinationTest(unittest.TestCase):
    def test_save_keeps_its_cached_image_current(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "harness_state.json"
            state = HarnessState(path)
            state.create_memory("First", "first", id="first")
            self.assertEqual(state._loaded_mtime, path.stat().st_mtime_ns)
            state.create_memory("Second", "second", id="second")
            self.assertEqual(set(HarnessState(path).entries["memory"]), {"first", "second"})

    def test_save_does_not_adopt_a_later_writers_mtime(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "harness_state.json"
            state = HarnessState(path)
            replace = os.replace
            handed_over = False

            def replace_then_handover(source, target):
                nonlocal handed_over
                replace(source, target)
                if handed_over:
                    return
                handed_over = True
                prior_mtime = path.stat().st_mtime_ns
                other = HarnessState(path)
                other.create_memory("Other writer", "keep this", id="other")
                # Make the interleaving independent of filesystem timestamp resolution.
                os.utime(path, ns=(prior_mtime + 1_000_000, prior_mtime + 1_000_000))

            with mock.patch("rlm.harness.os.replace", side_effect=replace_then_handover):
                state.create_memory("First", "first", id="first")
            state.create_memory("Second", "second", id="second")
            self.assertEqual(set(HarnessState(path).entries["memory"]), {"first", "other", "second"})


if __name__ == "__main__":
    unittest.main()
