"""Base Context-owned state paths and environment names.

The public ``rlm`` API and provider/IPC identifiers are independent of these
paths. Legacy product environment variables are never consulted.
"""

from __future__ import annotations

import os
from pathlib import Path

PRODUCT_NAME = "Base Context"
PRODUCT_DIRECTORY = ".base-context"
ENV_PREFIX = "BASE_CONTEXT"
_LEGACY_DIRECTORIES = (".prime", ".pi", ".prime-context")


def product_env(suffix: str) -> str | None:
    """Read a product-owned environment value, without legacy fallbacks."""
    return os.environ.get(f"{ENV_PREFIX}_{suffix}")


def assert_product_state_path(path: str | Path) -> Path:
    """Resolve a mutable product path, rejecting legacy roots and symlink aliases."""
    expanded = Path(path).expanduser().absolute()
    canonical = expanded.resolve()
    # Project-local legacy directories are isolated too, not just home stores.
    has_legacy_component = any(part in _LEGACY_DIRECTORIES for part in (*expanded.parts, *canonical.parts))
    aliases_legacy_home = any(
        canonical.is_relative_to((Path.home() / directory).resolve()) for directory in _LEGACY_DIRECTORIES
    )
    if has_legacy_component or aliases_legacy_home:
        raise ValueError(
            f"{PRODUCT_NAME} cannot use legacy state at {path}; choose a separate BASE_CONTEXT_HOME"
        )
    return canonical


def product_home() -> Path:
    """Global state root: BASE_CONTEXT_HOME or ~/.base-context, never ~/.prime."""
    raw = product_env("HOME")
    root = Path.home() / PRODUCT_DIRECTORY if raw is None else Path(raw).expanduser()
    if raw is not None and (not raw.strip() or not root.is_absolute()):
        raise ValueError("BASE_CONTEXT_HOME must be a non-empty absolute path (~/ is supported)")
    return assert_product_state_path(root)


def product_state_path(*parts: str) -> Path:
    """Resolve a global state file, including symlinks below the home root."""
    return assert_product_state_path(product_home().joinpath(*parts))


def project_state_dir(cwd: str | Path | None = None) -> Path:
    """Project state is always in .base-context, independent of legacy stores."""
    project = Path.cwd() if cwd is None else Path(cwd)
    return assert_product_state_path(project / PRODUCT_DIRECTORY)
