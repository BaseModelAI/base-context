from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from test_repl import ReplProcess, one


class NamespaceKeyCoordinationTest(unittest.TestCase):
    def test_snapshot_ignores_non_string_globals_like_namespace_listing(self):
        kernel = ReplProcess()
        self.addCleanup(kernel.close)
        kernel.ready()
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "state.dill")
            manifest = str(Path(directory) / "state.json")
            for request_id, code in (
                ("ordinary", "answer = 41"),
                ("non_string", "answer = 42; globals()[1] = 'not a variable name'"),
            ):
                with self.subTest(request_id=request_id):
                    self.assertEqual(one(kernel.execute(request_id, code), "done")["status"], "ok")
                    kernel.send({"type": "list_names", "id": "names"})
                    self.assertEqual(one(kernel.until_done("names"), "done")["names"], ["answer"])
                    kernel.send({"type": "snapshot", "id": "save", "path": path, "manifest_path": manifest})
                    saved = one(kernel.until_done("save"), "done")
                    self.assertEqual(saved["status"], "ok", saved)
                    self.assertEqual(saved["saved"], ["answer"])

            fresh = ReplProcess()
            self.addCleanup(fresh.close)
            fresh.ready()
            fresh.send({"type": "restore", "id": "restore", "path": path})
            restored = one(fresh.until_done("restore"), "done")
            self.assertEqual(restored["status"], "ok")
            self.assertEqual(restored["restored"], ["answer"])
            self.assertEqual(restored["failed"], [])
            self.assertEqual(one(fresh.execute("check", "(answer, 1 in globals())"), "result")["text"], "(42, False)")


if __name__ == "__main__":
    unittest.main()
