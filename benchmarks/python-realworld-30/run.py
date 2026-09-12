#!/usr/bin/env python3
"""Lean, isolated runner for the Python Real-World 30 benchmark."""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
import json
import os
import queue
import selectors
import shutil
import socket
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from benchlib import (
    RUN_SCHEMA,
    aggregate_api_price_estimates,
    aggregate_sessions,
    COST_KEYS,
    USAGE_KEYS,
    primary_attempt_index,
    clean_environment,
    clean_python_environment,
    collect_sessions,
    inject_stage,
    isolated_python_command,
    load_scenarios,
    make_read_only,
    make_writable_tree,
    materialize_payload,
    parse_task_ids,
    prepare_workspace,
    python312,
    require_python312,
    run_judge,
)

ROOT = Path(__file__).resolve().parent
H_VERSION = "0.9.3"
PUBLIC_VERSION = "0.9.4"
NATIVE_PACKAGE = "@ponythewhite/base-context"
VARIANTS = ("vanilla", "current")
AUXILIARY_KINDS = ("semantic-distill", "task-scout", "stall-recovery", "knowledge-compile")
HOSTS_SCHEMA = "prime-context.python-realworld-hosts/v2"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def sum_known(values) -> int | float | None:
    values = list(values)
    return sum(values) if all(value is not None for value in values) else None


def difference_known(current, baseline) -> int | float | None:
    return current - baseline if current is not None and baseline is not None else None


def metric_text(value, digits: int = 3) -> str:
    return f"{value:.{digits}f}" if value is not None else "n/a"


def provider_capacity_error(event: dict[str, Any]) -> bool:
    exact = "Selected model is at capacity."
    if event.get("type") == "compaction_end":
        return event.get("errorMessage") == exact
    if event.get("type") == "response" and event.get("command") in {"prompt", "compact"}:
        return event.get("success") is False and event.get("error") == exact
    message = event.get("message")
    return (
        event.get("type") == "message_end"
        and isinstance(message, dict)
        and message.get("role") == "assistant"
        and message.get("stopReason") == "error"
        and message.get("errorMessage") == exact
    )


def capacity_invalid(
    host: dict[str, Any], metrics: dict[str, Any], rpc_capacity_observed: bool = False,
) -> bool:
    # package_name is checked against the selected package by apply_hosts_manifest.
    # Missing native accounting does not restore authority to RPC/legacy markers.
    if host["package_name"] == NATIVE_PACKAGE:
        return any(
            request.get("type") == "attempt_settled"
            and (request.get("receipt") or {}).get("capacityConfirmed") is True
            for request in metrics.get("physical_attempts", [])
        )
    return rpc_capacity_observed or metrics.get("provider_capacity_confirmed") is True


def message_end_error(event: dict[str, Any]) -> str | None:
    message = event.get("message")
    if not isinstance(message, dict) or message.get("stopReason") != "error":
        return None
    detail = message.get("errorMessage")
    if not isinstance(detail, str) or not detail.strip():
        detail = "unknown provider error"
    return f"AgentError: {detail}"


def create_sandbox_scripts(run_dir: Path, args: argparse.Namespace) -> Path:
    bwrap = Path(args.bwrap).resolve()
    if not bwrap.is_file():
        raise FileNotFoundError(f"bubblewrap executable not found: {bwrap}")
    runtime = run_dir / "sandbox-runtime"
    runtime.mkdir()
    (runtime / "home").mkdir()
    (runtime / "logs").mkdir()
    inner = runtime / "inner.py"
    inner.write_text(
        """import json
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit


def with_port(command, port):
    result = list(command)
    try:
        index = result.index("--port")
    except ValueError:
        result.extend(["--port", str(port)])
    else:
        if index + 1 < len(result):
            result[index + 1] = str(port)
        else:
            result.append(str(port))
    return result


def start_local_service(item):
    url_path = Path(item["url_file"])
    if not url_path.is_file():
        return None
    try:
        port = urlsplit(url_path.read_text().strip()).port
    except (OSError, ValueError):
        return None
    if not port:
        return None
    log = open(item["log"], "a")
    process = subprocess.Popen(
        with_port(item["command"], port),
        cwd=item["cwd"],
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and process.poll() is None:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                return process, log
        except OSError:
            time.sleep(0.05)
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    log.close()
    return None


config = json.loads(Path(sys.argv[1]).read_text())
services = []
try:
    for item in config.get("services", []):
        started = start_local_service(item)
        if started:
            services.append(started)
    completed = subprocess.run([
        "/usr/bin/bwrap", "--die-with-parent", "--unshare-pid",
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--bind", "/workspace", "/workspace",
        "--tmpfs", "/runner",
        "--tmpfs", "/tmp",
        "--setenv", "HOME", "/tmp",
        "--chdir", "/workspace",
        "--", "/usr/bin/bash", *sys.argv[2:],
    ])
finally:
    for process, log in reversed(services):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        log.close()
raise SystemExit(completed.returncode)
"""
    )

    allowed_binaries = [
        "bash", "bwrap", "cat", "chmod", "cp", "diff", "env", "find", "grep", "head",
        "ls", "mkdir", "mv", "readlink", "realpath", "rm", "stat", "tail", "touch", "wc",
    ]
    command = [
        str(bwrap), "--die-with-parent", "--unshare-net", "--unshare-pid",
        "--dir", "/usr", "--dir", "/usr/bin", "--dir", "/usr/lib",
        "--ro-bind", python312(), "/usr/bin/python3.12",
    ]
    for name in allowed_binaries:
        source = Path("/usr/bin") / name
        if source.is_file():
            command.extend(["--ro-bind", str(source), f"/usr/bin/{name}"])
    command.extend([
        "--symlink", "python3.12", "/usr/bin/python3",
        "--symlink", "python3.12", "/usr/bin/python",
        "--ro-bind", "/usr/lib/python3.12", "/usr/lib/python3.12",
        "--ro-bind", "/usr/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu",
        "--ro-bind", "/usr/lib64", "/usr/lib64",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--dir", "/usr/share",
        "--ro-bind", "/usr/share/zoneinfo", "/usr/share/zoneinfo",
        "--dir", "/etc",
        "--ro-bind", "/etc/hosts", "/etc/hosts",
        "--ro-bind", "/etc/localtime", "/etc/localtime",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
        "--bind", str(run_dir / "workspace"), "/workspace",
        "--bind", str(runtime), "/runner",
        "--clearenv",
        "--setenv", "HOME", "/runner/home",
        "--setenv", "PATH", "/usr/bin",
        "--setenv", "LANG", "C",
        "--setenv", "LC_ALL", "C",
        "--setenv", "TZ", "UTC",
        "--setenv", "PYTHONUTF8", "1",
        "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
        "--chdir", "/workspace",
        "--", "/usr/bin/python3.12", "-E", "-S", "/runner/inner.py", "/runner/services.json",
    ])

    launcher = run_dir / "bash"
    launcher.write_text(
        f"#!{python312()}\n"
        "import subprocess\n"
        "import sys\n"
        f"command = {json.dumps(command)}\n"
        "raise SystemExit(subprocess.run([*command, *sys.argv[1:]]).returncode)\n"
    )
    launcher.chmod(0o700)

    return launcher


def sandbox_service_specs(
    scenario: dict[str, Any], task_dir: Path, workspace: Path, run_dir: Path
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    runtime = run_dir / "sandbox-runtime"
    for key in ("fixture_service", "candidate_service"):
        spec = scenario.get(key)
        if not isinstance(spec, dict) or not spec.get("url_file"):
            continue
        raw_command = [str(part) for part in spec.get("command", [])]
        if not raw_command:
            continue
        if key == "fixture_service":
            if raw_command[0] not in {"python", "python3", "python3.12"} or len(raw_command) < 2:
                raise ValueError("fixture_service must run a Python script")
            source = (task_dir / raw_command[1]).resolve()
            if task_dir.resolve() not in source.parents or not source.is_file():
                raise ValueError("fixture_service script must be a task-local file")
            fixture_dir = runtime / "fixture"
            fixture_dir.mkdir(exist_ok=True)
            target = fixture_dir / source.name
            shutil.copy2(source, target)
            command = ["/usr/bin/python3.12", "-E", "-S", f"/runner/fixture/{target.name}", *raw_command[2:]]
            cwd = "/runner/fixture"
        else:
            command = [
                part.replace("{workspace}", "/workspace")
                for part in raw_command
            ]
            if command[0] in {"python", "python3", "python3.12"}:
                command[0:1] = ["/usr/bin/python3.12", "-E", "-S"]
            cwd_value = str(spec.get("cwd", "{workspace}"))
            cwd = cwd_value.replace("{workspace}", "/workspace")
            if "{task_dir}" in cwd:
                raise ValueError("candidate_service must not depend on the hidden task directory")
        result.append({
            "command": command,
            "cwd": cwd,
            "url_file": f"/workspace/{spec['url_file']}",
            "log": f"/runner/logs/{key}.log",
        })
    return result





def prepare_agent_home(run_dir: Path, args: argparse.Namespace) -> dict[str, Path]:
    roots = {name: run_dir / name for name in ("config", "home", "sessions", "tmp")}
    for path in roots.values():
        path.mkdir(parents=True, exist_ok=True)
    roots["launcher"] = create_sandbox_scripts(run_dir, args)
    # No auth file, OAuth copy, package resolution, or inherited user settings.
    settings = {
        "defaultProvider": args.provider,
        "defaultModel": args.model,
        "defaultThinkingLevel": args.thinking,
        "shellPath": str(roots["launcher"]),
        "telemetry": {"enabled": False, "noticeShown": True},
        "packages": [],
    }
    json_dump(roots["config"] / "settings.json", settings)
    # Stock already has Sol/Astra. Add only the canonical DeepSeek contract when selected.
    models = {}
    if args.provider == "deepseek":
        models = {'providers': {'deepseek': {'models': [{'id': 'deepseek-flash',
                                                'name': 'DeepSeek-V4.1-Flash',
                                                'api': 'openai-completions',
                                                'reasoning': True,
                                                'thinkingLevelMap': {'minimal': 'low',
                                                                     'low': 'low',
                                                                     'medium': 'high',
                                                                     'high': 'high',
                                                                     'xhigh': 'high',
                                                                     'max': 'max'},
                                                'input': ['text', 'image'],
                                                'contextWindow': 1000000,
                                                'maxTokens': 393216,
                                                'cost': {'input': 0.3,
                                                         'output': 1.2,
                                                         'cacheRead': 0.006,
                                                         'cacheWrite': 0},
                                                'compat': {'thinkingFormat': 'deepseek',
                                                           'requiresReasoningContentOnAssistantMessages': True,
                                                           'maxTokensField': 'max_tokens'}}]}}}
    json_dump(roots["config"] / "models.json", models)
    return roots

















def agent_command(
    variant: str,
    workspace: Path,
    roots: dict[str, Path],
    args: argparse.Namespace,
) -> list[str]:
    bootstrap = roots["config"].parent / "rpc-bootstrap.mjs"
    package = Path(args.hosts[variant]["package_root"])
    options = {
        "variant": variant, "cwd": str(workspace), "agentDir": str(roots["config"]),
        "sessionDir": str(roots["sessions"]), "modelId": args.model, "thinkingLevel": args.thinking,
    }
    entry = {"openai-codex": "runSubscriptionRpc", "deepseek": "runDeepSeekRpc"}[args.provider]
    bootstrap.write_text(
        f"import * as host from {json.dumps((package / 'dist/index.js').as_uri())};\n"
        f"import {{ {entry} }} from {json.dumps((ROOT / 'subscription-rpc.mjs').as_uri())};\n"
        f"await {entry}(host, {json.dumps(options)});\n"
    )
    return [*args.hosts[variant]["argv"][:-1], str(bootstrap)]


def isolated_agent_command(
    command: list[str], host: dict[str, Any], run_dir: Path, args: argparse.Namespace,
) -> list[str]:
    manifest = args.host_manifest
    image = Path(host["package_root"])
    # The package sits at IMAGE/unpacked/<package>/package. Its private module
    # mappings live at IMAGE/node_modules; no source checkout is mounted.
    image = image.parents[2]
    mounts = [image, Path(manifest["dependency_root"]), Path(manifest["node_executable"])]
    native_image = Path(manifest["hosts"]["current"]["package_root"]).parents[2]
    # Shared dependencies can be the candidate's private module mapping.
    if Path(manifest["dependency_root"]).is_relative_to(native_image):
        mounts.append(native_image)
    result = [str(Path(args.bwrap).resolve()), "--die-with-parent", "--unshare-pid", "--new-session",
              "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
              "--symlink", "usr/bin", "/bin", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]
    for source in ("/etc/ld.so.cache", "/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/ssl", "/etc/localtime"):
        if Path(source).exists():
            result.extend(["--ro-bind", source, source])
    for source in dict.fromkeys(path.resolve() for path in mounts):
        result.extend(["--ro-bind", str(source), str(source)])
    for name in ("bash-tool.mjs", "subscription-rpc.mjs", "host-subscription-backend.mjs"):
        adapter = ROOT / name
        result.extend(["--ro-bind", str(adapter), str(adapter)])
    # Only the selected provider credential is mounted. Tools/services/judges never mount /run.
    credential, destination = {
        "openai-codex": (args.host_openai_codex_auth_file, "/run/host-openai-codex-auth.json"),
        "deepseek": (args.host_deepseek_api_key_file, "/run/host-deepseek-api-key"),
    }[args.provider]
    result.extend(["--dir", "/run", "--ro-bind", str(credential), destination,
                   "--bind", str(run_dir), str(run_dir),
                   "--chdir", str(run_dir / "workspace"), "--", "/usr/bin/env", "-u", "PWD", *command])
    return result


def service_command(command: list[Any]) -> list[str]:
    values = [str(part) for part in command]
    if values and values[0] in {"python", "python3", "python3.12"}:
        values[0:1] = [python312(), "-E", "-S"]
    return values


def command_with_port(command: list[str], port: int) -> list[str]:
    values = list(command)
    try:
        index = values.index("--port")
    except ValueError:
        values.extend(["--port", str(port)])
    else:
        if index + 1 < len(values):
            values[index + 1] = str(port)
        else:
            values.append(str(port))
    return values


@dataclass
class Service:
    process: subprocess.Popen[str]
    output_handle: Any
    output_thread: threading.Thread
    url: str
    name: str

    def stop(self) -> None:
        stop_process(self.process)
        self.output_thread.join(timeout=2)
        self.output_handle.close()


def start_service(
    name: str,
    spec: dict[str, Any],
    task_dir: Path,
    workspace: Path,
    run_dir: Path,
    bwrap: str,
    *,
    private_network: bool = True,
) -> Service:
    raw_command = [
        str(part).replace("{workspace}", str(workspace))
        for part in spec.get("command", [])
    ]
    if not raw_command:
        raise ValueError(f"{name}.command is empty")
    cwd_value = str(spec.get("cwd", "{task_dir}"))
    cwd = Path(cwd_value.replace("{task_dir}", str(task_dir)).replace("{workspace}", str(workspace)))
    command = service_command(raw_command)
    if spec.get("_port_override") is not None:
        command = command_with_port(command, int(spec["_port_override"]))
    command = isolated_python_command(
        command, cwd, workspace, bwrap,
        task_dir=task_dir if name == "fixture-service" else None,
        private_network=private_network,
    )
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=clean_python_environment(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        start_new_session=True,
    )
    assert process.stdout is not None
    output_handle = (run_dir / f"{name}.log").open("w")
    deadline = time.monotonic() + float(spec.get("startup_timeout_seconds", 20))
    port: int | None = None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while time.monotonic() < deadline:
            ready = selector.select(timeout=max(0.0, deadline - time.monotonic()))
            if not ready:
                break
            line = process.stdout.readline()
            if line:
                output_handle.write(line)
                output_handle.flush()
                words = line.strip().split()
                if len(words) == 2 and words[0] == "LISTENING" and words[1].isdigit():
                    port = int(words[1])
                    break
            elif process.poll() is not None:
                break
    finally:
        selector.close()
    if port is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        output_handle.close()
        raise RuntimeError(f"{name} did not report LISTENING <port>")

    def drain() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            output_handle.write(line)
            output_handle.flush()

    thread = threading.Thread(target=drain, daemon=True)
    thread.start()
    url = str(spec.get("url_template", "http://127.0.0.1:{port}")).format(port=port)
    url_file = spec.get("url_file")
    if url_file:
        target = workspace / str(url_file)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            target.parent.chmod(target.parent.stat().st_mode | 0o700)
            if target.exists():
                target.chmod(target.stat().st_mode | 0o600)
        except OSError:
            pass
        target.write_text(url + "\n")
        make_read_only(target)
        make_read_only(target.parent)
    return Service(process, output_handle, thread, url, name)


def stop_process(process: subprocess.Popen[str]) -> None:
    try:
        process.stdin.close() if process.stdin else None
    except OSError:
        pass
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=10)


def attempt_process_groups(*paths: Path) -> set[int]:
    markers = [str(path.resolve()).encode() for path in paths]
    current_group = os.getpgrp()
    groups: set[int] = set()
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes()
            if not command or not any(marker in command for marker in markers):
                continue
            group = os.getpgid(int(entry.name))
            if group > 0 and group != current_group:
                groups.add(group)
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
            continue
    return groups


def stop_attempt_processes(*paths: Path) -> None:
    groups = attempt_process_groups(*paths)
    for group in groups:
        try:
            os.killpg(group, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5
    while groups and time.monotonic() < deadline:
        remaining: set[int] = set()
        for group in groups:
            try:
                os.killpg(group, 0)
                remaining.add(group)
            except ProcessLookupError:
                pass
        groups = remaining
        if groups:
            time.sleep(0.05)
    for group in groups:
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass


def empty_metrics() -> dict[str, Any]:
    metrics = aggregate_sessions([])
    metrics.update({
        "rpc_tool_execution_starts": 0,
        "compaction_requests": 0,
        "compaction_completions": 0,
        "compaction_failures": 0,
        "peak_provider_bound_token_estimate": None,
        "auxiliary_model_calls": None,
        "auxiliary_model_calls_by_kind": {kind: None for kind in AUXILIARY_KINDS},
        "zero_extra_call": None,
        "archive_writes": 0,
        "archive_bytes": 0,
        "automatic_refinement_model_calls": None,
    })
    return metrics











def strict_pass(attempt: dict[str, Any]) -> bool:
    judge = attempt.get("judge") or {}
    return attempt.get("capacity_invalid") is not True and judge.get("status") == "pass" and judge.get("progress_level") == 5


def run_rpc(
    variant: str,
    task_dir: Path,
    scenario: dict[str, Any],
    workspace: Path,
    run_dir: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    host = args.hosts[variant]
    roots = prepare_agent_home(run_dir, args)
    environment = clean_environment(
        roots["config"], roots["home"], variant=variant,
        node=Path(args.host_manifest["node_executable"]), tmpdir=Path("/tmp"),
    )
    # Adapter-owned variable, not a Prime Context product extension.
    environment["PRIME_CONTEXT_BENCHMARK_SHELL"] = str(roots["launcher"])
    events_path = run_dir / "rpc-events.jsonl"
    stderr_path = run_dir / "rpc-stderr.txt"
    transcript_path = run_dir / "transcript.jsonl"
    q: queue.Queue[str | None] = queue.Queue()
    command = isolated_agent_command(agent_command(variant, workspace, roots, args), host, run_dir, args)
    services: list[Service] = []
    service_events: list[dict[str, Any]] = []
    fixture = scenario.get("fixture_service")
    if isinstance(fixture, dict):
        service = start_service("fixture-service", fixture, task_dir, workspace, run_dir, args.bwrap)
        services.append(service)
        service_events.append({"kind": "fixture_service", "event": "started", "url": service.url, "at": utc_now()})
    json_dump(run_dir / "sandbox-runtime" / "services.json", {
        "services": sandbox_service_specs(scenario, task_dir, workspace, run_dir),
    })

    with stderr_path.open("w") as stderr, events_path.open("w") as event_log, transcript_path.open("w") as transcript:
        try:
            process = subprocess.Popen(
                command,
                cwd=workspace,
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr,
                text=True,
                bufsize=1,
                start_new_session=True,
            )
        except Exception:
            for service in reversed(services):
                service.stop()
            raise
        assert process.stdin is not None and process.stdout is not None

        def reader() -> None:
            for line in process.stdout:
                q.put(line)
            q.put(None)

        reader_thread = threading.Thread(target=reader, daemon=True)
        reader_thread.start()
        request_counter = 0
        responses: list[dict[str, Any]] = []
        compaction_requests: list[dict[str, Any]] = []
        compaction_events: list[dict[str, Any]] = []
        stage_events: list[dict[str, Any]] = []
        stage_index = 0
        awaiting_compaction = False
        compaction_request_id: str | None = None
        done = False
        error: str | None = None
        rpc_capacity_observed = False
        peak_provider_bound: int | None = None

        def send(kind: str, label: str, message: str | None = None) -> str:
            nonlocal request_counter
            request_counter += 1
            request_id = f"request-{request_counter}-{label}"
            payload: dict[str, Any] = {"id": request_id, "type": kind}
            if message is not None:
                payload["message"] = message
            if kind == "prompt":
                # Daemon follow-up admission resumes the input pump left suspended
                # by manual compaction, and queues safely if cleanup is still active.
                payload["streamingBehavior"] = "followUp"
            process.stdin.write(json.dumps(payload) + "\n")
            process.stdin.flush()
            return request_id

        def start_candidate_service(stage_id: str) -> None:
            spec = scenario.get("candidate_service")
            if not isinstance(spec, dict):
                return
            start_at = str(spec.get("start_at_stage", "initial"))
            restart = bool(spec.get("restart_each_stage", False))
            stage_ids = [str(stage["id"]) for stage in scenario["stages"]]
            if start_at not in stage_ids:
                raise ValueError(f"candidate_service.start_at_stage is unknown: {start_at}")
            if stage_ids.index(stage_id) < stage_ids.index(start_at):
                return
            existing = next((item for item in services if item.name == "candidate-service"), None)
            if existing and not restart:
                return
            if existing:
                existing.stop()
                services.remove(existing)
                service_events.append({"kind": "candidate_service", "event": "stopped", "stage": stage_id, "at": utc_now()})
            service_spec = dict(spec)
            url_file = service_spec.get("url_file")
            if url_file:
                target = workspace / str(url_file)
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.is_file():
                    target.parent.chmod(target.parent.stat().st_mode | 0o700)
                    with socket.socket() as reservation:
                        reservation.bind(("127.0.0.1", 0))
                        port = int(reservation.getsockname()[1])
                    url = str(service_spec.get("url_template", "http://127.0.0.1:{port}")).format(port=port)
                    target.write_text(url + "\n")
                    make_read_only(target)
                    make_read_only(target.parent)
                from urllib.parse import urlsplit
                port = urlsplit(target.read_text().strip()).port
                if port:
                    service_spec["_port_override"] = port
            try:
                service = start_service("candidate-service", service_spec, task_dir, workspace, run_dir, args.bwrap)
            except Exception as exc:
                service_events.append({"kind": "candidate_service", "event": "start_failed", "stage": stage_id, "error": f"{type(exc).__name__}: {exc}", "at": utc_now()})
                return
            services.append(service)
            service_events.append({"kind": "candidate_service", "event": "started", "stage": stage_id, "url": service.url, "at": utc_now()})

        def send_stage(index: int) -> None:
            stage = scenario["stages"][index]
            if index:
                inject_stage(task_dir, workspace, stage, "main")
                for editable in scenario["editable_paths"]:
                    make_writable_tree(workspace / str(editable))
            start_candidate_service(str(stage["id"]))
            message = scenario["initial_prompt"] if index == 0 else str(stage["message"])
            request_id = send("prompt", f"stage-{stage['id']}", message)
            stage_events.append({"stage": stage["id"], "request_id": request_id, "sent_at": utc_now()})

        def record(line: str) -> dict[str, Any] | None:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                event_log.write(line)
                event_log.flush()
                return None
            if not isinstance(event, dict):
                return None
            if event.get("type") != "message_update":
                event_log.write(line)
                event_log.flush()
            if event.get("type") == "message_end":
                transcript.write(json.dumps({"at": utc_now(), "message": event.get("message")}, sort_keys=True) + "\n")
                transcript.flush()
            return event

        started = time.monotonic()
        try:
            send_stage(0)
            deadline = started + min(int(args.timeout_seconds), int(scenario["timeout_seconds"]))
            while not done:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("agent exceeded the task timeout")
                try:
                    line = q.get(timeout=remaining)
                except queue.Empty as exc:
                    raise TimeoutError("agent produced no terminal run event before timeout") from exc
                if line is None:
                    raise RuntimeError(f"RPC host exited before completion with code {process.poll()}")
                event = record(line)
                if event is None:
                    continue
                kind = event.get("type")
                if provider_capacity_error(event):
                    rpc_capacity_observed = True
                    error = "AgentError: Selected model is at capacity."
                    done = True
                    continue
                if kind == "message_end":
                    terminal_error = message_end_error(event)
                    if terminal_error is not None:
                        error, done = terminal_error, True
                elif kind == "response":
                    response = {"id": event.get("id"), "success": bool(event.get("success")), "error": event.get("error")}
                    responses.append(response)
                    if response["id"] == compaction_request_id:
                        # Public RPC compact resolves after compact() finishes. A
                        # needs_input or extra agent_end event does not exist.
                        awaiting_compaction = False
                        stage_index += 1
                        if stage_index < len(scenario["stages"]):
                            send_stage(stage_index)
                        else:
                            done = True
                    elif not response["success"]:
                        error, done = str(response["error"] or "RPC request failed"), True
                elif kind == "compaction_start":
                    compaction_events.append({"event": "start", "at": utc_now(), "reason": event.get("reason")})
                elif kind == "compaction_end":
                    compaction_events.append({
                        "event": "end", "at": utc_now(), "reason": event.get("reason"),
                        "aborted": bool(event.get("aborted")), "error": event.get("errorMessage"),
                        "will_retry": bool(event.get("willRetry")),
                    })
                    tokens_before = (event.get("result") or {}).get("tokensBefore")
                    if isinstance(tokens_before, int):
                        peak_provider_bound = max(peak_provider_bound or 0, tokens_before)
                elif kind == "agent_end" and not awaiting_compaction:
                    stage = scenario["stages"][stage_index]
                    if stage_index + 1 >= len(scenario["stages"]):
                        done = True
                    elif stage.get("compact_after") is True:
                        awaiting_compaction = True
                        compaction_request_id = send("compact", f"after-{stage['id']}")
                        compaction_requests.append({"stage": stage["id"], "request_id": compaction_request_id, "at": utc_now()})
                    else:
                        stage_index += 1
                        send_stage(stage_index)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        finally:
            if done and error is None:
                # EOF is the public RPC graceful-close route: waitForIdle,
                # connection.dispose, then real process exit before accounting.
                process.stdin.close()
                try:
                    code = process.wait(timeout=30)
                    if code:
                        error = f"RPC host exited with code {code}"
                except subprocess.TimeoutExpired:
                    error = "RPC host did not drain after stdin EOF"
            agent_wall = time.monotonic() - started
            stop_process(process)
            reader_thread.join(timeout=2)
            while True:
                try:
                    trailing = q.get_nowait()
                except queue.Empty:
                    break
                if trailing is not None:
                    event = record(trailing)
                    rpc_capacity_observed = rpc_capacity_observed or (event is not None and provider_capacity_error(event))
                    if event is not None and error is None:
                        error = message_end_error(event)
                        if event.get("type") == "response" and event.get("success") is False:
                            error = str(event.get("error") or "RPC request failed")
            for service in reversed(services):
                service.stop()
                service_events.append({"kind": service.name.replace("-", "_"), "event": "stopped", "at": utc_now()})
            stop_attempt_processes(run_dir)

    profiles = getattr(args, "api_price_profiles", None)
    metrics = aggregate_sessions(collect_sessions(roots["sessions"], profiles), profiles)
    metrics.update({
        "compaction_requests": len(compaction_requests),
        "compaction_completions": sum(1 for item in compaction_events if item["event"] == "end" and not item["aborted"] and not item["error"]),
        "compaction_failures": sum(1 for item in compaction_events if item["event"] == "end" and (item["aborted"] or item["error"])),
        "peak_provider_bound_token_estimate": peak_provider_bound,
        "archive_writes": None,
        "archive_bytes": None,
    })
    return {
        "agent_wall_seconds": agent_wall,
        "capacity_invalid": capacity_invalid(host, metrics, rpc_capacity_observed),
        "rpc_capacity_observed": rpc_capacity_observed,
        "rpc_process": {"pid": process.pid, "exit_code": process.poll()},
        "error": error,
        "command": command,
        "responses": responses,
        "stage_events": stage_events,
        "compaction_requests": compaction_requests,
        "compaction_events": compaction_events,
        "service_events": service_events,
        "metrics": metrics,
    }


def run_attempt(
    variant: str,
    task_dir: Path,
    scenario: dict[str, Any],
    attempt_dir: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    started_at = utc_now()
    lifecycle_started = time.monotonic()
    workspace = attempt_dir / "workspace"
    attempt_dir.mkdir(parents=True, exist_ok=True)
    setup_started = time.monotonic()
    prepare_workspace(task_dir, scenario, workspace)
    setup_seconds = time.monotonic() - setup_started
    rpc = run_rpc(variant, task_dir, scenario, workspace, attempt_dir, args)
    judge_started = time.monotonic()
    if rpc["capacity_invalid"]:
        judge = {"status": "invalid", "progress_level": None, "notes": ["Confirmed provider capacity interruption"]}
        judge_seconds, judge_log = 0.0, "Not judged: confirmed provider capacity interruption.\n"
    else:
        try:
            judge, judge_seconds, judge_log = run_judge(task_dir, scenario, workspace, args.bwrap)
        except Exception as exc:
            # A judge failure must not discard already incurred provider spend.
            judge_log = f"{type(exc).__name__}: {exc}"
            judge = {"status": "error", "progress_level": 0, "notes": [judge_log]}
            judge_seconds = time.monotonic() - judge_started
    (attempt_dir / "judge.log").write_text(judge_log)
    lifecycle_seconds = time.monotonic() - lifecycle_started
    result = {
        "schema": RUN_SCHEMA,
        "variant": variant,
        "task_id": scenario["id"],
        "task_slug": scenario["slug"],
        "pressure": scenario["pressure"],
        "started_at": started_at,
        "completed_at": utc_now(),
        "setup_seconds": setup_seconds,
        "agent_wall_seconds": rpc.pop("agent_wall_seconds"),
        "judge_seconds": judge_seconds,
        "lifecycle_wall_seconds": lifecycle_seconds,
        "judge": judge,
        **rpc,
    }
    json_dump(attempt_dir / "result.json", result)
    return result


def safe_run_attempt(
    variant: str,
    task_dir: Path,
    scenario: dict[str, Any],
    attempt_dir: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        return run_attempt(variant, task_dir, scenario, attempt_dir, args)
    except Exception as exc:
        attempt_dir.mkdir(parents=True, exist_ok=True)
        profiles = getattr(args, "api_price_profiles", None)
        metrics = aggregate_sessions(collect_sessions(attempt_dir / "sessions", profiles), profiles)
        result = {
            "schema": RUN_SCHEMA,
            "variant": variant,
            "task_id": scenario["id"],
            "task_slug": scenario["slug"],
            "pressure": scenario["pressure"],
            "started_at": utc_now(),
            "completed_at": utc_now(),
            "setup_seconds": None,
            "agent_wall_seconds": None,
            "judge_seconds": None,
            "lifecycle_wall_seconds": time.monotonic() - started,
            "capacity_invalid": capacity_invalid(args.hosts[variant], metrics),
            "rpc_capacity_observed": None,
            "judge": {
                "status": "error",
                "progress_level": 0,
                "main_checks_passed": 0,
                "main_checks_total": 0,
                "edge_check_passed": False,
                "notes": [f"runner failure: {type(exc).__name__}: {exc}"],
            },
            "error": f"{type(exc).__name__}: {exc}",
            "metrics": metrics,
        }
        json_dump(attempt_dir / "result.json", result)
        return result


def run_case(
    variant: str,
    task_dir: Path,
    scenario: dict[str, Any],
    output: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    case_dir = output / f"task-{scenario['id']:02d}-{scenario['slug']}" / variant
    attempts: list[dict[str, Any]] = []
    retry_triggers: list[dict[str, Any]] = []
    valid_attempts = 0
    while True:
        attempt_number = len(attempts) + 1
        attempt = safe_run_attempt(variant, task_dir, scenario, case_dir / f"attempt-{attempt_number}", args)
        attempts.append(attempt)
        invalid = attempt.get("capacity_invalid") is True
        if not invalid:
            valid_attempts += 1
            if valid_attempts > 1:
                retry_triggers.append({"attempt": attempt_number, "reasons": ["strict_failure"]})
        result = {
            "variant": variant,
            "task_id": scenario["id"],
            "task_slug": scenario["slug"],
            "pressure": scenario["pressure"],
            "primary_attempt": primary_attempt_index(attempts),
            "valid_attempts": valid_attempts,
            "capacity_invalid_attempts": len(attempts) - valid_attempts,
            "retry_triggers": retry_triggers,
            "attempts": attempts,
        }
        json_dump(case_dir / "case.json", result)
        if invalid:
            continue  # A capacity interruption never consumes a valid retry.
        if strict_pass(attempt) or valid_attempts >= 1 + args.retry_failed:
            return result


def primary_attempt(result: dict[str, Any]) -> dict[str, Any] | None:
    index = primary_attempt_index(result.get("attempts") or [])
    return result["attempts"][index] if index is not None else None


def attempt_accuracy(attempt: dict[str, Any]) -> tuple[int, int, int]:
    judge = attempt.get("judge") or {}
    return (
        int(judge.get("progress_level") or 0),
        int(judge.get("main_checks_passed") or 0),
        int(bool(judge.get("edge_check_passed"))),
    )


def attempt_cost(attempt: dict[str, Any]) -> float | None:
    metrics = attempt.get("metrics") or {}
    if metrics.get("cost_complete") is False:
        return None
    return (metrics.get("api_cost") or {}).get("total")








def aggregate_bucket(items: list[tuple[dict[str, Any], dict[str, Any]]]) -> dict[str, Any]:
    attempts = [attempt for _, attempt in items]
    valid = [attempt for attempt in attempts if attempt.get("capacity_invalid") is not True]
    strict_items = [attempt for attempt in valid if strict_pass(attempt)]
    metrics = [attempt.get("metrics") or {} for attempt in attempts]
    usage = {key: sum_known((item.get("provider_usage") or {}).get(key) for item in metrics) for key in USAGE_KEYS}
    cost = {key: sum_known((item.get("api_cost") or {}).get(key) for item in metrics) for key in COST_KEYS}
    cost["total"] = sum_known(attempt_cost(attempt) for attempt in attempts)
    profiled = any("api_price_estimates" in item for item in metrics)
    if profiled and len({(item.get("cost_basis"), item.get("accounting_source")) for item in metrics}) > 1:
        cost = {key: None for key in COST_KEYS}
    prompt_denominator = usage.get("inputTotal")
    peak_values = [item.get("peak_provider_bound_token_estimate") for item in metrics]
    prompt_peaks = [item.get("peak_provider_prompt_tokens") for item in metrics]
    zero_values = [item.get("zero_extra_call") for item in metrics]
    zero_count = sum_known(zero_values) if zero_values else None
    bucket = {
        "runs": len(attempts),
        "valid_runs": len(valid),
        "capacity_invalid_runs": len(attempts) - len(valid),
        "strict_passes": len(strict_items),
        "strict_pass_rate": len(strict_items) / len(valid) if valid else None,
        "mean_progress": sum(float((attempt.get("judge") or {}).get("progress_level") or 0) for attempt in valid) / len(valid) if valid else None,
        "auxiliary_model_calls_by_kind": {
            kind: sum_known((item.get("auxiliary_model_calls_by_kind") or {}).get(kind) for item in metrics)
            for kind in AUXILIARY_KINDS
        },
        "model_calls_by_purpose": {
            purpose: sum_known((item.get("model_calls_by_purpose") or {}).get(purpose) for item in metrics)
            for purpose in sorted({purpose for item in metrics for purpose in item.get("model_calls_by_purpose") or {}})
        },
        "zero_extra_call_runs": zero_count,
        "zero_extra_call_share": zero_count / len(zero_values) if zero_values and zero_count is not None else None,
        "provider_usage": usage,
        "api_cost": cost,
        "usage_complete": all(item.get("usage_complete") is not False for item in metrics) and all(value is not None for value in usage.values()),
        "cost_complete": cost["total"] is not None,
        "cost_bases": sorted({item["cost_basis"] for item in metrics if item.get("cost_basis")}),
        **({"api_price_estimates": aggregate_api_price_estimates(
            estimate for item in metrics for estimate in item.get("api_price_estimates", [])
        )} if profiled else {}),
        "prompt_cache_reuse": usage["cacheRead"] / prompt_denominator
        if usage["cacheRead"] is not None and prompt_denominator else None,
        "peak_provider_bound_token_estimate": max(peak_values) if peak_values and None not in peak_values else None,
        "mean_peak_provider_bound_token_estimate": sum(peak_values) / len(peak_values) if peak_values and None not in peak_values else None,
        "peak_provider_prompt_tokens": max(prompt_peaks) if prompt_peaks and None not in prompt_peaks else None,
        "strict_pass_agent_wall_seconds": sum_known(item.get("agent_wall_seconds") for item in strict_items),
        "strict_pass_api_cost": sum_known(attempt_cost(item) for item in strict_items),
    }
    for key in ("agent_wall_seconds", "lifecycle_wall_seconds", "judge_seconds"):
        bucket[key] = sum_known(attempt.get(key) for attempt in attempts)
    for key in (
        "main_model_calls", "all_model_calls", "child_sessions", "tool_calls", "recovery_tool_calls",
        "tool_result_bytes_shown", "automatic_refinement_applied", "automatic_refinement_model_calls",
        "compaction_requests", "compaction_completions", "compaction_failures", "provider_prompt_token_sum",
        "provider_prompt_sample_count", "explicit_compiler_calls", "explicit_compiler_cost",
        "automatic_compiler_calls", "automatic_compiler_cost", "final_response_tokens", "archive_writes", "archive_bytes",
    ):
        bucket[key] = sum_known(item.get(key) for item in metrics)
    prompt_sum, prompt_count = bucket["provider_prompt_token_sum"], bucket["provider_prompt_sample_count"]
    bucket["average_provider_prompt_tokens"] = prompt_sum / prompt_count if prompt_count and prompt_sum is not None else None
    return bucket


def comprehensive_summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    primaries = [(result, attempt) for result in results if (attempt := primary_attempt(result)) is not None]
    by_variant: dict[str, Any] = {}
    by_pressure: dict[str, Any] = {}
    for variant in sorted({result["variant"] for result in results}):
        items = [(r, a) for r, a in primaries if r["variant"] == variant]
        if any(result["variant"] == variant for result in results):
            bucket = aggregate_bucket(items)
            retained = [result for result in results if result["variant"] == variant]
            primary_items = items
            all_attempt_items = [
                (result, attempt)
                for result in retained
                for attempt in result.get("attempts") or []
            ]
            all_attempts = aggregate_bucket(all_attempt_items)
            primary = aggregate_bucket(primary_items)
            bucket["primary"] = primary
            bucket["all_attempts"] = all_attempts
            bucket["retained_attempts"] = all_attempts["runs"]
            bucket["cost_per_completed_task"] = (
                all_attempts["api_cost"]["total"] / bucket["strict_passes"]
                if bucket["strict_passes"] and all_attempts["api_cost"]["total"] is not None else None
            )
            bucket["agent_seconds_per_completed_task"] = (
                all_attempts["agent_wall_seconds"] / bucket["strict_passes"]
                if bucket["strict_passes"] and all_attempts["agent_wall_seconds"] is not None else None
            )
            by_variant[variant] = bucket
    for pressure in ("N", "L", "M", "H"):
        pressure_items = [(r, a) for r, a in primaries if r["pressure"] == pressure]
        if pressure_items:
            by_pressure[pressure] = {}
            for variant in sorted({result["variant"] for result in results}):
                selected_pressure = [(r, a) for r, a in pressure_items if r["variant"] == variant]
                if not selected_pressure:
                    continue
                bucket = aggregate_bucket(selected_pressure)
                pressure_results = [r for r in results if r["pressure"] == pressure and r["variant"] == variant]
                bucket["primary"] = aggregate_bucket([
                    (r, attempt) for r in pressure_results if (attempt := primary_attempt(r)) is not None
                ])
                bucket["all_attempts"] = aggregate_bucket([
                    (r, attempt) for r in pressure_results for attempt in r.get("attempts") or []
                ])
                by_pressure[pressure][variant] = bucket
    by_key = {(r["task_id"], r["variant"]): a for r, a in primaries}
    matched: list[dict[str, Any]] = []
    current_correctness_wins: list[dict[str, Any]] = []
    baseline_failures: list[dict[str, Any]] = []
    regressions: list[dict[str, Any]] = []
    task_ids = sorted({result["task_id"] for result in results})
    complete_pairs = 0
    for task_id in task_ids:
        current = by_key.get((task_id, "current"))
        vanilla = by_key.get((task_id, "vanilla"))
        if current is None or vanilla is None:
            continue
        complete_pairs += 1
        current_accuracy = attempt_accuracy(current)
        baseline_accuracy = attempt_accuracy(vanilla)
        if not strict_pass(current):
            regressions.append({
                "task_id": task_id,
                "baseline": "vanilla",
                "kind": "current_failure",
                "current_progress": current_accuracy[0],
            })
        if not strict_pass(vanilla):
            failure = {
                "task_id": task_id,
                "baseline": "vanilla",
                "baseline_progress": baseline_accuracy[0],
                "baseline_main_checks_passed": baseline_accuracy[1],
                "baseline_edge_check_passed": bool(baseline_accuracy[2]),
            }
            baseline_failures.append(failure)
            if strict_pass(current):
                current_correctness_wins.append({
                    **failure,
                    "current_progress": current_accuracy[0],
                    "current_main_checks_passed": current_accuracy[1],
                    "current_edge_check_passed": bool(current_accuracy[2]),
                })
        if baseline_accuracy > current_accuracy:
            regressions.append({
                "task_id": task_id,
                "baseline": "vanilla",
                "kind": "correctness",
                "baseline_progress": baseline_accuracy[0],
                "current_progress": current_accuracy[0],
                "baseline_main_checks_passed": baseline_accuracy[1],
                "current_main_checks_passed": current_accuracy[1],
                "baseline_edge_check_passed": bool(baseline_accuracy[2]),
                "current_edge_check_passed": bool(current_accuracy[2]),
            })
        if strict_pass(current) and strict_pass(vanilla):
            price_metrics = [value.get("metrics") or {} for value in (current, vanilla)]
            same_price_basis = not any("api_price_estimates" in value for value in price_metrics) or len({
                (value.get("cost_basis"), value.get("accounting_source")) for value in price_metrics
            }) == 1
            comparison = {
                "task_id": task_id,
                "baseline": "vanilla",
                "agent_wall_delta_current_minus_baseline": difference_known(current.get("agent_wall_seconds"), vanilla.get("agent_wall_seconds")),
                "api_cost_delta_current_minus_baseline": difference_known(attempt_cost(current), attempt_cost(vanilla))
                if same_price_basis else None,
                "provider_tokens_delta_current_minus_baseline": difference_known(((current.get("metrics") or {}).get("provider_usage") or {}).get("totalTokens"), ((vanilla.get("metrics") or {}).get("provider_usage") or {}).get("totalTokens")),
            }
            comparison["complete"] = all(comparison[key] is not None for key in ("agent_wall_delta_current_minus_baseline", "api_cost_delta_current_minus_baseline"))
            matched.append(comparison)
            for kind, key in (
                ("speed", "agent_wall_delta_current_minus_baseline"),
                ("cost", "api_cost_delta_current_minus_baseline"),
            ):
                if comparison[key] is not None and comparison[key] >= 0:
                    regressions.append({
                        "task_id": task_id,
                        "baseline": "vanilla",
                        "kind": kind,
                        "delta": comparison[key],
                    })
    publication_ready = (
        len(task_ids) == 30
        and complete_pairs == 30
        and len(matched) + len(current_correctness_wins) == 30
        and all(item["complete"] for item in matched)
        and not regressions
    )
    return {
        "schema": "prime-context.python-realworld-summary/v1",
        "generated_at": utc_now(),
        "selection_policy": "first valid attempt is the headline, including failures; strict-failure retries are diagnostic only; exact confirmed capacity invalidations do not consume the retry allowance",
        "metric_priority": ["completion_progress_and_success", "agent_wall_seconds", "api_cost"],
        "metric_limitations": [
            "Vanilla does not expose Prime Context auxiliary accounting; unavailable fields remain null rather than estimated.",
            "Cache reuse uses reported cache-read and total-input tokens; unreported cache-write quantities stay unknown. Efficiency costs are recorded-rate estimates.",
            "Task correctness and efficiency use only the primary valid attempt. All retained attempts, including failures and capacity invalidations, keep their time and cost estimates.",
            "Missing required price inputs or timing leave efficiency incomplete. Unreported token fields stay unknown even when a zero rate makes their estimated charge computable. Native costs are catalog-rate estimates, not invoices.",
        ],
        "by_variant": by_variant,
        "by_pressure": by_pressure,
        "matched_strict_pass_comparisons": matched,
        "incomplete_comparisons": [item for item in matched if not item["complete"]],
        "current_correctness_wins": current_correctness_wins,
        "baseline_failures": baseline_failures,
        "regressions": regressions,
        "publication_ready": publication_ready,
        "complete_task_pairs": complete_pairs,
    }


def write_summary_markdown(path: Path, summary: dict[str, Any], results: list[dict[str, Any]]) -> None:
    lines = [
        "# Python Real-World 30 Results", "", f"Generated: {summary['generated_at']}", "",
        f"Publication ready: {'yes' if summary.get('publication_ready') else 'no'}.", "",
        f"Publication protocol blockers: {', '.join(summary.get('publication_blockers') or []) or 'none'}.", "",
        "Headlines use the first valid attempt, including failures. Strict-failure retries are diagnostic only.",
        "Confirmed provider-capacity invalidations do not consume the retry allowance. All retained time and cost estimates remain below.",
        "Unknown metrics are n/a, not zero. Metric priority: completion/progress, then agent time, then API-priced estimates.",
        "Cost columns are estimates in USD using the recorded price basis, not proof of current tariffs or verified charges.",
        "OpenAI subscription calls: API-equivalent estimates are not subscription cash charges. DeepSeek API calls: tariff estimates are not verified debits.",
        "Unobserved cash or marginal charges remain unknown, not zero; estimate computability does not establish complete token breakdowns.", "",
        "## Metric limitations", "", *[f"- {item}" for item in summary.get("metric_limitations", [])], "",
        "## Variant summary", "",
        "| Variant | Tasks | Primary strict | Progress | Retained attempts | Capacity invalid | All agent s | Model attempts | Tool calls | Provider tokens | Cache reuse | All API estimate USD | Estimate/primary completion USD |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for variant, item in summary["by_variant"].items():
        total = item["all_attempts"]
        lines.append(
            f"| {variant} | {item['runs']} | {item['strict_passes']} | {metric_text(item['mean_progress'])} | "
            f"{total['runs']} | {total['capacity_invalid_runs']} | {metric_text(total['agent_wall_seconds'])} | "
            f"{metric_text(total['all_model_calls'], 0)} | {metric_text(total['tool_calls'], 0)} | "
            f"{metric_text(total['provider_usage']['totalTokens'], 0)} | {metric_text(total['prompt_cache_reuse'])} | "
            f"{metric_text(total['api_cost']['total'], 6)} | {metric_text(item['cost_per_completed_task'], 6)} |"
        )
    lines.extend(["", "### Explanatory totals", ""])
    for variant, item in summary["by_variant"].items():
        total = item["all_attempts"]
        auxiliary = ", ".join(f"{kind}={metric_text(value, 0)}" for kind, value in total["auxiliary_model_calls_by_kind"].items())
        purposes = ", ".join(f"{kind}={metric_text(value, 0)}" for kind, value in total["model_calls_by_purpose"].items()) or "n/a"
        lines.append(
            f"- **{variant}**: auxiliary {auxiliary}; native purposes {purposes}; "
            f"estimate basis={','.join(total['cost_bases']) or 'unavailable'}; "
            f"usage complete={total['usage_complete']}; estimate computable={total['cost_complete']}; "
            f"zero-extra-call-share={metric_text(total['zero_extra_call_share'])}; "
            f"compactions={metric_text(total['compaction_completions'], 0)}/{metric_text(total['compaction_requests'], 0)} "
            f"(failures={metric_text(total['compaction_failures'], 0)}); child sessions={metric_text(total['child_sessions'], 0)}; "
            f"recovery calls={metric_text(total['recovery_tool_calls'], 0)}; "
            f"automatic refinement calls={metric_text(total['automatic_refinement_model_calls'], 0)}; "
            f"refinements applied={metric_text(total['automatic_refinement_applied'], 0)}; "
            f"provider prompt peak/average={metric_text(total['peak_provider_prompt_tokens'], 0)}/{metric_text(total['average_provider_prompt_tokens'])}; "
            f"explicit compiler calls/cost={metric_text(total['explicit_compiler_calls'], 0)}/{metric_text(total['explicit_compiler_cost'], 6)}; "
            f"automatic compiler calls/cost={metric_text(total['automatic_compiler_calls'], 0)}/{metric_text(total['automatic_compiler_cost'], 6)}; "
            f"archive writes/bytes={metric_text(total['archive_writes'], 0)}/{metric_text(total['archive_bytes'], 0)}; "
            f"visible tool-result bytes={metric_text(total['tool_result_bytes_shown'], 0)}."
        )
    if any("api_price_estimates" in item["all_attempts"] for item in summary["by_variant"].values()):
        lines.extend([
            "", "### Explicit API price profiles", "",
            "Groups keep price profiles and quantity sources separate. Subtotals and ranges cover only priced, seen observations.",
            "Unpriced counts count seen observations, not hidden requests. Stock estimates and ranges are conditional on returned normalized counts, not guaranteed whole-run bounds.",
            "Stock synthetic cache-write zeros are not observations. Unknown full totals stay n/a; conditional figures do not establish a complete-cost win.",
            "| Variant | Profile | Basis | Coverage | Seen | Unpriced seen | Known subtotal USD | Conditional seen range USD |",
            "|---|---|---|---|---:|---:|---:|---|",
        ])
        for variant, item in summary["by_variant"].items():
            for estimate in item["all_attempts"].get("api_price_estimates", []):
                interval = estimate["conditional_range"]
                range_text = f"{metric_text(interval['lower'], 6)}–{metric_text(interval['upper'], 6)}" if interval else "n/a"
                lines.append(
                    f"| {variant} | {estimate['profile_id'] or 'unmatched'} | {estimate['basis'] or 'unpriced'} | "
                    f"{estimate['coverage']} | {estimate['observations']} | {estimate['unpriced_observations']} | "
                    f"{metric_text(estimate['known_subtotal'], 6)} | {range_text} |"
                )
    lines.extend([
        "", "## Pressure classes", "",
        "| Pressure | Variant | Tasks | Primary strict | Retained attempts | Capacity invalid | All agent s | All API estimate USD |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ])
    for pressure, variants in summary["by_pressure"].items():
        for variant, item in variants.items():
            total = item["all_attempts"]
            lines.append(
                f"| {pressure} | {variant} | {item['runs']} | {item['strict_passes']} | {total['runs']} | "
                f"{total['capacity_invalid_runs']} | {metric_text(total['agent_wall_seconds'])} | {metric_text(total['api_cost']['total'], 6)} |"
            )
    lines.extend([
        "", "## Task results", "",
        "| Task | Variant | Retained attempts | Primary attempt | Primary strict | Progress | Primary agent s | Primary API estimate USD | All agent s | All API estimate USD |",
        "|---:|---|---:|---:|---|---:|---:|---:|---:|---:|",
    ])
    for result in sorted(results, key=lambda item: (item["task_id"], item["variant"])):
        primary = primary_attempt(result)
        attempts = result.get("attempts") or []
        all_bucket = aggregate_bucket([(result, attempt) for attempt in attempts])
        index = primary_attempt_index(attempts)
        score = "unscored" if primary is None else "yes" if strict_pass(primary) else "no"
        value = primary or {}
        lines.append(
            f"| {result['task_id']:02d} | {result['variant']} | {len(attempts)} | {index + 1 if index is not None else 'n/a'} | "
            f"{score} | {metric_text((value.get('judge') or {}).get('progress_level'), 0)} | "
            f"{metric_text(value.get('agent_wall_seconds'))} | {metric_text(attempt_cost(value), 6)} | "
            f"{metric_text(all_bucket['agent_wall_seconds'])} | {metric_text(all_bucket['api_cost']['total'], 6)} |"
        )
    lines.extend([
        "", "## Current correctness wins", "",
        "Only primary valid attempts are compared. No efficiency claim is made when the primary baseline fails.", "",
        "| Task | Baseline | Current | Vanilla |", "|---:|---|---|---|",
    ])
    for item in summary["current_correctness_wins"]:
        lines.append(
            f"| {item['task_id']:02d} | {item['baseline']} | progress {item['current_progress']}, "
            f"{item['current_main_checks_passed']}/5, edge={item['current_edge_check_passed']} | "
            f"progress {item['baseline_progress']}, {item['baseline_main_checks_passed']}/5, edge={item['baseline_edge_check_passed']} |"
        )
    if not summary["current_correctness_wins"]:
        lines.append("| — | — | — | — |")
    lines.extend([
        "", "## Matched strict-pass primary comparisons", "",
        "Unknown time or estimated cost leaves the efficiency comparison incomplete, not a win.", "",
        "| Task | Baseline | Current−baseline agent s | Current−baseline API estimate USD | Current−baseline tokens | Complete |",
        "|---:|---|---:|---:|---:|---|",
    ])
    for item in summary["matched_strict_pass_comparisons"]:
        lines.append(
            f"| {item['task_id']:02d} | {item['baseline']} | {metric_text(item['agent_wall_delta_current_minus_baseline'])} | "
            f"{metric_text(item['api_cost_delta_current_minus_baseline'], 6)} | "
            f"{metric_text(item['provider_tokens_delta_current_minus_baseline'], 0)} | {'yes' if item['complete'] else 'no'} |"
        )
    if not summary["matched_strict_pass_comparisons"]:
        lines.append("| — | — | — | — | — | — |")
    lines.extend(["", "## Regressions", ""])
    lines.extend(
        [f"- Task {item['task_id']:02d} vs {item['baseline']}: {item['kind']} ({item})" for item in summary["regressions"]]
        or ["None observed in the primary valid attempts. Unavailable metrics do not establish a win."]
    )
    path.write_text("\n".join(lines) + "\n")


CAMPAIGN_MODELS = (
    ("sol", "openai-codex", "gpt-5.6-sol", "openai-codex-responses", "existing-host-openai-codex-subscription"),
    ("astra", "openai-codex", "gpt-6-astra", "openai-codex-responses", "existing-host-openai-codex-subscription"),
    ("deepseek", "deepseek", "deepseek-flash", "openai-completions", "deepseek-api"),
)


def case_error_result(variant: str, scenario: dict[str, Any], exc: Exception) -> dict[str, Any]:
    return {
        "variant": variant, "task_id": scenario["id"], "task_slug": scenario["slug"], "pressure": scenario["pressure"],
        "primary_attempt": 0, "retry_triggers": [],
        "attempts": [{"error": f"{type(exc).__name__}: {exc}", "judge": {"status": "error", "progress_level": 0}, "metrics": {}}],
    }


def save_results(output: Path, results: list[dict[str, Any]], manifest: dict[str, Any]) -> dict[str, Any]:
    results.sort(key=lambda item: (item["task_id"], item["variant"]))
    summary = comprehensive_summary(results)
    summary["publication_protocol"] = manifest["publication_protocol"]
    summary["publication_blockers"] = manifest["publication_blockers"]
    summary["publication_ready"] = bool(
        summary["publication_ready"] and manifest["publication_protocol"]
    )
    json_dump(output / "results.json", results)
    json_dump(output / "summary.json", summary)
    write_summary_markdown(output / "SUMMARY.md", summary, results)
    manifest["completed_at"] = utc_now()
    json_dump(output / "invocation.json", manifest)
    return summary


def run_model_task(
    model_index: int, task_index: int, task_dir: Path, scenario: dict[str, Any],
    output: Path, args: argparse.Namespace,
) -> list[dict[str, Any]]:
    """One task slot runs its selected arms in counterbalanced, sequential order."""
    variants = parse_variants(args.variants)
    if (task_index + model_index) % 2:
        variants.reverse()
    results = []
    for variant in variants:
        try:
            result = run_case(variant, task_dir, scenario, output, args)
        except Exception as exc:
            result = case_error_result(variant, scenario, exc)
        results.append(result)
    return results


def run_campaign(
    args: argparse.Namespace, scenarios: dict[int, tuple[Path, dict[str, Any]]],
    task_ids: list[int], manifest: dict[str, Any],
) -> list[dict[str, Any]]:
    """Main owns real-run admission/host checks; small task sets serve offline scheduler fixtures."""
    if not 1 <= args.max_workers <= 6:
        raise ValueError("--max-workers must be 1..6")
    task_ids = sorted(task_ids)
    selected_variants = parse_variants(args.variants)
    variants = [variant for variant in VARIANTS if variant in selected_variants]
    phases = args.efforts.split(",")
    campaign = copy.deepcopy(manifest)
    # These single-model declarations cannot describe a mixed-model campaign.
    for key in ("provider", "model", "thinking", "group_size", "auth_route", "provider_api"):
        campaign.pop(key, None)
    campaign.update({
        "mode": "three-model-campaign", "phases": phases, "tasks": task_ids, "task_window_size": 2,
        "worker_unit": "model,task with sequential selected arms", "max_workers": args.max_workers, "variants": variants,
        "models": [{"label": label, "provider": provider, "model": model,
                    "expected_provider_api": api, "expected_auth_route": route}
                   for label, provider, model, api, route in CAMPAIGN_MODELS],
        "arm_order": "sequential selected arms in vanilla,current order; reverse when (task_index + model_index) is odd",
        "effort_note": "Expected wire effort is declared configuration, not measured; actual observations remain in request/session metrics or unknown.",
    })
    model_outputs = []
    json_dump(args.output / "invocation.json", campaign)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as executor:
        for phase in phases:
            results_by_model = {model[0]: [] for model in CAMPAIGN_MODELS}
            model_args = {}
            model_manifests = {}
            for label, provider, model, api, route in CAMPAIGN_MODELS:
                configured = copy.deepcopy(args)
                configured.provider, configured.model, configured.thinking = provider, model, phase
                configured.variants = ",".join(variants)
                configured.output = args.output / phase / label
                model_args[label] = configured
                model_manifest = copy.deepcopy(campaign)
                model_manifest.update({
                    "provider": provider, "model": model, "thinking": phase, "campaign_phase": phase,
                    "expected_provider_api": api, "expected_auth_route": route,
                    "expected_wire_effort": "high" if provider == "deepseek" and phase == "medium" else phase,
                })
                model_manifests[label] = model_manifest
                json_dump(configured.output / "invocation.json", model_manifest)
            for offset in range(0, len(task_ids), 2):
                window = task_ids[offset:offset + 2]
                print(f"starting {phase} three-model window for tasks {window}", flush=True)
                futures = {}
                # Task-major order interleaves models even when fewer than six slots are configured.
                for task_index, task_id in enumerate(window, start=offset):
                    for model_index, (label, *_rest) in enumerate(CAMPAIGN_MODELS):
                        configured = copy.deepcopy(model_args[label])
                        future = executor.submit(
                            run_model_task, model_index, task_index, scenarios[task_id][0],
                            copy.deepcopy(scenarios[task_id][1]), configured.output, configured,
                        )
                        futures[future] = (label, task_id)
                # All six (or the final fixture window's fewer) jobs finish before any next-window admission.
                for future in concurrent.futures.as_completed(futures):
                    label, task_id = futures[future]
                    try:
                        paired_results = future.result()
                    except Exception as exc:
                        paired_results = [case_error_result(variant, scenarios[task_id][1], exc) for variant in variants]
                    results_by_model[label].extend(paired_results)
                    json_dump(model_args[label].output / "results.partial.json", results_by_model[label])
            for label, provider, model, _api, _route in CAMPAIGN_MODELS:
                output = model_args[label].output
                results = results_by_model[label]
                summary = save_results(output, results, model_manifests[label])
                model_outputs.append({"phase": phase, "provider": provider, "model": model, "output": str(output),
                                      "runs": len(results), "regressions": len(summary["regressions"])})
            # Finish each selected phase, including failures and reports, before the next one.
    campaign["model_outputs"] = model_outputs
    campaign["completed_at"] = utc_now()
    json_dump(args.output / "invocation.json", campaign)
    return model_outputs


def parse_variants(value: str) -> list[str]:
    variants = [part.strip() for part in value.split(",") if part.strip()]
    unknown = sorted(set(variants) - set(VARIANTS))
    if unknown:
        raise ValueError(f"unknown variants: {unknown}")
    if not variants:
        raise ValueError("no variants selected")
    return variants


def apply_hosts_manifest(args: argparse.Namespace) -> dict[str, Any]:
    if args.hosts_manifest is None:
        raise ValueError("--hosts-manifest from the local H/native setup is required")
    path = args.hosts_manifest.expanduser().resolve(strict=True)
    manifest = json.loads(path.read_text())
    if manifest.get("schema") != HOSTS_SCHEMA:
        raise ValueError(f"unsupported hosts manifest: {manifest.get('schema')!r}")
    node = Path(manifest["node_executable"]).resolve(strict=True)
    dependencies = Path(manifest["dependency_root"]).resolve(strict=True)
    if not dependencies.is_dir():
        raise ValueError("hosts dependency_root must be an existing local directory")
    hosts = manifest["hosts"]
    if set(hosts) != set(VARIANTS):
        raise ValueError("hosts manifest must contain exactly vanilla and current")
    for variant, host in hosts.items():
        package = Path(host["package_root"]).resolve(strict=True)
        metadata = json.loads((package / "package.json").read_text())
        expected_name = ("prime-agent" if host.get("package_name") == "prime-agent" else
                         "@earendil-works/pi-coding-agent") if variant == "vanilla" else NATIVE_PACKAGE
        if (metadata.get("name") != expected_name or host.get("package_name") != metadata.get("name")
                or metadata.get("version") != host.get("version")):
            raise ValueError(f"{variant} host package metadata mismatch")
        if variant == "vanilla":
            version = PUBLIC_VERSION if expected_name == "prime-agent" else H_VERSION
            if metadata["version"] != version:
                raise ValueError(f"vanilla requires pinned {expected_name} {version}")
        if variant == "current":
            info = json.loads((package / "dist/build-info.json").read_text())
            if info.get("sourceDirty") is not False or info.get("sourceCommit") != manifest.get("candidate_commit"):
                raise ValueError("current host is not the frozen clean candidate")
        entrypoint = (package / "dist/bundle/cli.js").resolve(strict=True)
        expected = [str(node), "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "--max-old-space-size=8192", str(entrypoint)]
        if host.get("argv") != expected or Path(host["entrypoint"]).resolve() != entrypoint:
            raise ValueError(f"{variant} host command does not use the pinned Node/package entrypoint")
    args.hosts_manifest = path
    args.hosts = hosts
    args.host_manifest = manifest
    return manifest


def validate_corpus(scenarios: dict[int, tuple[Path, dict[str, Any]]], bwrap: str | None) -> dict[str, Any]:
    python_files = [ROOT / "benchlib.py", ROOT / "run.py", *sorted((ROOT / "tasks").rglob("*.py"))]
    compile_script = "import sys; [compile(open(path, 'rb').read(), path, 'exec') for path in sys.argv[1:]]"
    subprocess.run(
        [python312(), "-E", "-S", "-c", compile_script, *map(str, python_files)],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
        timeout=300,
    )
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node is required to load the neutral benchmark Bash adapter")
    subprocess.run(
        [node, "--check", str(ROOT / "bash-tool.mjs")],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
        timeout=30,
    )
    temporary = Path(tempfile.mkdtemp(prefix="pcbench-validate-"))
    empty_judges = 0
    stage_files = 0
    try:
        for task_id, (task_dir, scenario) in sorted(scenarios.items()):
            workspace = temporary / f"task-{task_id:02d}" / "workspace"
            prepare_workspace(task_dir, scenario, workspace)
            for stage in scenario["stages"][1:]:
                payload = materialize_payload(task_dir / str(stage["inject"]), "main")
                try:
                    future_files = [path.relative_to(payload) for path in payload.rglob("*") if path.is_file()]
                    leaked = [str(path) for path in future_files if (workspace / path).exists()]
                    if leaked:
                        raise ValueError(f"task {task_id:02d} future stage {stage['id']} leaks initially: {leaked[:5]}")
                    stage_files += len(future_files)
                finally:
                    shutil.rmtree(payload, ignore_errors=True)
            candidate = temporary / f"task-{task_id:02d}" / "empty-candidate"
            candidate.mkdir()
            judge, _, _ = run_judge(task_dir, scenario, candidate, bwrap)
            if judge.get("progress_level") != 0 or judge.get("edge_check_passed") is not False:
                raise ValueError(f"task {task_id:02d} empty candidate did not fail at progress 0: {judge}")
            empty_judges += 1
    finally:
        make_writable_tree(temporary)
        shutil.rmtree(temporary, ignore_errors=True)
    return {"valid": True, "task_count": len(scenarios), "python_files": len(python_files), "future_stage_files": stage_files, "empty_judges": empty_judges}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", default="all")
    parser.add_argument("--variants", default=",".join(VARIANTS))
    parser.add_argument("--output", type=Path, default=ROOT / "results" / datetime.now().strftime("%Y%m%d-%H%M%S"))
    parser.add_argument("--provider", choices=("openai-codex",), default="openai-codex")
    parser.add_argument("--model", choices=("gpt-5.6-sol", "gpt-6-astra"), default="gpt-5.6-sol")
    parser.add_argument("--thinking", default="medium")
    parser.add_argument("--three-model-campaign", action="store_true",
                        help="run all 30 tasks on Sol/Astra/DeepSeek, selected arms sequentially in two-task windows")
    parser.add_argument("--efforts", choices=("low", "medium", "low,medium"), default="low",
                        help="three-model campaign phases; defaults to low, with medium only when explicitly selected")
    parser.add_argument("--api-price-profiles", dest="api_price_profiles_file", type=Path,
                        help="optional JSON price-profile snapshot for new experiment estimates; omitted uses recorded catalog prices")
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--group-size", type=int, default=2,
                        help="single-model mode comparison-group size; campaign mode always uses a two-task window")
    parser.add_argument("--max-workers", type=int, default=6)
    parser.add_argument("--retry-failed", type=int, choices=(0, 1), default=1)
    parser.add_argument("--hosts-manifest", type=Path, help="local prepared H0.9.3 or public Prime Agent0.9.4/native manifest from prepare-hosts.py")
    parser.add_argument("--host-openai-codex-auth-file", type=Path, help="existing host OpenAI Codex subscription auth; agent-only readonly mount")
    parser.add_argument("--host-deepseek-api-key-file", type=Path, help="explicit DeepSeek API key file; selected provider process only, read-only mount")
    parser.add_argument("--admit-provider-calls", action="store_true", help="explicitly admit the configured subscription/API inference for this run")
    parser.add_argument("--bwrap", default=shutil.which("bwrap") or "", help="bubblewrap executable for RPC and tool isolation")
    parser.add_argument("--validate-only", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    # Read once into detached data; concurrent attempts never reread or modify the file/profile snapshot.
    args.api_price_profiles = json.loads(args.api_price_profiles_file.read_text()) if args.api_price_profiles_file else None
    if args.api_price_profiles is not None and (
        not isinstance(args.api_price_profiles, list) or any(not isinstance(item, dict) for item in args.api_price_profiles)
    ):
        raise ValueError("--api-price-profiles must contain a JSON array of profile objects")
    if args.three_model_campaign and args.api_price_profiles is None:
        raise ValueError("--three-model-campaign requires --api-price-profiles with an explicit snapshot")
    require_python312()
    if not args.three_model_campaign and not (1 <= args.group_size <= 2):
        raise SystemExit("--group-size must be 1..2")
    if not (1 <= args.max_workers <= 6):
        raise SystemExit("--max-workers must be 1..6")
    scenarios = load_scenarios(ROOT, require_complete=True)
    if args.validate_only:
        print(json.dumps(validate_corpus(scenarios, args.bwrap or None), sort_keys=True))
        return 0
    hosts_manifest = apply_hosts_manifest(args)
    task_ids = parse_task_ids(args.tasks, scenarios)
    variants = parse_variants(args.variants)
    if args.three_model_campaign:
        baseline = hosts_manifest["hosts"]["vanilla"]
        if baseline["package_name"] != "prime-agent" or baseline["version"] != PUBLIC_VERSION:
            raise ValueError(f"--three-model-campaign requires public Prime Agent {PUBLIC_VERSION}")
        if len(task_ids) != 30 or sorted(task_ids) != sorted(scenarios):
            raise ValueError("--three-model-campaign requires all 30 task IDs")
        task_ids = sorted(task_ids)
        variants = [variant for variant in VARIANTS if variant in variants]
    elif args.group_size != len(variants):
        raise SystemExit("--group-size must equal the number of selected variants so each task runs as one comparison group")
    if not args.bwrap:
        raise SystemExit("bubblewrap (bwrap) is required for hermetic tool execution")
    if not args.admit_provider_calls:
        raise ValueError("--admit-provider-calls is required; --offline is not inference authorization")
    if args.host_openai_codex_auth_file is None:
        raise ValueError("--host-openai-codex-auth-file must select the existing host subscription")
    # Metadata only. Credential reads happen only in the agent auth backend.
    args.host_openai_codex_auth_file = args.host_openai_codex_auth_file.expanduser().resolve(strict=True)
    if not args.host_openai_codex_auth_file.is_file():
        raise ValueError("host subscription auth must be an existing file")
    if args.three_model_campaign:
        if args.host_deepseek_api_key_file is None:
            raise ValueError("--three-model-campaign requires --host-deepseek-api-key-file")
        args.host_deepseek_api_key_file = args.host_deepseek_api_key_file.expanduser().resolve(strict=True)
        if not args.host_deepseek_api_key_file.is_file():
            raise ValueError("DeepSeek API key must be an existing file")
    for variant in variants:
        if variant not in hosts_manifest["hosts"]:
            raise ValueError(f"host not prepared: {variant}")
    publication_blockers: list[str] = []
    if task_ids != sorted(scenarios):
        publication_blockers.append("tasks must contain all 30 scenarios")
    if variants != list(VARIANTS):
        publication_blockers.append("variants must be vanilla,current")
    if not args.three_model_campaign:
        if args.provider != "openai-codex":
            publication_blockers.append("provider must be openai-codex")
        if args.model not in {"gpt-5.6-sol", "gpt-6-astra"}:
            publication_blockers.append("model must be an exact supported Sol/Astra ID")
        if args.thinking != "medium":
            publication_blockers.append("thinking must be medium")
    if args.timeout_seconds != 1800:
        publication_blockers.append("timeout-seconds must be 1800")
    if not args.three_model_campaign and (args.group_size != 2 or args.max_workers != 6):
        publication_blockers.append("group-size/max-workers must be 2/6")
    if args.retry_failed != 1:
        publication_blockers.append("retry-failed must be 1")
    if hosts_manifest is None:
        publication_blockers.append("hosts must come from prepare-hosts.py")

    args.output = args.output.resolve()
    if args.output.exists() and any(args.output.iterdir()):
        raise ValueError(f"output directory must be fresh and empty: {args.output}")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "prime-context.python-realworld-invocation/v1",
        "started_at": utc_now(),
        "tasks": task_ids,
        "variants": variants,
        "provider": args.provider,
        "model": args.model,
        "thinking": args.thinking,
        **({"api_price_profiles": args.api_price_profiles} if args.api_price_profiles is not None else {}),
        "timeout_seconds": args.timeout_seconds,
        "group_size": args.group_size,
        "max_workers": args.max_workers,
        "retry_failed": args.retry_failed,
        "tool_network": "loopback-only",
        "hosts_manifest": str(args.hosts_manifest) if args.hosts_manifest else None,
        "hosts_prepared_at": (hosts_manifest or {}).get("prepared_at"),
        "hosts": hosts_manifest["hosts"],
        "node_executable": hosts_manifest["node_executable"],
        "candidate_commit": hosts_manifest["candidate_commit"],
        "auth_route": "existing-host-openai-codex-subscription",
        "provider_api": "openai-codex-responses",
        "provider_calls_admitted": args.admit_provider_calls,
        "rpc_adapter": "external-sdk-runtime",
        "rpc_process_isolation": "private PID/mount view; read-only package inputs; allowlisted environment",
        "host_version": hosts_manifest["hosts"]["vanilla"]["version"],
        "publication_protocol": not publication_blockers,
        "publication_blockers": publication_blockers,
    }
    if args.three_model_campaign:
        outputs = run_campaign(args, scenarios, task_ids, manifest)
        print(json.dumps({"output": str(args.output), "model_outputs": outputs}, sort_keys=True))
        return 0
    json_dump(args.output / "invocation.json", manifest)
    results: list[dict[str, Any]] = []
    tasks_per_wave = max(1, args.max_workers // args.group_size)
    for offset in range(0, len(task_ids), tasks_per_wave):
        group = task_ids[offset:offset + tasks_per_wave]
        print(f"starting comparison groups for tasks {group}", flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(args.max_workers, len(group) * len(variants))) as executor:
            futures = {
                executor.submit(run_case, variant, scenarios[task_id][0], scenarios[task_id][1], args.output, args): (task_id, variant)
                for task_id in group
                for variant in variants
            }
            for future in concurrent.futures.as_completed(futures):
                task_id, variant = futures[future]
                try:
                    result = future.result()
                except Exception as exc:
                    result = case_error_result(variant, scenarios[task_id][1], exc)
                results.append(result)
                json_dump(args.output / "results.partial.json", results)
                print(f"finished task {task_id:02d} {variant}: progress {((primary_attempt(result) or {}).get('judge') or {}).get('progress_level', 0)}", flush=True)
    summary = save_results(args.output, results, manifest)
    print(json.dumps({"output": str(args.output), "runs": len(results), "regressions": len(summary["regressions"])}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
