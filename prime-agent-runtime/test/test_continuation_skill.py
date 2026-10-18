from __future__ import annotations

import asyncio
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, call, patch


SKILL = Path(__file__).parents[2] / "packages/coding-agent/skills/continuation/src/continuation/__init__.py"


class ContinuationSkillTest(unittest.TestCase):
    def setUp(self) -> None:
        spec = importlib.util.spec_from_file_location("continuation_test", SKILL)
        assert spec and spec.loader
        self.skill = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.skill)

    def test_block_and_status_use_native_host_bridge(self) -> None:
        blocked = {
            "status": "blocked_external",
            "hold": {"kind": "external_blocker", "reason": "required input unavailable"},
        }
        replies = [{"status": "ok", "result": result} for result in (blocked, blocked, {"status": "ready"})]
        host = AsyncMock(side_effect=replies)
        with patch("rlm.repl.host_request", host):
            self.assertEqual(asyncio.run(self.skill.block(reason="required input unavailable")), blocked)
            self.assertEqual(asyncio.run(self.skill.status()), blocked)
            self.assertEqual(asyncio.run(self.skill.status()), {"status": "ready"})
        self.assertEqual(host.await_args_list, [
            call({"type": "continuation_block", "reason": "required input unavailable"}),
            call({"type": "continuation_status"}),
            call({"type": "continuation_status"}),
        ])
        self.assertFalse(hasattr(self.skill, "resume"))
        self.assertFalse(hasattr(self.skill, "replace_gates"))

    def test_empty_reason_does_not_reach_host(self) -> None:
        host = AsyncMock()
        with patch("rlm.repl.host_request", host):
            with self.assertRaisesRegex(ValueError, "reason must not be empty"):
                asyncio.run(self.skill.block(reason=" \n"))
        host.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
