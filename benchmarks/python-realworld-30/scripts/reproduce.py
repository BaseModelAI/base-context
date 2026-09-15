#!/usr/bin/env python3
"""Prepare a local paired host offline, or explicitly admit a new paired run."""
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]


def load_preparer():
    spec = importlib.util.spec_from_file_location("prepare_hosts", BENCH / "prepare-hosts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def candidate(archives, dependencies, output, expected_commit, preparer):
    """Map the four built CURRENT packages into the existing candidate format."""
    output.mkdir(parents=True)
    wanted = {f"@ponythewhite/{name}" for name in preparer.NATIVE_PACKAGES}
    packages, roots = {}, {}
    for path in sorted(archives.glob("*.tgz")):
        with tarfile.open(path, "r:gz") as archive:
            metadata = json.load(archive.extractfile("package/package.json"))
            name = metadata.get("name")
            if name not in wanted:
                continue
            if name in packages:
                raise ValueError(f"More than one archive for {name}")
            destination = output / "unpacked" / name.split("/")[-1]
            archive.extractall(destination, filter="data")
            roots[name] = str(destination / "package")
            packages[name] = metadata
    if set(packages) != wanted:
        raise ValueError("Supply all four CURRENT package archives")
    preparer.link_dependencies(dependencies, output / "node_modules")
    (output / "node_modules/@ponythewhite").mkdir()
    for name, package_root in roots.items():
        (output / "node_modules" / name).symlink_to(package_root, target_is_directory=True)
    info = json.loads((Path(roots["@ponythewhite/base-context"]) / "dist/build-info.json").read_text())
    if info.get("sourceDirty") is not False or info.get("sourceCommit") != expected_commit:
        raise ValueError("CURRENT must be a clean build of --current-commit")
    inspection = {"commit": expected_commit, "privateCoreRoots": roots,
                  "packages": [{"name": name, "version": p["version"]} for name, p in packages.items()],
                  "buildInfo": info, "dependencyRoot": str(dependencies)}
    (output / "package-inspection.json").write_text(json.dumps(inspection, indent=2) + "\n")


def supported_node(version):
    parsed = tuple(map(int, version.split(".")))
    return (parsed[0] == 22 and parsed >= (22, 12, 0)) or parsed >= (23, 3, 0)


def require_node(node):
    executable, version = load_preparer().require_node(node)
    if not supported_node(version):
        raise ValueError("Use Node ^22.12.0 || >=23.3.0; the recorded run used 22.12.0")
    return executable


def prepare(args):
    prep = load_preparer()
    node = require_node(args.node)
    output = args.output.expanduser().resolve()
    if output.exists():
        raise ValueError("--output must be a fresh directory")
    dependencies = args.dependency_root.expanduser().resolve(strict=True)
    candidate(args.current_archives.expanduser().resolve(strict=True), dependencies,
              output / "candidate", args.current_commit, prep)
    hosts = prep.prepare_hosts(None, output / "candidate", dependencies, node,
                               output / "pristine", public_artifacts=args.stock_archives)
    subprocess.run([sys.executable, "-E", "-S", "-B", str(BENCH / "stock-accounting/apply_patch.py"),
                    "--source-host", str(output / "pristine"), "--output", str(output / "instrumented")], check=True)
    patch = json.loads((output / "instrumented/accounting-patch.json").read_text())
    vanilla = hosts["hosts"]["vanilla"]
    package = output / "instrumented/unpacked/prime-agent/package"
    vanilla.update(package_root=str(package), entrypoint=str(package / prep.CLI_PATH),
                   argv=[str(node), *prep.NODE_FLAGS, str(package / prep.CLI_PATH)], accounting_patch=patch)
    hosts["root"] = str(output)
    (output / "hosts.json").write_text(json.dumps(hosts, indent=2) + "\n")
    print(f"Prepared {output / 'hosts.json'} offline. Qualification and live admission are separate.")


# Existing public offline checks; no solver prompt or provider request is sent.
OFFLINE_CHECKS = [
    "test_harness.HarnessComparisonTests.test_shared_bash_workspace_devices_and_timeout_recovery",
    "test_harness.HarnessComparisonTests.test_native_prompt_completion_marker_is_host_scoped_and_exact",
    "test_harness.HarnessComparisonTests.test_current_terminal_invocation_error_does_not_advance_stage",
    "test_harness.HarnessComparisonTests.test_stock_retry_waits_for_sdk_idle_before_advancing",
    "test_harness.HarnessComparisonTests.test_stock_retry_start_rejection_is_terminal_only_at_idle",
    "test_cost_accounting.CostAccountingTests.test_happy_closed_physical_scope_and_raw_price_presence",
    "test_cost_accounting.CostAccountingTests.test_incomplete_failed_scope_and_synthetic_write_stay_unknown",
]


def qualify(args):
    sys.path.insert(0, str(BENCH))
    import run as harness
    args.variants = "current,vanilla"
    args.host_manifest = harness.apply_hosts_manifest(args)
    if args.host_manifest["candidate_commit"] != args.current_commit:
        raise ValueError("Prepared clean CURRENT archive does not match --current-commit")
    node = require_node(Path(args.host_manifest["node_executable"]))
    stock = args.hosts["vanilla"]
    if stock["package_name"] != "prime-agent" or stock["version"] != "0.9.4" or not stock.get("accounting_patch"):
        raise ValueError("Qualification requires the separate accounting-patched Prime Agent 0.9.4 host")
    if not args.bwrap:
        raise ValueError("Bubblewrap is required for offline qualification")
    args.provider, args.model, args.thinking = "openai-codex", "gpt-5.6-sol", "medium"
    with tempfile.TemporaryDirectory(prefix="paired-offline-") as directory:
        root = Path(directory)
        for variant in ("current", "vanilla"):
            run_dir = root / variant
            roots = harness.prepare_agent_home(run_dir, args, variant)
            workspace = run_dir / "workspace"
            workspace.mkdir()
            # Empty fixture mount only. Never locate, stat or read the user's credentials.
            empty_auth = run_dir / "empty-auth.json"
            empty_auth.write_text("{}")
            args.host_openai_codex_auth_file = args.host_deepseek_api_key_file = empty_auth
            package = Path(args.hosts[variant]["package_root"])
            options = {"variant": variant, "cwd": "/workspace" if variant == "current" else str(workspace),
                       "agentDir": str(roots["config"]), "sessionDir": str(roots["sessions"]), "thinkingLevel": "medium"}
            bootstrap = run_dir / "offline-rpc.mjs"
            bootstrap.write_text(
                f"import * as host from {json.dumps((package / 'dist/index.js').as_uri())};\n"
                f"import {{ runConfiguredRpc }} from {json.dumps((BENCH / 'subscription-rpc.mjs').as_uri())};\n"
                "const auth = host.AuthStorage.inMemory({}, { usePrimeCliConfig: false });\n"
                f"const registry = host.ModelRegistry.create(auth, {json.dumps(str(roots['config'] / 'models.json'))});\n"
                "const model = registry.find('openai-codex', 'gpt-5.6-sol');\n"
                "if (!model) throw new Error('Prepared SDK lacks the exact local Sol model');\n"
                f"await runConfiguredRpc(host, {json.dumps(options)}, auth, registry, model, {{\n"
                "id: 'offline-qualification', url: 'https://chatgpt.com/backend-api/codex/responses',\n"
                "authMode: 'existing-openai-codex-subscription',\n"
                "templateRevision: 'base-context-codex-responses/1', replayFamily: 'responses-replay-v1' });\n"
            )
            command = [*args.hosts[variant]["argv"][:-1], str(bootstrap)]
            isolated = harness.isolated_agent_command(command, args.hosts[variant], run_dir, args)
            isolated.insert(1, "--unshare-net")
            environment = harness.clean_environment(roots["config"], roots["home"], variant=variant,
                                                     node=node, tmpdir=Path("/tmp"))
            environment["PRIME_CONTEXT_BENCHMARK_SHELL"] = str(roots["launcher"])
            sidecar = run_dir / "offline-accounting.jsonl"
            if variant == "vanilla":
                environment["PRIME_COST_ACCOUNTING_PATH"] = str(sidecar)
            result = subprocess.run(isolated, input='{"id":"offline-state","type":"get_state"}\n',
                                    text=True, capture_output=True, timeout=45, env=environment, check=True)
            events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            if not any(e.get("id") == "offline-state" and e.get("success") is True for e in events):
                raise ValueError(f"{variant}: native get_state RPC did not complete")
            if variant == "vanilla":
                accounting = [json.loads(line) for line in sidecar.read_text().splitlines()]
                if (accounting[0].get("type") != "accounting_opened"
                        or accounting[-1].get("type") != "accounting_closed"
                        or accounting[-1].get("writeFailures") != 0
                        or any(e.get("type") == "attempt_admitted" for e in accounting)):
                    raise ValueError("Stock accounting must open/close without any model attempt")
            print(f"{variant}: prepared SDK runtime, native get_state and EOF disposal passed offline")
        environment = harness.clean_environment(root, root, variant="current", node=node, tmpdir=Path("/tmp"))
        environment["PRIME_CONTEXT_BENCHMARK_NODE"] = str(node)
        command = [args.bwrap, "--unshare-net", "--unshare-pid", "--die-with-parent",
                   "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--dev", "/dev", "--proc", "/proc",
                   "--chdir", str(BENCH), sys.executable, "-E", "-S", "-B", "-m", "unittest", "-v", *OFFLINE_CHECKS]
        subprocess.run(command, env=environment, check=True, timeout=60)
    print("Offline host/adapter/accounting qualification passed. No provider access or model behavior was tested.")


def live_command(args):
    # Check admission before reading any local host or credential file.
    if not args.qualification_complete:
        raise ValueError("Finish the documented host/accounting qualification before --qualification-complete")
    if not args.admit_provider_calls:
        raise ValueError("--admit-provider-calls is required; run uses real providers")
    return [sys.executable, "-E", "-S", "-B", str(BENCH / "paired_medium_reference.py"),
            "--hosts-manifest", str(args.hosts_manifest),
            "--qualified-current-commit", args.current_commit, "--qualification-complete",
            "--api-price-profiles", str(args.api_price_profiles),
            "--host-openai-codex-auth-file", str(args.host_openai_codex_auth_file),
            "--host-deepseek-api-key-file", str(args.host_deepseek_api_key_file),
            "--output", str(args.output), "--admit-provider-calls"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    local = sub.add_parser("prepare", help="Offline local archives only; never logs in or downloads")
    local.add_argument("--current-archives", type=Path, required=True)
    local.add_argument("--stock-archives", type=Path, required=True)
    local.add_argument("--dependency-root", type=Path, required=True)
    local.add_argument("--node", type=Path, required=True)
    local.add_argument("--current-commit", required=True)
    local.add_argument("--output", type=Path, required=True)
    offline = sub.add_parser("qualify", help="Prepared SDK get_state/EOF plus existing offline Bash/RPC/accounting checks")
    offline.add_argument("--hosts-manifest", type=Path, required=True)
    offline.add_argument("--current-commit", required=True)
    offline.add_argument("--bwrap", default=shutil.which("bwrap") or "")
    live = sub.add_parser("run", help="A new single-commit campaign, not exact replay of the historical mixed run")
    live.add_argument("--hosts-manifest", type=Path, required=True)
    live.add_argument("--current-commit", required=True)
    live.add_argument("--qualification-complete", action="store_true")
    live.add_argument("--admit-provider-calls", action="store_true")
    live.add_argument("--api-price-profiles", type=Path, default=BENCH / "api-price-profiles.json")
    live.add_argument("--host-openai-codex-auth-file", type=Path, required=True)
    live.add_argument("--host-deepseek-api-key-file", type=Path, required=True)
    live.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "linux" or sys.version_info[:2] != (3, 12):
        parser.error("Run on Linux with Python 3.12")
    try:
        if args.mode == "prepare":
            prepare(args)
            return 0
        if args.mode == "qualify":
            qualify(args)
            return 0
        return subprocess.call(live_command(args))
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
