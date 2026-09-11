#!/usr/bin/env python3
"""Prepare local H 0.9.3 or public Prime Agent 0.9.4 with a frozen native Base Context host."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HOSTS_SCHEMA = "prime-context.python-realworld-hosts/v2"
H_VERSION = "0.9.3"
H_PACKAGES = ("pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui")
PUBLIC_VERSION = "0.9.4"
# Release archive/metadata names differ from the compiled dependency import keys.
PUBLIC_PACKAGES = {
    "prime-agent": "prime-agent",
    "@earendil-works/pi-agent-core": "prime-agent-core",
    "@earendil-works/pi-ai": "prime-agent-ai",
    "@earendil-works/pi-tui": "prime-agent-tui",
}
NATIVE_PACKAGES = ("base-context", "base-context-agent", "base-context-ai", "base-context-tui")
CORE_SCOPES = ("@earendil-works", "@ponythewhite")
CLI_PATH = "dist/bundle/cli.js"
NODE_FLAGS = ("--experimental-sqlite", "--disable-warning=ExperimentalWarning", "--max-old-space-size=8192")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def require_node(node: Path) -> tuple[Path, str]:
    node = node.expanduser()
    if not node.is_absolute():
        raise ValueError("--node must be an absolute executable path")
    node = node.resolve(strict=True)
    if not node.is_file() or not os.access(node, os.X_OK):
        raise ValueError(f"not an executable Node path: {node}")
    result = subprocess.run(
        [str(node), "--version"], env={}, text=True, capture_output=True, check=True, timeout=20,
    )
    version = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", result.stdout.strip())
    if not version or tuple(map(int, version.groups())) < (22, 8, 0):
        raise ValueError(f"Node >=22.8.0 is required; got {result.stdout.strip()!r}")
    return node, result.stdout.strip().removeprefix("v")


def read_h_artifacts(directory: Path) -> dict[str, tuple[Path, dict[str, Any]]]:
    packages = {}
    for short_name in H_PACKAGES:
        path = directory / f"earendil-works-{short_name}-{H_VERSION}.tgz"
        name = f"@earendil-works/{short_name}"
        with tarfile.open(path, "r:gz") as archive:
            metadata_file = archive.extractfile("package/package.json")
            if metadata_file is None:
                raise ValueError(f"missing package metadata: {path}")
            metadata = json.load(metadata_file)
            if metadata.get("name") != name or metadata.get("version") != H_VERSION:
                raise ValueError(f"expected {name}@{H_VERSION}: {path}")
            if any(member.name != "package" and not member.name.startswith("package/") for member in archive):
                raise ValueError(f"archive must contain only package/: {path}")
            if short_name == "pi-coding-agent":
                if metadata.get("bin", {}).get("pi") != CLI_PATH:
                    raise ValueError(f"unexpected H published bin: {path}")
                if not archive.getmember(f"package/{CLI_PATH}").isfile():
                    raise ValueError(f"missing H published entrypoint: {path}")
        packages[name] = (path, metadata)
    return packages


def read_public_artifacts(directory: Path) -> dict[str, tuple[Path, dict[str, Any]]]:
    packages = {}
    for import_key, name in PUBLIC_PACKAGES.items():
        path = directory / f"{name}-{PUBLIC_VERSION}.tgz"
        with tarfile.open(path, "r:gz") as archive:
            metadata_file = archive.extractfile("package/package.json")
            if metadata_file is None:
                raise ValueError(f"missing package metadata: {path}")
            metadata = json.load(metadata_file)
            if (metadata.get("name") != name or metadata.get("version") != PUBLIC_VERSION
                    or metadata.get("type") != "module"):
                raise ValueError(f"expected ESM {name}@{PUBLIC_VERSION}: {path}")
            if any(member.name != "package" and not member.name.startswith("package/") for member in archive):
                raise ValueError(f"archive must contain only package/: {path}")
            if not archive.getmember("package/dist/index.js").isfile():
                raise ValueError(f"missing public SDK entrypoint: {path}")
            if name == "prime-agent":
                if metadata.get("bin", {}).get("prime-agent") != CLI_PATH:
                    raise ValueError(f"unexpected public published bin: {path}")
                if not archive.getmember(f"package/{CLI_PATH}").isfile():
                    raise ValueError(f"missing public published entrypoint: {path}")
        packages[import_key] = (path, metadata)
    return packages


def read_candidate(candidate: Path, dependency_root: Path) -> tuple[str, dict[str, Path], dict[str, dict[str, Any]]]:
    inspection = read_json(candidate / "package-inspection.json")
    commit = inspection["commit"]
    roots = {}
    metadata = {}
    inspected_packages = {item["name"]: item for item in inspection["packages"]}
    for short_name in NATIVE_PACKAGES:
        name = f"@ponythewhite/{short_name}"
        package_root = Path(inspection["privateCoreRoots"][name]).resolve(strict=True)
        if not package_root.is_relative_to(candidate):
            raise ValueError(f"native core package is outside the frozen candidate: {package_root}")
        if (candidate / "node_modules" / name).resolve(strict=True) != package_root:
            raise ValueError(f"native core mapping is not private: {name}")
        package = read_json(package_root / "package.json")
        if package.get("name") != name or package.get("version") != inspected_packages[name]["version"]:
            raise ValueError(f"native package does not match package-inspection.json: {name}")
        roots[name] = package_root
        metadata[name] = package
    coding_root = roots["@ponythewhite/base-context"]
    build_info = read_json(coding_root / "dist/build-info.json")
    for info in (inspection["buildInfo"], build_info):
        if not commit or info.get("sourceDirty") is not False or info.get("sourceCommit") != commit:
            raise ValueError("candidate must be a clean build matching package-inspection.json commit")
    if Path(inspection["dependencyRoot"]).resolve(strict=True) != dependency_root:
        raise ValueError("frozen candidate dependency root does not match --dependency-root")
    if metadata["@ponythewhite/base-context"].get("bin", {}).get("base-context") != CLI_PATH:
        raise ValueError("unexpected native published bin")
    if not (coding_root / CLI_PATH).is_file():
        raise ValueError("missing native published entrypoint")
    return commit, roots, metadata


def require_dependencies(packages: dict[str, dict[str, Any]], dependency_root: Path) -> None:
    for package in packages.values():
        for name in package.get("dependencies", {}):
            if name in packages:
                continue
            if name.split("/", 1)[0] in CORE_SCOPES or name in PUBLIC_PACKAGES.values():
                raise ValueError(f"unmapped private core dependency: {name}")
            if not (dependency_root / name / "package.json").is_file():
                raise ValueError(f"missing installed dependency: {dependency_root / name}")


def link_dependencies(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True)
    for entry in sorted(source.iterdir()):
        if (entry.name.startswith(".") or entry.name in CORE_SCOPES
                or entry.name in PUBLIC_PACKAGES.values() or not entry.is_dir()):
            continue
        if entry.name.startswith("@"):
            scope = destination / entry.name
            scope.mkdir()
            for package in sorted(entry.iterdir()):
                if package.is_dir():
                    (scope / package.name).symlink_to(package.resolve(), target_is_directory=True)
        else:
            (destination / entry.name).symlink_to(entry.resolve(), target_is_directory=True)


def prepare_hosts(
    h_artifacts: Path | None, candidate_root: Path, dependency_root: Path, node: Path, root: Path,
    *, public_artifacts: Path | None = None,
) -> dict[str, Any]:
    """Use local artifacts only. The sole executed command is Node --version."""
    if (h_artifacts is None) == (public_artifacts is None):
        raise ValueError("provide exactly one of h_artifacts or public_artifacts")
    public = public_artifacts is not None
    artifact_root = Path(public_artifacts if public else h_artifacts).expanduser().resolve(strict=True)
    candidate_root = Path(candidate_root).expanduser().resolve(strict=True)
    dependency_root = Path(dependency_root).expanduser().resolve(strict=True)
    root = Path(root).expanduser().resolve()
    if root.exists():
        raise FileExistsError(f"host root must be fresh: {root}")
    for source in (artifact_root, candidate_root, dependency_root):
        if root.is_relative_to(source):
            raise ValueError(f"host root must be outside input directories: {source}")
    stock_packages = read_public_artifacts(artifact_root) if public else read_h_artifacts(artifact_root)
    commit, native_roots, native_metadata = read_candidate(candidate_root, dependency_root)
    require_dependencies({name: item[1] for name, item in stock_packages.items()}, dependency_root)
    require_dependencies(native_metadata, dependency_root)
    node, node_version = require_node(Path(node))

    root.mkdir(parents=True)
    modules = root / "node_modules"
    link_dependencies(dependency_root, modules)
    (modules / "@earendil-works").mkdir()
    stock_roots = {}
    for name, (archive_path, metadata) in stock_packages.items():
        destination = root / "unpacked" / metadata["name"].rsplit("/", 1)[-1]
        destination.mkdir(parents=True)
        with tarfile.open(archive_path, "r:gz") as archive:
            archive.extractall(destination, filter="data")
        package_root = destination / "package"
        (modules / name).symlink_to(package_root, target_is_directory=True)
        stock_roots[name] = package_root

    def host(kind: str, name: str, version: str, package_root: Path) -> dict[str, Any]:
        entrypoint = package_root / CLI_PATH
        return {
            "kind": kind,
            "package_name": name,
            "version": version,
            "package_root": str(package_root),
            "entrypoint": str(entrypoint),
            "argv": [str(node), *NODE_FLAGS, str(entrypoint)],
        }

    native_name = "@ponythewhite/base-context"
    stock_name = "prime-agent" if public else "@earendil-works/pi-coding-agent"
    manifest = {
        "schema": HOSTS_SCHEMA,
        "prepared_at": datetime.now(timezone.utc).isoformat(),
        "root": str(root),
        "node_executable": str(node),
        "node_version": node_version,
        "dependency_root": str(dependency_root),
        "candidate_commit": commit,
        "hosts": {
            "vanilla": host(
                "public-prime-agent" if public else "h093", stock_name,
                PUBLIC_VERSION if public else H_VERSION, stock_roots[stock_name],
            ),
            "current": host("native-base-context", native_name, native_metadata[native_name]["version"], native_roots[native_name]),
        },
    }
    (root / "hosts.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    artifacts = parser.add_mutually_exclusive_group(required=True)
    artifacts.add_argument("--h-artifacts", type=Path, help="directory containing the four local H 0.9.3 archives")
    artifacts.add_argument("--public-artifacts", type=Path, help="directory containing the four public Prime Agent 0.9.4 release archives")
    parser.add_argument("--candidate-root", type=Path, required=True, help="frozen native candidate with package-inspection.json")
    parser.add_argument("--dependency-root", type=Path, required=True, help="existing installed third-party node_modules directory")
    parser.add_argument("--node", type=Path, required=True, help="absolute Node >=22.8.0 executable")
    parser.add_argument("--root", type=Path, required=True, help="new host directory; existing directories are never replaced")
    args = parser.parse_args()
    manifest = prepare_hosts(
        args.h_artifacts, args.candidate_root, args.dependency_root, args.node, args.root,
        public_artifacts=args.public_artifacts,
    )
    print(f"prepared {Path(manifest['root']) / 'hosts.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
