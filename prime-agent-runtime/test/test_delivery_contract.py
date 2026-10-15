"""Task-contract input for the existing delivery staging helper."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from rlm.workflow import stage_delivery


class DeliveryContractTest(unittest.TestCase):
    def test_stages_declared_files_and_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "run.py").write_text("import helper\nprint(helper.value)\n")
            (workspace / "helper.py").write_text(
                "from pathlib import Path\nvalue = Path(__file__).with_name('value.txt').read_text()\n"
            )
            (workspace / "value.txt").write_text("delivered")
            (workspace / "private.txt").write_text("not delivered")
            delivery = {
                "workspace": str(workspace),
                "consumer_root": "/consumer",
                "mode": "separate",
                "files": [
                    {"path": "run.py", "dependencies": ["helper.py"]},
                    {"path": "helper.py", "dependencies": ["value.txt"]},
                    {"path": "value.txt"},
                ],
            }
            result = stage_delivery(delivery, root / "staged")
            self.assertEqual(result.files, ("run.py", "helper.py", "value.txt"))
            self.assertEqual(result.dependencies, (
                ("run.py", ("helper.py",)), ("helper.py", ("value.txt",)),
            ))
            consumer = subprocess.run(
                [sys.executable, "run.py"], cwd=root / "staged",
                env={**os.environ, "PYTHONPATH": ""}, capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(consumer.returncode, 0, consumer.stderr)
            self.assertEqual(consumer.stdout, "delivered\n")
            self.assertFalse((root / "staged/private.txt").exists())
            self.assertEqual(delivery["consumer_root"], "/consumer")

    def test_rejects_sidecar_missing_from_declared_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "run.py").write_text("import helper\n")
            (root / "helper.py").write_text("value = 1\n")
            delivery = {
                "workspace": str(root),
                "files": [{"path": "run.py", "dependencies": ["helper.py"]}],
            }
            with self.assertRaisesRegex(ValueError, "must be included in files"):
                stage_delivery(delivery, root / "staged")
            self.assertFalse((root / "staged").exists())


if __name__ == "__main__":
    unittest.main()
