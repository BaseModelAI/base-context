from __future__ import annotations

import asyncio
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import rlm

SKILL = Path(__file__).parents[2] / "packages/coding-agent/skills/agent-message/src/agent_message/__init__.py"


class TaskContractTest(unittest.TestCase):
    def load_skill(self):
        spec = importlib.util.spec_from_file_location("task_contract_agent_message", SKILL)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_optional_payloads_and_workflow_exports(self) -> None:
        contract = {"rules": ["Keep exact field values"]}
        spawn = AsyncMock(return_value={"rlm_child_id": "sub-1", "name": "worker", "session_dir": "/tmp/child", "model": "faux/local"})
        with patch.object(rlm, "host_request", spawn):
            asyncio.run(rlm.rlm("Inspect", task_contract=contract))
        self.assertEqual(spawn.await_args.args[1]["kwargs"], {"task_contract": contract})
        self.assertIs(rlm.rlm.workflow, rlm.workflow)
        self.assertTrue(callable(rlm.workflow.stage_delivery))
        self.assertTrue(callable(rlm.workflow.bounded_search))
        self.assertIn("BashExecutionContext", rlm.__all__)

        module = self.load_skill()
        outcome = {"facts": [{"source": "claim", "field": "serial", "value": "00123"}]}
        send = AsyncMock(return_value={"deliveryStatus": "delivered"})
        with patch.object(module, "host_request", send), patch.object(module, "_emit_sent_message"):
            asyncio.run(module.send_result("Ready", "Details", outcome=outcome))
            asyncio.run(module.send_result("Ready", "Details"))
        self.assertEqual(send.await_args_list[0].args[1]["outcome"], outcome)
        self.assertNotIn("outcome", send.await_args_list[1].args[1])

    def test_wrong_option_types_do_not_reach_host(self) -> None:
        module = self.load_skill()
        host = AsyncMock()
        with patch.object(rlm, "host_request", host):
            with self.assertRaisesRegex(TypeError, "task_contract must be a dict"):
                asyncio.run(rlm.rlm("Inspect", task_contract=[]))
        with patch.object(module, "host_request", host):
            with self.assertRaisesRegex(TypeError, "outcome must be a dict"):
                asyncio.run(module.send_result("Ready", "Details", outcome=[]))
        host.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
