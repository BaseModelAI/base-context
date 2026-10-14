from __future__ import annotations

import itertools
import os
import tempfile
import unittest
from dataclasses import FrozenInstanceError
from decimal import Decimal, localcontext
from fractions import Fraction
from pathlib import Path, PureWindowsPath
from unittest import mock

from rlm.workflow import _delivery_declarations, _relative_file, bounded_search, stage_delivery


class StageDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.destination = self.root / "delivery"
        (self.workspace / "bin").mkdir()
        (self.workspace / "bin/run").write_text("#!/bin/sh\necho ready\n")
        (self.workspace / "bin/run").chmod(0o751)
        (self.workspace / "data.txt").write_text("data")
        (self.workspace / "private.txt").write_text("not declared")

    def test_explicit_delivery_preserves_names_modes_and_unrelated_content(self):
        self.destination.mkdir()
        (self.destination / "existing.txt").write_text("keep")
        result = stage_delivery(
            self.workspace, self.destination, ["bin/run", "./data.txt"],
            {"bin/run": ["data.txt"]},
        )
        self.assertEqual(result.workspace, str(self.workspace.resolve()))
        self.assertEqual(result.destination, str(self.destination.resolve()))
        self.assertEqual(result.files, ("bin/run", "data.txt"))
        self.assertEqual(result.dependencies, (("bin/run", ("data.txt",)),))
        self.assertEqual((self.destination / "data.txt").read_text(), "data")
        self.assertEqual((self.destination / "existing.txt").read_text(), "keep")
        self.assertFalse((self.destination / "private.txt").exists())
        if os.name == "posix":
            self.assertEqual((self.destination / "bin/run").stat().st_mode & 0o7777, 0o751)
        with self.assertRaises(FrozenInstanceError):
            result.files = ()

    def test_all_validation_precedes_copying(self):
        cases = [
            (["bin/run"], {"bin/run": ["data.txt"]}, ValueError),
            (["bin/run"], {"data.txt": []}, ValueError),
            (["bin/run", "missing.txt"], None, FileNotFoundError),
            (["bin/run", "bin"], None, ValueError),
            (["bin/run", "../outside"], None, ValueError),
            (["bin/run", str(self.workspace / "data.txt")], None, ValueError),
            (["bin/run", "./bin/run"], None, ValueError),
            (["bin/run", ""], None, ValueError),
            (["bin/run", "bad\x00name"], None, ValueError),
            (["bin/run"], {"bin/run": "data.txt"}, TypeError),
        ]
        for files, dependencies, error in cases:
            with self.subTest(files=files, dependencies=dependencies):
                with self.assertRaises(error):
                    stage_delivery(self.workspace, self.destination, files, dependencies)
                self.assertFalse(self.destination.exists())

    def test_windows_file_names_reject_drive_and_root_anchors(self):
        with mock.patch("rlm.workflow.Path", PureWindowsPath):
            for name in ("C:artifact.txt", "D:artifact.txt", r"\artifact.txt", "/artifact.txt", r"C:\artifact.txt"):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    _relative_file(name)
            self.assertEqual(_relative_file(r"dir\artifact.txt"), "dir/artifact.txt")
            self.assertEqual(_relative_file("./artifact.txt"), "artifact.txt")

    def test_windows_declaration_identity_and_canonical_dependency_spelling(self):
        with mock.patch("rlm.workflow.Path", PureWindowsPath):
            cases = [
                (["artifact.txt", "ARTIFACT.TXT"], None),
                (["artifact.txt", "ARTIFACT.TXT/child"], None),
                (["ARTIFACT.TXT/child", "artifact.txt"], None),
                (["artifact.txt"], {"artifact.txt": [], "ARTIFACT.TXT": []}),
                (["artifact.txt"], {"ARTIFACT.TXT": ["missing.txt"]}),
            ]
            for files, dependencies in cases:
                with self.subTest(files=files, dependencies=dependencies), self.assertRaises(ValueError):
                    _delivery_declarations(files, dependencies)
            names, dependencies = _delivery_declarations(
                ["Bin/Run", "Data.txt"], {r"BIN\RUN": ["data.TXT"]},
            )
            self.assertEqual(names, ("Bin/Run", "Data.txt"))
            self.assertEqual(dependencies, (("Bin/Run", ("Data.txt",)),))

    @unittest.skipUnless(os.name == "posix", "requires POSIX native path identity")
    def test_posix_case_distinct_declarations_remain_distinct(self):
        (self.workspace / "DATA.txt").write_text("uppercase")
        result = stage_delivery(
            self.workspace, self.destination, ["data.txt", "DATA.txt"],
            {"data.txt": ["DATA.txt"], "DATA.txt": []},
        )
        self.assertEqual(result.files, ("data.txt", "DATA.txt"))
        self.assertEqual(result.dependencies, (("data.txt", ("DATA.txt",)), ("DATA.txt", ())))
        self.assertEqual((self.destination / "data.txt").read_text(), "data")
        self.assertEqual((self.destination / "DATA.txt").read_text(), "uppercase")
        self.assertEqual(
            _delivery_declarations(["artifact", "ARTIFACT/child"], None),
            (("artifact", "ARTIFACT/child"), ()),
        )

    def test_collision_never_overwrites_or_copies_earlier_files(self):
        self.destination.mkdir()
        (self.destination / "data.txt").write_text("original")
        with self.assertRaises(FileExistsError):
            stage_delivery(self.workspace, self.destination, ["bin/run", "data.txt"])
        self.assertFalse((self.destination / "bin").exists())
        self.assertEqual((self.destination / "data.txt").read_text(), "original")

    def test_parent_file_collision_and_empty_delivery(self):
        self.destination.mkdir()
        (self.destination / "bin").write_text("not a directory")
        with self.assertRaises(NotADirectoryError):
            stage_delivery(self.workspace, self.destination, ["data.txt", "bin/run"])
        self.assertFalse((self.destination / "data.txt").exists())
        empty_target = self.root / "empty"
        self.assertEqual(stage_delivery(self.workspace, empty_target, []).files, ())
        self.assertFalse(empty_target.exists())

    @unittest.skipUnless(os.name == "posix", "requires symlinks")
    def test_source_symlinks_stay_inside_workspace_and_outputs_reject_symlinks(self):
        outside = self.root / "outside.txt"
        outside.write_text("outside")
        (self.workspace / "escape").symlink_to(outside)
        with self.assertRaises(ValueError):
            stage_delivery(self.workspace, self.destination, ["bin/run", "escape"])
        self.assertFalse(self.destination.exists())
        (self.workspace / "alias").symlink_to(self.workspace / "data.txt")
        stage_delivery(self.workspace, self.destination, ["alias"])
        self.assertEqual((self.destination / "alias").read_text(), "data")
        self.assertFalse((self.destination / "alias").is_symlink())
        (self.destination / "bin").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            stage_delivery(self.workspace, self.destination, ["data.txt", "bin/run"])
        self.assertFalse((self.destination / "data.txt").exists())
        (self.destination / "data.txt").symlink_to(self.root / "missing")
        with self.assertRaises(FileExistsError):
            stage_delivery(self.workspace, self.destination, ["data.txt"])


class BoundedSearchTest(unittest.TestCase):
    def test_depth_first_pruning_lexicographic_ties_and_exact_comparison(self):
        expanded = []
        tree = {"root": ["pruned", "branch", "tie"], "branch": ["first", "second"]}
        scores = {
            "first": (10**80, Decimal("0.1000000000000000000000000001")),
            "second": (10**80, Fraction(1, 10)),
            "tie": (10**80, Decimal("0.1000000000000000000000000001")),
        }

        def expand(state):
            expanded.append(state)
            return iter(tree[state])

        with localcontext() as context:
            context.prec = 2
            result = bounded_search(
                ["root"], expand=expand, feasible=lambda s: s != "pruned",
                complete=lambda s: s in scores, objective=scores.__getitem__, max_states=20,
            )
        self.assertEqual(expanded, ["root", "branch"])
        self.assertEqual((result.state, result.objective), ("first", scores["first"]))
        self.assertEqual((result.visited, result.exhausted), (6, True))
        with self.assertRaises(FrozenInstanceError):
            result.visited = 0

    def test_extreme_decimal_exponents_compare_without_rational_expansion(self):
        huge = Decimal("1e999999999999999999")
        tiny = Decimal("1e-999999999999999999")
        negative = Decimal("-1e999999999999999999")
        options = dict(expand=lambda s: (), feasible=lambda s: True,
                       complete=lambda s: True, objective=lambda s: (s,))
        first = bounded_search([huge], max_states=1, **options)
        self.assertIs(first.state, huge)
        self.assertFalse(first.exhausted)
        with localcontext() as context:
            context.prec = 2
            values = [Fraction(1, 3), tiny, 0, huge, negative]
            maximum = bounded_search(values, max_states=10, **options)
            minimum = bounded_search(values, max_states=10, maximize=False, **options)
        self.assertIs(maximum.state, huge)
        self.assertIs(minimum.state, negative)
        self.assertTrue(maximum.exhausted)
        self.assertTrue(minimum.exhausted)

    def test_minimize_empty_no_feasible_and_none_state(self):
        options = dict(expand=lambda s: (), feasible=lambda s: True,
                       complete=lambda s: True, objective=lambda s: (s,), max_states=10)
        result = bounded_search([3, 1, 2], maximize=False, **options)
        self.assertEqual((result.state, result.objective, result.exhausted), (1, (1,), True))
        result = bounded_search([], **options)
        self.assertEqual((result.state, result.objective, result.visited, result.exhausted),
                         (None, None, 0, True))
        options["feasible"] = lambda s: False
        result = bounded_search([1, 2], **options)
        self.assertEqual((result.objective, result.visited, result.exhausted), (None, 2, True))
        options.update(feasible=lambda s: True, objective=lambda s: ())
        result = bounded_search([None], **options)
        self.assertEqual((result.state, result.objective), (None, ()))

    def test_infinite_child_iterator_is_bounded_without_lookahead(self):
        pulled = []

        def children(state):
            for index in itertools.count():
                pulled.append(index)
                yield index

        result = bounded_search(
            ["root"], expand=children, feasible=lambda s: True,
            complete=lambda s: s != "root", objective=lambda s: (s,), max_states=4,
        )
        self.assertEqual(pulled, [0, 1, 2])
        self.assertEqual((result.state, result.visited, result.exhausted), (2, 4, False))

    def test_zero_budget_and_last_candidate_do_not_expand_or_look_ahead(self):
        def forbidden(*args):
            self.fail("work beyond candidate budget")

        class Untouched:
            def __iter__(self):
                forbidden()

        options = dict(expand=forbidden, feasible=forbidden, complete=forbidden,
                       objective=forbidden)
        result = bounded_search(Untouched(), max_states=0, **options)
        self.assertEqual((result.visited, result.exhausted), (0, False))
        options.update(feasible=lambda s: True, complete=lambda s: False)
        result = bounded_search(["partial"], max_states=1, **options)
        self.assertEqual((result.objective, result.visited, result.exhausted), (None, 1, False))
        options.update(complete=lambda s: True, objective=lambda s: (1,))
        result = bounded_search(["terminal"], max_states=1, **options)
        self.assertEqual((result.state, result.exhausted), ("terminal", False))

    def test_invalid_objectives_and_budgets_are_rejected(self):
        options = dict(expand=lambda s: (), feasible=lambda s: True,
                       complete=lambda s: True, objective=lambda s: s, max_states=10)
        cases = [((1.0,), TypeError), ((float("nan"),), TypeError),
                 ((True,), TypeError), ((Decimal("NaN"),), ValueError),
                 ((Decimal("sNaN"),), ValueError), ((Decimal("Infinity"),), ValueError),
                 ([1], TypeError), (("1",), TypeError)]
        for score, error in cases:
            with self.subTest(score=score), self.assertRaises(error):
                bounded_search([score], **options)
        with self.assertRaises(ValueError):
            bounded_search([(1,), (2, 3)], **options)
        for budget in (-1, True, 1.5):
            options["max_states"] = budget
            with self.subTest(budget=budget), self.assertRaises(ValueError):
                bounded_search([], **options)


if __name__ == "__main__":
    unittest.main()
