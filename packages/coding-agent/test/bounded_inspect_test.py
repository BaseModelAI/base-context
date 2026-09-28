"""Focused native-interpreter fixtures for the bounded-inspect skill."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills/bounded-inspect/src"))
import bounded_inspect as inspect


class BoundedInspectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bi-")
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def file(self, name, content):
        path = self.root / name
        path.write_text(content, encoding="utf-8")
        return path

    def emit(self, *selections, **kwargs):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            returned = inspect.emit(*selections, **kwargs)
        self.assertIsNone(returned)
        rendered = stream.getvalue()
        self.last_output = rendered
        result = json.loads(rendered, parse_float=Decimal)
        self.assertEqual(result["output_bytes"], len(rendered.encode("utf-8")))
        self.assertLessEqual(result["output_bytes"], kwargs.get("max_bytes", 4096))
        self.assertLessEqual(result["source_bytes"], kwargs.get("max_source_bytes", 65536))
        return result

    def test_lazy_ten_excerpts_shared_budget_and_unicode_cursor(self):
        # Exactly 100 KiB before the newline; each scalar takes four UTF-8 bytes.
        line = "😀" * 25600 + "\n"
        paths = [self.file(f"log-{i}.txt", line if i == 0 else 'quote" slash\\\n' * 1000) for i in range(10)]
        with patch("builtins.open", side_effect=AssertionError("eager read")):
            selections = [inspect.text(path, head_lines=1) for path in paths]
        result = self.emit(*selections, max_bytes=4096, max_source_bytes=8192)
        self.assertGreater(result["omitted"]["count"], 0)
        self.assertEqual(result["source_bytes"], 8192)
        first = result["items"][0]
        self.assertEqual(first["range"]["bytes"][0], 0)
        cursors = [first["next"]["offset"]]
        chunks = [first["text"]]
        source_work = result["source_bytes"]
        for _ in range(200):
            result = self.emit(inspect.text(paths[0], cursor=first["next"]), max_bytes=4096, max_source_bytes=8192)
            first = result["items"][0]
            chunks.append(first["text"])
            source_work += result["source_bytes"]
            if first["next"] is None:
                self.assertEqual(first["status"], "complete")
                break
            self.assertGreater(first["next"]["offset"], cursors[-1])
            cursors.append(first["next"]["offset"])
        else:
            self.fail("cursor did not finish")
        self.assertEqual("".join(chunks), line)
        print("bounded-inspect-measurement", json.dumps({"fixture": "100KiB-unicode-cursor",
              "pages": len(chunks), "first_offsets": cursors[:3], "last_offset": cursors[-1],
              "source_bytes_all_pages": source_work, "selected_payload_bytes": len(line.encode())}))

    def test_changed_and_replaced_versions_refuse_without_reading(self):
        path = self.file("changing.txt", "x" * 9000)
        cursor = self.emit(inspect.text(path))["items"][0]["next"]
        with path.open("a") as handle:
            handle.write("new")
        changed = self.emit(inspect.text(path, cursor=cursor))
        self.assertEqual(changed["items"][0]["status"], "changed_source")
        self.assertEqual(changed["source_bytes"], 0)
        cursor = self.emit(inspect.text(path))["items"][0]["next"]
        replacement = self.file("replacement", path.read_text())
        replacement.replace(path)
        replaced = self.emit(inspect.text(path, cursor=cursor))
        self.assertEqual(replaced["items"][0]["status"], "changed_source")
        self.assertEqual(replaced["source_bytes"], 0)

    def test_head_range_seeking_and_bounded_tail(self):
        path = self.file("lines", "alpha\nbeta\ngamma\ndelta\n")
        self.assertEqual(self.emit(inspect.text(path, head_lines=2))["items"][0]["text"], "alpha\nbeta\n")
        self.assertEqual(self.emit(inspect.text(path, start_line=2, end_line=3))["items"][0]["text"], "beta\ngamma\n")
        seeking = self.emit(inspect.text(path, start_line=4, end_line=4), max_source_bytes=8)["items"][0]
        self.assertEqual(seeking["status"], "seeking")
        positions = [seeking["next"]["offset"]]
        while seeking["status"] == "seeking":
            seeking = self.emit(inspect.text(path, cursor=seeking["next"]), max_source_bytes=8)["items"][0]
            if seeking["next"]:
                self.assertGreater(seeking["next"]["offset"], positions[-1])
                positions.append(seeking["next"]["offset"])
        self.assertTrue(seeking["text"].startswith("delta"))
        large = self.file("large", "prefix\n" * 100000 + "last-one\nlast-two\n")
        tail = self.emit(inspect.text(large, tail_lines=2), max_source_bytes=1024)
        self.assertEqual(tail["source_bytes"], 1024)
        self.assertEqual(tail["items"][0]["text"], "last-one\nlast-two\n")
        self.assertIsNone(tail["items"][0]["range"]["line"])
        unicode = self.file("unicode-tail", "😀" * 50000)
        suffix = self.emit(inspect.text(unicode, tail_lines=2), max_source_bytes=101)
        self.assertEqual(suffix["source_bytes"], 101)
        self.assertIn("tail_prefix_unread", suffix["items"][0]["warnings"][0])
        self.assertEqual(suffix["items"][0]["status"], "tail_window_limit")
        self.assertEqual(suffix["items"][0]["range"]["bytes"], [199900, 200000])

    def test_json_source_cap_metadata_missing_errors_and_complete_scalars(self):
        data = {"run": "control-B", "config": "matched-30min", "seed": 7, "eligible": False,
                "failures": ["numerical failure"], "units": {"wall": "s", "loss": "nats"},
                "wall": 1800, "validation": None, "skips": 3, "note": 'quote"\n😀', "a/b": {"~key": 9}}
        path = self.file("metrics.json", json.dumps(data))
        pointers = ["/" + key for key in data if key != "a/b"] + ["/unavailable", "/a~1b/~0key"]
        result = self.emit(inspect.json_fields(path, pointers=pointers))
        fields = {field["pointer"]: field for field in result["items"][0]["fields"]}
        for key in data:
            if key != "a/b":
                self.assertEqual(fields["/" + key]["value"], data[key])
        self.assertEqual(fields["/unavailable"]["status"], "missing")
        self.assertEqual(fields["/a~1b/~0key"]["value"], 9)
        self.assertEqual(result["source_bytes"], path.stat().st_size)
        capped = self.emit(inspect.json_fields(path, pointers=["/run"], max_source_bytes=10))
        self.assertEqual(capped["items"][0]["status"], "source_limit")
        self.assertEqual(capped["source_bytes"], 0)
        invalid = self.file("partial.json", '{"run":')
        errors = self.emit(inspect.json_fields(invalid, pointers=["/run"]), inspect.json_fields(self.root / "missing", pointers=["/run"]))
        self.assertEqual([i["status"] for i in errors["items"]], ["invalid_json", "unavailable"])
        huge = self.file("huge.json", json.dumps({"big": "😀" * 2000, "seed": 7}))
        limited = self.emit(inspect.json_fields(huge, pointers=["/big", "/seed"]))["items"][0]
        self.assertEqual(limited["fields"][0], {"pointer": "/big", "status": "value_limit"})
        self.assertEqual(limited["fields"][1]["value"], 7)

    def test_read_counter_matches_unbuffered_io_and_shared_cap(self):
        paths = [self.file(str(i), "sample\n" * 20) for i in range(3)]
        actual = []
        original_open = open
        class Counted:
            def __init__(self, *args, **kwargs):
                self.file = original_open(*args, **kwargs)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.file.close()
            def __getattr__(self, name):
                return getattr(self.file, name)
            def read(self, count):
                result = self.file.read(count)
                actual.append(len(result))
                return result
        with patch("builtins.open", Counted):
            result = self.emit(*(inspect.text(path, head_lines=1) for path in paths), max_source_bytes=200)
        self.assertEqual(result["source_bytes"], sum(actual))
        self.assertEqual(result["source_bytes"], 200)
        self.assertEqual(sum(item["source_bytes"] for item in result["items"]), 200)

    def test_tiny_budget_utf8_boundary_refusal_and_invalid_json_numbers(self):
        path = self.file("😀\"" * 30, "😀" * 10)
        tiny = self.emit(inspect.text(path), max_bytes=128)
        self.assertEqual(tiny["status"], "output_limit")
        self.assertEqual(tiny["source_bytes"], 0)
        path = self.file("unicode", "😀" * 10)
        limit = self.emit(inspect.text(path), max_source_bytes=3)["items"][0]
        self.assertEqual(limit["status"], "source_limit")
        self.assertIsNone(limit["next"])
        for scalar in ("NaN", "Infinity", "-Infinity"):
            invalid = self.file("nonfinite", scalar)
            self.assertEqual(self.emit(inspect.json_fields(invalid, pointers=[""]))["items"][0]["status"], "invalid_json")

    def test_lossless_numeric_tokens_in_selected_scalars_and_nested_objects(self):
        numbers = ["1e-400", "1.00000000000000000001", "1e309", "1e9999", "-0", "42"]
        nested = '{"numbers":[' + ",".join(numbers) + '],"string":"1e309","int":7,"null":null,"bool":false}'
        path = self.file("numbers.json", '{"selected":' + nested + '}')
        result = self.emit(inspect.json_fields(path, pointers=["/selected/numbers/0", "/selected"]))
        item = result["items"][0]
        self.assertEqual(item["status"], "complete")
        self.assertEqual(item["fields"][0]["value"], Decimal("1e-400"))
        value = item["fields"][1]["value"]
        self.assertEqual(value["numbers"], [Decimal(token) for token in numbers])
        self.assertIs(type(value["int"]), int)
        self.assertEqual(value["string"], "1e309")
        self.assertIsNone(value["null"])
        self.assertIs(value["bool"], False)
        self.assertIn('"value":' + nested, self.last_output)
        self.assertIn('"value":1e-400', self.last_output)
        self.assertEqual(result["source_bytes"], path.stat().st_size)
        # A valid number can exceed Python's integer conversion limit, too.
        integer = "9" * 5000
        big = self.file("integer.json", integer)
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            inspect.emit(inspect.json_fields(big, pointers=[""]), max_bytes=8192)
        rendered = stream.getvalue()
        decoded = json.loads(rendered, parse_int=str)
        self.assertEqual(decoded["items"][0]["fields"][0]["value"], integer)
        self.assertIn('"value":' + integer, rendered)
        self.assertEqual(int(decoded["output_bytes"]), len(rendered.encode("utf-8")))
        limited = self.emit(inspect.json_fields(big, pointers=[""]))
        self.assertEqual(limited["items"][0]["fields"], [{"pointer": "", "status": "value_limit"}])

    def test_standalone_stdlib_script_and_one_off_control(self):
        path = self.file("small", "tiny\n")
        # Existing direct one-off control has no watcher, capsule, or skill setup.
        direct = subprocess.run([sys.executable, "-I", "-c", "from pathlib import Path; print(Path(__import__('sys').argv[1]).read_text(), end='')", str(path)], capture_output=True, check=True)
        self.assertEqual(direct.stdout, b"tiny\n")
        command = [sys.executable, "-I", str(Path(inspect.__file__)), "--max-bytes", "1024"]
        run = subprocess.run(command, input=json.dumps([{"kind": "text", "path": str(path)}]).encode(), capture_output=True, check=True)
        result = json.loads(run.stdout)
        self.assertEqual(result["output_bytes"], len(run.stdout))
        self.assertEqual(result["items"][0]["text"], "tiny\n")
        self.assertEqual(run.stderr, b"")


if __name__ == "__main__":
    unittest.main(verbosity=2)
