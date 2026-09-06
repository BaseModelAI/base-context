"""Native Python state isolation; no host, network, or provider calls."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rlm.bash import _with_prefix
from rlm.harness import HarnessState, get_harness_state
from rlm.mcp_base import _read_auth
from rlm.product import product_home, product_state_path, project_state_dir
from rlm.repl import _resolve_owner_pid, _snapshot_state
from websearch.websearch import _resolve_api_key


class ProductIdentityTest(unittest.TestCase):
    def test_isolated_state_and_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            legacy = home / ".prime" / "agent"
            legacy.mkdir(parents=True)
            legacy_auth = json.dumps({"serper": {"type": "api_key", "key": "legacy-only"}})
            (legacy / "auth.json").write_text(legacy_auth)
            env = {
                "HOME": str(home), "USERPROFILE": str(home),
                "PRIME_AGENT_CODING_AGENT_DIR": str(legacy), "PI_CODING_AGENT_DIR": str(legacy),
                "RLM_SESSION_DIR": str(legacy), "RLM_HARNESS_STATE_DIR": str(legacy),
                "RLM_GLOBAL_HARNESS_STATE_DIR": str(legacy),
                "PRIME_AGENT_BASH_COMMAND_PREFIX": "legacy prefix",
                "PRIME_AGENT_KERNEL_OWNER_PID": "987654321",
            }
            with patch.dict(os.environ, env, clear=True), patch.object(Path, "home", return_value=home):
                self.assertEqual(product_home(), home / ".base-context")
                self.assertEqual(project_state_dir(home / "project"), home / "project" / ".base-context")
                self.assertIsNone(_read_auth("serper"))
                self.assertEqual(_resolve_api_key(), "")
                self.assertEqual(_with_prefix("command"), "command")
                self.assertEqual(_resolve_owner_pid(), os.getppid())
                with self.assertRaisesRegex(RuntimeError, "BASE_CONTEXT_KERNEL_SESSION_DIR"):
                    get_harness_state()
                get_harness_state(global_=True).create_memory("isolated", "new state")
                self.assertTrue(product_state_path("harness", "harness_state.json").is_file())
                self.assertFalse((legacy / "harness").exists())
                product_state_path("auth.json").write_text(
                    json.dumps({"serper": {"type": "api_key", "key": "base-only"}})
                )
                self.assertEqual(_read_auth("serper")["key"], "base-only")
                self.assertEqual(_resolve_api_key(), "base-only")
                for configured in (str(home / "custom"), "~/custom"):
                    with self.subTest(configured=configured), patch.dict(os.environ, {"BASE_CONTEXT_HOME": configured}):
                        self.assertEqual(product_home(), home / "custom")
                session = home / ".base-context" / "sessions" / "one"
                with patch.dict(os.environ, {"BASE_CONTEXT_KERNEL_SESSION_DIR": str(session)}):
                    self.assertEqual(get_harness_state().file_path, session / "harness" / "harness_state.json")
                with patch.dict(os.environ, {"SERPER_API_KEY": "provider-key", "BASE_CONTEXT_KERNEL_OWNER_PID": "123"}):
                    self.assertEqual(_resolve_api_key(), "provider-key")
                    self.assertEqual(_resolve_owner_pid(), 123)
                self.assertEqual((legacy / "auth.json").read_text(), legacy_auth)

    def test_rejects_invalid_or_shared_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            with patch.dict(os.environ, {}, clear=True), patch.object(Path, "home", return_value=home):
                for configured in ("", " ", "relative", "./relative", *(str(home / name) for name in (".prime", ".pi", ".prime-context"))):
                    with self.subTest(configured=configured), patch.dict(os.environ, {"BASE_CONTEXT_HOME": configured}):
                        with self.assertRaises(ValueError):
                            product_home()
                legacy = home / ".prime" / "agent"
                alias = home / "alias"
                alias.symlink_to(legacy, target_is_directory=True)  # target need not exist
                with patch.dict(os.environ, {"BASE_CONTEXT_HOME": str(alias)}):
                    with self.assertRaises(ValueError):
                        product_home()
                product_home().mkdir()
                product_state_path("auth.json").symlink_to(legacy / "auth.json")
                for read in (lambda: _read_auth("serper"), _resolve_api_key):
                    with self.assertRaises(ValueError):
                        read()
                with self.assertRaises(ValueError):
                    HarnessState(legacy / "harness_state.json")
                with self.assertRaises(ValueError):
                    _snapshot_state({}, str(legacy / "snapshot"), str(home / "manifest"), 1024, 1024, False)
                self.assertFalse(legacy.exists())


if __name__ == "__main__":
    unittest.main()
