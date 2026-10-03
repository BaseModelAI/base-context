import importlib
import json
import os
import tempfile
import unittest
from unittest import mock

from rlm.bash import bash
from test_bash import _poll_journal

bash_module = importlib.import_module("rlm.bash")


class BashJournalAcquisitionTest(unittest.IsolatedAsyncioTestCase):
    async def test_successive_commands_overlap_orphan_retirement(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(os.environ, {
                "BASE_CONTEXT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                "BASE_CONTEXT_KERNEL_OWNER_PID": str(os.getpid()),
            }):
                # Foreground completion can precede the previous command's journal retirement.
                for _ in range(20):
                    result = await bash("printf ok")
                    self.assertEqual((result.exit_code, result.output), (0, "ok"))
                records = await _poll_journal(journal, 40)
            self.assertEqual(len(records), 40)
            self.assertEqual(sum(record["active"] for record in records), 20)

    async def test_partial_writes_complete_the_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            real_write = os.write

            def partial_write(fd, data):
                return real_write(fd, bytes(data)[:1])

            with mock.patch.dict(os.environ, {
                "BASE_CONTEXT_INTERNAL_ORPHAN_PROCESS_JOURNAL": journal,
                "BASE_CONTEXT_KERNEL_OWNER_PID": str(os.getpid()),
            }):
                with mock.patch.object(bash_module.os, "write", partial_write):
                    self.assertTrue(bash_module._record_journal(os.getpid(), active=False))
            with open(journal) as stream:
                record = json.loads(stream.read())
            self.assertEqual(record["pid"], os.getpid())
            self.assertFalse(record["active"])
