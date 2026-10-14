from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from dataclasses import FrozenInstanceError, asdict
from pathlib import Path
from unittest import mock

from rlm.bash import BashExecutionContext, BashResult, bash


@unittest.skipUnless(os.name == "posix", "requires a POSIX shell")
class BashExecutionContextTest(unittest.IsolatedAsyncioTestCase):
    async def test_default_context_is_captured_at_launch_not_observation(self):
        original_cwd = os.getcwd()
        command = "pwd -P; printf '%s\n' \"$0\"; printf hello | cat"
        with tempfile.TemporaryDirectory() as launch, tempfile.TemporaryDirectory() as later:
            try:
                os.chdir(launch)
                with mock.patch("rlm.bash._shell", return_value="/bin/sh") as select_shell:
                    handle = bash(command)
                os.chdir(later)
                result = await asyncio.wait_for(handle, timeout=3)
            finally:
                os.chdir(original_cwd)
        select_shell.assert_called_once_with()
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.output, f"{os.path.realpath(launch)}\n/bin/sh\nhello")
        self.assertIs(result.context, handle.context)
        self.assertIs(handle.poll(), result)
        self.assertEqual(asdict(handle.context), {
            "command": command, "cwd": os.path.realpath(launch), "shell": "/bin/sh", "mode": None,
        })

    async def test_explicit_pathlike_cwd_mode_and_original_command(self):
        original_cwd = os.getcwd()
        command = "pwd -P; printf original"
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve() / "work with spaces"
            target.mkdir()
            with mock.patch.dict(os.environ, {"BASE_CONTEXT_BASH_COMMAND_PREFIX": "printf 'prefix\\n'"}):
                handle = bash(command, cwd=target, mode="project-native")
            observed = []
            handle.add_done_callback(observed.append)
            result = await asyncio.wait_for(handle, timeout=3)
            self.assertEqual(os.getcwd(), original_cwd)
            self.assertEqual(result.context.cwd, str(target))
            self.assertEqual(result.context.mode, "project-native")
            self.assertEqual(result.context.command, command)
            self.assertIs(result.context, handle.context)
            self.assertEqual(observed, [result])
            self.assertEqual(result.output, f"prefix\n{target}\noriginal")
            with self.assertRaises(FrozenInstanceError):
                result.context.mode = "changed"
            with self.assertRaises(AttributeError):
                handle.context = BashExecutionContext("other", "/", "/bin/sh")

    async def test_relative_cwd_preserves_symlink_parent_semantics(self):
        original_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / "actual" / "child"
            target.mkdir(parents=True)
            (root / "alias").symlink_to(target, target_is_directory=True)
            try:
                os.chdir(root)
                handle = bash("pwd -P", cwd="alias/..", mode="declared-only")
                os.chdir(original_cwd)
                result = await asyncio.wait_for(handle, timeout=3)
            finally:
                os.chdir(original_cwd)
            self.assertEqual(result.context.cwd, str(root / "actual"))
            self.assertEqual(result.output, f"{root / 'actual'}\n")

    async def test_absolute_cwd_does_not_require_a_resolvable_parent_cwd(self):
        original_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            removed = Path(directory, "removed")
            removed.mkdir()
            try:
                os.chdir(removed)
                removed.rmdir()
                with mock.patch("rlm.bash._shell", return_value="/bin/sh"):
                    handle = bash("pwd -P", cwd=directory)
                os.chdir(original_cwd)
                result = await asyncio.wait_for(handle, timeout=3)
            finally:
                os.chdir(original_cwd)
            self.assertEqual(result.context.cwd, os.path.realpath(directory))
            self.assertEqual(result.output, f"{result.context.cwd}\n")

    async def test_invalid_context_arguments_do_not_start_command(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory, "started")
            command = f"touch '{marker}'"
            for cwd in ("", str(Path(directory, "missing", ".."))):
                with self.subTest(cwd=cwd), self.assertRaises(FileNotFoundError):
                    bash(command, cwd=cwd)
            with self.assertRaises(TypeError):
                bash(command, mode=[])
            self.assertFalse(marker.exists())

    async def test_context_access_preserves_owned_cancellation(self):
        handle = bash("sleep 30", mode="native")
        context = handle.context
        task = asyncio.ensure_future(handle)
        try:
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertFalse(handle._group_alive())
            self.assertIs(handle.context, context)
        finally:
            handle.kill(grace=0)

    async def test_context_survives_foreground_completion_and_background_kill(self):
        handle = bash("printf foreground; sleep 30 &", mode="background")
        context = handle.context
        try:
            result = await asyncio.wait_for(handle, timeout=3)
            self.assertEqual(result.output, "foreground")
            self.assertEqual(result.exit_code, 0)
            self.assertTrue(handle.running)
            handle.kill(grace=0)
            await handle._confirm_group_exit()
            self.assertIs(result.context, context)
            self.assertIs(handle.poll(), result)
        finally:
            handle.kill(grace=0)

    async def test_context_preserves_output_fence_and_early_exit(self):
        for command, expected, status in (
            ("trap 'printf after' EXIT; printf before", "before", 0),
            ("printf before; exit 7", "before", 7),
        ):
            with self.subTest(command=command):
                handle = bash(command, mode="test")
                result = await asyncio.wait_for(handle, timeout=3)
                self.assertEqual(result.output, expected)
                self.assertEqual(result.exit_code, status)
                self.assertIs(result.context, handle.context)
                self.assertEqual(result.context.command, command)
                self.assertTrue(await asyncio.to_thread(handle._eof.wait, 2))
                if status == 0:
                    self.assertEqual(handle.output(), "beforeafter")

    def test_manual_results_remain_constructible_without_context(self):
        self.assertIsNone(BashResult(0, "output", 0.1).context)


if __name__ == "__main__":
    unittest.main()
