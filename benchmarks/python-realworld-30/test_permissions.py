from __future__ import annotations

import stat
import tempfile
import unittest
from pathlib import Path

from benchlib import make_read_only, make_writable_tree


class PermissionHelpersTest(unittest.TestCase):
    def test_regular_files_keep_existing_permission_behavior(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary) / "workspace"
            nested = workspace / "nested"
            nested.mkdir(parents=True)
            regular = nested / "file.txt"
            regular.write_text("content")
            regular.chmod(0o660)
            nested.chmod(0o770)

            make_read_only(regular)
            make_read_only(nested)
            self.assertEqual(stat.S_IMODE(regular.stat().st_mode), 0o440)
            self.assertEqual(stat.S_IMODE(nested.stat().st_mode), 0o550)

            make_writable_tree(workspace)
            self.assertEqual(stat.S_IMODE(regular.stat().st_mode), 0o640)
            self.assertEqual(stat.S_IMODE(nested.stat().st_mode), 0o750)

    def test_symlinks_leave_targets_unchanged_including_traversal_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            outside = root / "outside"
            outside.mkdir()
            outside.chmod(0o750)
            target = outside / "python"
            target.write_text("external executable")
            target.chmod(0o660)
            file_link = workspace / "python"
            file_link.symlink_to(target)
            directory_link = workspace / "external"
            directory_link.symlink_to(outside, target_is_directory=True)

            make_read_only(file_link)
            make_read_only(directory_link)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o660)
            self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o750)

            target.chmod(0o440)
            make_writable_tree(workspace)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o440)
            make_writable_tree(directory_link)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o440)
            self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o750)


if __name__ == "__main__":
    unittest.main()
