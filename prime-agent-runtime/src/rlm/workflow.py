"""Explicit delivery staging and bounded, caller-owned search.

These helpers make no host, model, or network calls. They run only when called.
"""

from __future__ import annotations

import os
import shutil
import stat
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from typing import Generic, NotRequired, TypedDict, TypeVar

State = TypeVar("State")
ExactNumber = int | Decimal | Fraction
Objective = tuple[ExactNumber, ...]


class TaskArtifact(TypedDict):
    path: str
    dependencies: NotRequired[list[str]]


class TaskDelivery(TypedDict):
    workspace: str
    consumer_root: NotRequired[str]
    mode: NotRequired[str]
    files: list[TaskArtifact]


@dataclass(frozen=True)
class DeliveryStage:
    workspace: str
    destination: str
    files: tuple[str, ...]
    dependencies: tuple[tuple[str, tuple[str, ...]], ...]


@dataclass(frozen=True)
class SearchResult(Generic[State]):
    state: State | None
    objective: Objective | None
    visited: int
    exhausted: bool


def _relative_file(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("file paths must be strings")
    path = Path(value)
    if not value or "\x00" in value or path.anchor or ".." in path.parts or path == Path("."):
        raise ValueError(f"expected a workspace-relative file path: {value!r}")
    return path.as_posix()


def _file_names(values: Sequence[str]) -> tuple[str, ...]:
    if isinstance(values, (str, bytes)):
        raise TypeError("file paths must be a sequence of strings, not one string")
    return tuple(_relative_file(value) for value in values)


def _delivery_declarations(
    files: Sequence[str],
    dependencies: Mapping[str, Sequence[str]] | None,
) -> tuple[tuple[str, ...], tuple[tuple[str, tuple[str, ...]], ...]]:
    names = _file_names(files)
    declared = {Path(name): name for name in names}
    if len(declared) != len(names):
        raise ValueError("files contains duplicate native paths")
    for path in declared:
        if any(parent in declared for parent in path.parents):
            raise ValueError(f"declared file is also an output directory: {path}")
    dependency_items: list[tuple[str, tuple[str, ...]]] = []
    dependency_keys: set[Path] = set()
    for raw_name, raw_requires in (dependencies.items() if dependencies is not None else ()):
        path = Path(_relative_file(raw_name))
        requires = tuple(Path(name) for name in _file_names(raw_requires))
        if path in dependency_keys:
            raise ValueError(f"duplicate native dependency key: {path}")
        dependency_keys.add(path)
        if path not in declared or any(required not in declared for required in requires):
            raise ValueError(f"all dependency keys and values must be included in files: {path}")
        dependency_items.append((declared[path], tuple(declared[required] for required in requires)))
    return names, tuple(dependency_items)


def _check_output_directory(path: Path) -> None:
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ValueError(f"output directories must not be symlinks: {component}")
        if component.exists() and not component.is_dir():
            raise NotADirectoryError(str(component))


def stage_delivery(
    workspace: str | os.PathLike[str] | TaskDelivery,
    destination: str | os.PathLike[str],
    files: Sequence[str] | None = None,
    dependencies: Mapping[str, Sequence[str]] | None = None,
) -> DeliveryStage:
    """Copy exactly the declared files, with their workspace-relative names.

    Pass either explicit workspace/files/dependencies, or a
    ``task_contract["delivery"]`` object as the first argument. The latter uses
    its workspace and each file's path/dependencies without adding sidecars.
    Destination is always explicit: consumer_root and mode describe the final
    consumer, not a local directory to overwrite or an execution authorization.
    This copies declarations; it does not discover or expand transfer rules.

    Files and dependency keys/values are relative strings. Anchored paths
    (including drive-relative or rooted-only paths on Windows), parent traversal,
    duplicate native file names, file/directory conflicts, and undeclared
    dependency keys/values are rejected. Name identity follows native pathlib
    rules. Returned dependency names use their corresponding declared file's
    normalized spelling. Dependency descriptions are caller declarations, not
    import scans; dependencies of dependencies must also be in ``files``.
    Source symlinks may resolve to regular files inside the resolved workspace.
    Destination directories must not use symlinks. Existing output leaves are
    always rejected, including identical files; unrelated destination content
    is retained. All declarations, sources, and output paths are checked before
    creating anything. Copies preserve ordinary permission bits, including
    executability, but not setuid/setgid bits or timestamps.

    Per-volume aliases beyond native pathlib rules are not detected. Filesystem
    changes must not race this operation. An I/O error during copying can leave
    a partial delivery; there is no atomicity, rollback, or destination cleanup.
    The frozen result uses absolute workspace/destination roots and relative
    file/dependency names. An empty declaration creates no directories.
    """
    if isinstance(workspace, Mapping):
        if files is not None or dependencies is not None:
            raise ValueError("delivery contract cannot be combined with files/dependencies overrides")
        delivery = workspace
        workspace = delivery["workspace"]
        files = [artifact["path"] for artifact in delivery["files"]]
        dependencies = {
            artifact["path"]: artifact["dependencies"]
            for artifact in delivery["files"] if "dependencies" in artifact
        }
    if files is None:
        raise TypeError("files is required without a delivery contract")
    root = Path(workspace).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise NotADirectoryError(str(root))
    target = Path(destination).expanduser().absolute()
    _check_output_directory(target)
    target = target.resolve()
    names, dependency_items = _delivery_declarations(files, dependencies)

    sources: list[tuple[Path, Path, int]] = []
    for name in names:
        source = (root / name).resolve(strict=True)
        if not source.is_relative_to(root):
            raise ValueError(f"source escapes workspace: {name}")
        source_stat = source.stat()
        if not stat.S_ISREG(source_stat.st_mode):
            raise ValueError(f"source is not a regular file: {name}")
        output = target / name
        _check_output_directory(output.parent)
        if output.exists() or output.is_symlink():
            raise FileExistsError(str(output))
        sources.append((source, output, source_stat.st_mode & 0o777))

    for source, output, mode in sources:
        output.parent.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as reader, output.open("xb") as writer:
            shutil.copyfileobj(reader, writer)
        output.chmod(mode)
    return DeliveryStage(str(root), str(target), names, dependency_items)


def _validate_objective(value: Objective, length: int | None) -> None:
    if not isinstance(value, tuple):
        raise TypeError("objective must return a tuple")
    if length is not None and len(value) != length:
        raise ValueError("objective tuples must have a fixed length")
    for number in value:
        if type(number) not in (int, Decimal, Fraction):
            raise TypeError("objective values must be int, Decimal, or Fraction (not bool or float)")
        if isinstance(number, Decimal) and not number.is_finite():
            raise ValueError("objective values must be finite")


def bounded_search(
    initial: Iterable[State],
    *,
    expand: Callable[[State], Iterable[State]],
    feasible: Callable[[State], bool],
    complete: Callable[[State], bool],
    objective: Callable[[State], Objective],
    max_states: int,
    maximize: bool = True,
) -> SearchResult[State]:
    """Search roots and children lazily in depth-first, iterable order.

    ``initial`` is an iterable of root states; use ``[root]`` for one root.
    Every pulled candidate counts as one visited state, including infeasible
    candidates. ``feasible`` runs before ``complete`` or ``expand``; false
    prunes the entire subtree. Only complete feasible states get an objective,
    and complete states are terminal. Objectives must be fixed-length tuples
    (possibly empty) of built-in int, finite Decimal, or Fraction values.
    Floats, bools, nonfinite values, and changing tuple lengths are errors.
    Native comparisons are exact and lexicographic, independent of Decimal context.
    The first equal-score incumbent wins; its original objective is returned.

    ``max_states`` is a nonnegative built-in int, excluding bool. Zero performs
    no iteration or callbacks. At the limit, no expansion or iterator lookahead
    occurs: ``exhausted=False`` even if the last visited candidate was the last
    available one. ``exhausted=True`` means every iterator ended before the
    limit, not that the caller's feasibility predicate is a valid global bound.
    Empty/all-infeasible searches return state=None, objective=None. Objective
    None distinguishes no incumbent even when a valid state itself is None.

    The bound limits candidates, not callback time. Callbacks and iterator
    steps must terminate. States and iterators remain caller-owned: there are
    no copies, retries, deduplication, or automatic iterator closing. Exceptions
    propagate. Memory is proportional to search depth, not child count.
    """
    if type(max_states) is not int or max_states < 0:
        raise ValueError("max_states must be a nonnegative int, not bool")
    if type(maximize) is not bool:
        raise TypeError("maximize must be bool")
    best_state: State | None = None
    best_objective: Objective | None = None
    visited = 0
    if max_states == 0:
        return SearchResult(None, None, 0, False)
    stack = [iter(initial)]
    while stack:
        if visited == max_states:
            return SearchResult(best_state, best_objective, visited, False)
        try:
            state = next(stack[-1])
        except StopIteration:
            stack.pop()
            continue
        visited += 1
        if not feasible(state):
            continue
        if complete(state):
            score = objective(state)
            _validate_objective(score, None if best_objective is None else len(best_objective))
            if best_objective is None or (score > best_objective if maximize else score < best_objective):
                best_state, best_objective = state, score
        elif visited < max_states:
            stack.append(iter(expand(state)))
    return SearchResult(best_state, best_objective, visited, True)
