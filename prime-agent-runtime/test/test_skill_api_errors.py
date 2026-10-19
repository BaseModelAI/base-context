from __future__ import annotations

import traceback
import types
import unittest

from rlm.repl import _error_event


def skill_module() -> types.ModuleType:
    module = types.ModuleType("job_watch")
    exec(
        "async def watch(job): pass\n"
        "async def unregister(id): pass\n"
        "async def status(id=None): pass\n",
        vars(module),
    )
    module.imported_helper = len
    return module


def missing_attribute(module: types.ModuleType, installed: dict[types.ModuleType, str]) -> AttributeError:
    namespace = {"skill": module, "_PRIME_AGENT_INSTALLED_SKILLS": installed}
    code = compile(
        "try:\n    raise ValueError('original context')\nexcept ValueError:\n    skill.register()\n",
        "<cell-api>",
        "exec",
    )
    try:
        exec(code, namespace)
    except AttributeError as error:
        return error
    raise AssertionError("missing API unexpectedly succeeded")


class SkillApiErrorTests(unittest.TestCase):
    def test_installed_skill_lists_real_apis_without_spelling_guess(self) -> None:
        module = skill_module()
        error = missing_attribute(module, {module: "job-watch"})
        original_traceback, original_context = error.__traceback__, error.__context__
        event = _error_event("skill-error", error)
        text = "".join(event["traceback"])

        self.assertEqual(event["ename"], "AttributeError")
        self.assertEqual(event["evalue"], str(error))
        self.assertIn("module 'job_watch' has no attribute 'register'", text)
        self.assertIn('File "<cell-api>", line 4', text)
        self.assertIn("ValueError: original context", text)
        self.assertIn("Public callable names: status, unregister, watch.", text)
        self.assertIn('prime_context {"action": "skill", "name": "job-watch"}', text)
        self.assertNotIn("Did you mean:", text)
        self.assertNotIn("imported_helper", text)
        self.assertLessEqual(len(event["traceback"][-1]), 2049)
        self.assertIs(error.__traceback__, original_traceback)
        self.assertIs(error.__context__, original_context)
        self.assertIs(error.obj, module)
        self.assertEqual(error.name, "register")
        self.assertNotIn("register", vars(module))

    def test_ordinary_module_with_same_name_keeps_original_rendering(self) -> None:
        installed, ordinary = skill_module(), skill_module()
        error = missing_attribute(ordinary, {installed: "job-watch"})
        expected = traceback.TracebackException.from_exception(error)
        expected.stack = traceback.StackSummary.from_list(
            frame for frame in expected.stack if frame.filename == "<cell-api>"
        )
        event = _error_event("project-error", error)

        self.assertEqual(event["ename"], "AttributeError")
        self.assertEqual(event["evalue"], str(error))
        self.assertEqual(event["traceback"], list(expected.format()))
        self.assertNotIn("Installed Python skill", "".join(event["traceback"]))


if __name__ == "__main__":
    unittest.main()
