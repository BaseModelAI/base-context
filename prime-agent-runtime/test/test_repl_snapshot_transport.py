from __future__ import annotations

import builtins
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import dill
from dill import _dill

from rlm import repl
from rlm.bash import BashHandle
from test_repl import ReplProcess, one, stream_text


class SnapshotTransportTest(unittest.TestCase):
    def setUp(self):
        self.kernel = ReplProcess()
        self.addCleanup(self.kernel.close)
        self.kernel.ready()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = str(Path(self.directory.name) / "state.dill")
        self.manifest = str(Path(self.directory.name) / "state.json")

    def snapshot(self, **options):
        self.kernel.send({"type": "snapshot", "id": "save", "path": self.path,
                          "manifest_path": self.manifest, **options})
        return one(self.kernel.until_done("save"), "done")

    def fresh(self):
        kernel = ReplProcess()
        self.addCleanup(kernel.close)
        kernel.ready()
        kernel.send({"type": "restore", "id": "restore", "path": self.path})
        return kernel, one(kernel.until_done("restore"), "done")

    def test_functions_use_live_globals_and_keep_closures_and_aliases(self):
        code = """G = 1
_hidden = 4
def reader(): return G + _hidden
def late_reader(): return late
reader.label = 'saved'
aliases = [reader, reader]
def counter():
    n = 0
    def get(): return n
    def advance():
        nonlocal n
        n += 1
    return get, advance
pair = counter()
from collections import namedtuple
Point = namedtuple('Point', 'x y')
point = Point(1, 2)
"""
        self.kernel.execute("setup", code)
        self.assertEqual(self.snapshot()["status"], "ok")
        fresh, restored = self.fresh()
        self.assertEqual(restored["failed"], [])
        events = fresh.execute("check", "G = 2; late = 9; pair[1](); "
                               "(reader(), late_reader(), reader.label, aliases[0] is aliases[1], pair[0](), point.x)")
        self.assertEqual(one(events, "result")["text"], "(6, 9, 'saved', True, 1, 1)")

    def test_nested_class_methods_and_immutable_cycles_use_live_globals(self):
        code = """G = 1
class _Base:
    def read(self): return G
    @property
    def value(self): return G
    @classmethod
    def read_class(cls): return G
    @staticmethod
    def read_static(): return G
class _Derived(_Base): pass
def _make():
    def f(): return G
    frozen = frozenset([f])
    f.collection = frozen
    return frozen
class _Cycle:
    def read(self): return G
_c = _Cycle()
_c.saved = _c.read
def _reader(): return G
def _defaults(f=_reader, *, other=_reader): return f(), other()
_list = []
_tuple = (_list, _reader)
_list.append(_tuple)
def _descriptor(kind):
    def read(self=None): return G
    descriptor = kind(read)
    read.owner = descriptor
    return descriptor
graph = [_Derived(), _make(), _c.saved, _defaults, _tuple,
         _descriptor(staticmethod), _descriptor(classmethod), _descriptor(property)]
"""
        self.kernel.execute("setup", code)
        self.assertEqual(self.snapshot()["status"], "ok")
        fresh, restored = self.fresh()
        self.assertEqual(restored["failed"], [])
        events = fresh.execute("check", "G = 2; f = next(iter(graph[1])); "
                               "(graph[0].read(), graph[0].value, graph[0].read_class(), "
                               "graph[0].read_static(), f(), f.collection is graph[1], "
                               "graph[2] is graph[2].__self__.saved, graph[2](), graph[3](), "
                               "graph[4] is graph[4][0][0], graph[4][1](), "
                               "graph[5].__func__.owner is graph[5], "
                               "graph[6].__func__.owner is graph[6], graph[7].fget.owner is graph[7])")
        self.assertEqual(one(events, "result")["text"],
                         "(2, 2, 2, 2, 2, True, True, 2, (2, 2), True, 2, True, True, True)")

    def test_slotted_user_instances_keep_live_functions_and_cycles(self):
        code = """G = 1
class _Base:
    __slots__ = ('reader',)
class _Slotted(_Base):
    __slots__ = ('other', 'unset')
def _reader(): return G + late
instance = _Slotted()
instance.reader = instance.other = _reader
class _Cycle:
    __slots__ = ('reader',)
def _cycle_reader(): return G + late
cyclic = _Cycle()
cyclic.reader = _cycle_reader
_cycle_reader.owner = cyclic
"""
        self.assertEqual(one(self.kernel.execute("setup", code), "done")["status"], "ok")
        self.assertEqual(self.snapshot()["status"], "ok")
        fresh, restored = self.fresh()
        self.assertEqual(restored["failed"], [])
        events = fresh.execute("check", "G = 2; late = 9; "
                               "(instance.reader(), instance.other(), "
                               "instance.reader is instance.other, "
                               "cyclic.reader.owner is cyclic, hasattr(instance, 'unset'), cyclic.reader())")
        self.assertEqual(one(events, "done")["status"], "ok", events)
        self.assertEqual(one(events, "result")["text"], "(11, 11, True, True, False, 11)")

    def test_legacy_shell_handle_is_refused_in_both_snapshot_formats(self):
        handle = object.__new__(BashHandle)
        handle.command = "old completed command"
        with mock.patch.object(BashHandle, "__reduce_ex__", object.__reduce_ex__):
            blob = dill.dumps(handle)
        payload = {"old": blob, "keep": dill.dumps(7)}
        for legacy in (True, False):
            with self.subTest(legacy=legacy):
                with open(self.path, "wb") as file:
                    if legacy:
                        dill.dump(payload, file)
                    else:
                        file.write(repl._SNAPSHOT_MAGIC)
                        for name, value in payload.items():
                            encoded = name.encode("utf-8")
                            file.write(repl._SNAPSHOT_RECORD.pack(len(encoded), len(value)))
                            file.write(encoded)
                            file.write(value)
                fresh, restored = self.fresh()
                self.assertEqual(restored["status"], "ok")
                self.assertEqual(restored["restored"], ["keep"])
                self.assertEqual([item["name"] for item in restored["failed"]], ["old"])
                self.assertIn("BashHandle owns process resources", restored["failed"][0]["reason"])
                events = fresh.execute("check", "(keep, 'old' in globals())")
                self.assertEqual(one(events, "result")["text"], "(7, False)")

    def test_legacy_restore_refuses_raw_fd_and_keeps_path_file(self):
        events = self.kernel.execute("fd", "import rlm.repl as _repl; _repl._loop._ssock.fileno()")
        fd = int(one(events, "result")["text"])

        class RawFD:
            def __reduce__(self):
                return _dill._create_filehandle, (fd, "rb", -1, True, builtins.open, False, dill.HANDLE_FMODE, "")

        ordinary = Path(self.directory.name) / "ordinary.txt"
        ordinary.write_text("path-backed")
        with ordinary.open() as file:
            payload = {"bad": dill.dumps(RawFD()), "keep": dill.dumps(7), "file": dill.dumps(file)}
        with open(self.path, "wb") as file:
            dill.dump(payload, file)
        self.kernel.send({"type": "restore", "id": "restore", "path": self.path})
        done = one(self.kernel.until_done("restore"), "done")
        self.assertEqual(done["status"], "ok")
        self.assertEqual([item["name"] for item in done["failed"]], ["bad"])
        self.assertIn("raw file descriptors", done["failed"][0]["reason"])
        events = self.kernel.execute("check", "(keep, file.read())")
        self.assertEqual(one(events, "result")["text"], "(7, 'path-backed')")

    def test_completed_off_cell_shell_handle_is_skipped(self):
        self.kernel.execute("setup", "import asyncio; from rlm import bash; "
                            "handle = await asyncio.to_thread(bash, 'printf done'); "
                            "result = await handle; keep = 7")
        done = self.snapshot()
        self.assertEqual(done["status"], "ok")
        self.assertIn("keep", done["saved"])
        failure = next(item for item in done["skipped"] if item["name"] == "handle")
        self.assertIn("BashHandle owns process resources", failure["reason"])

    def test_each_value_serializes_once_and_aggregate_cap_counts_records(self):
        values = {"a": 1, "b": 2}
        with mock.patch.object(dill, "dump", wraps=dill.dump) as dump:
            saved = repl._snapshot_state(values, self.path, self.manifest, 1024, 1024, False)
        self.assertEqual(dump.call_count, 2)
        self.assertEqual(saved["saved"], ["a", "b"])
        restored = {}
        self.assertEqual(repl._restore_state(restored, self.path)["failed"], [])
        self.assertEqual(restored, values)
        cap = len(repl._SNAPSHOT_MAGIC) + repl._SNAPSHOT_RECORD.size + 1 + len(dill.dumps(1))
        with mock.patch.object(dill, "dump", wraps=dill.dump) as dump:
            saved = repl._snapshot_state(values, self.path, self.manifest, cap, 1024, False)
        self.assertEqual(dump.call_count, 2)
        self.assertEqual(saved["saved"], ["a"])
        self.assertEqual(saved["skipped"], [{"name": "b", "reason": "exceeds aggregate snapshot size cap"}])
        self.assertEqual(saved["bytes"], cap)
        self.assertEqual(os.path.getsize(self.path), cap)

    def test_corrupt_record_leaves_namespace_and_snapshot_unchanged(self):
        repl._snapshot_state({"a": 1}, self.path, self.manifest, 1024, 1024, False)
        damaged = Path(self.path).read_bytes() + b"incomplete"
        Path(self.path).write_bytes(damaged)
        target = {"keep": 7}
        result = repl._restore_state(target, self.path)
        self.assertIn("incomplete record", result["error"])
        self.assertEqual(target, {"keep": 7})
        self.assertEqual(Path(self.path).read_bytes(), damaged)

    def test_large_write_is_lossless_chunked_and_attributed(self):
        for text in ("x" * 300000, "\U0001f600" * 65537):
            with self.subTest(character=text[0]):
                events = self.kernel.execute("write", f"import sys; sys.stdout.write({text[0]!r} * {len(text)})")
                chunks = [event for event in events if event["event"] == "stdout"]
                self.assertTrue(all(len(event["text"]) <= 65536 and event["id"] == "write" for event in chunks))
                self.assertEqual(stream_text(events, "stdout"), text)
                self.assertEqual(one(events, "result")["text"], str(len(text)))

    def test_text_caps_mark_upstream_truncation(self):
        self.kernel.execute("limits", "import rlm.repl as _repl; _repl._TEXT_EVENT_CHARS = 128")
        events = self.kernel.execute("result", "'x' * 300")
        result = one(events, "result")
        self.assertEqual(len(result["text"]), 128)
        self.assertTrue(result["upstreamTruncated"])
        events = self.kernel.execute("error", "raise ValueError('x' * 300)")
        error = one(events, "error")
        self.assertLessEqual(len(error["evalue"]), 128)
        self.assertLessEqual(len("".join(error["traceback"])), 128)
        self.assertTrue(error["upstreamTruncated"])
        self.assertNotIn("upstreamTruncated", one(self.kernel.execute("small", "7"), "result"))

    def test_oversized_encoded_payload_is_refused_before_request_registration(self):
        self.kernel.execute("limits", "import rlm.repl as _repl; _repl._ENCODED_PAYLOAD_CHARS = 512")
        for index, code in enumerate(("await _repl.host_request({'text': '\U0001f600' * 100})",
                                      "_repl.emit({'text/plain': '\U0001f600' * 100})")):
            events = self.kernel.execute(f"large{index}", code)
            self.assertFalse(any(event["event"] in {"host_request", "display"} for event in events))
            self.assertIn("encoded JSON characters", one(events, "error")["evalue"])
        events = self.kernel.execute("next", "len(_repl._pending_host)")
        self.assertEqual(one(events, "result")["text"], "0")


if __name__ == "__main__":
    unittest.main()
