"""One native-product attempt. Preparation and grading are outside its clock."""
import argparse
import asyncio
import contextlib
import json
import os
import shutil
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from base_protocol import BaseContextProtocol
from candidate_service import CandidateService
from codex_protocol import CodexProtocol
from benchlib import prepare_workspace, inject_stage, make_writable_tree, make_read_only, run_judge
from stress_suite import SCHEMA as STRESS_SCHEMA, load_task, run_stress_judge

ROOT = Path(__file__).resolve().parent


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value, secret=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")
    if secret:
        path.chmod(0o600)


async def command(*argv, check=True, **kwargs):
    process = await asyncio.create_subprocess_exec(*map(str, argv), stdout=asyncio.subprocess.PIPE,
                                                  stderr=asyncio.subprocess.PIPE, **kwargs)
    out, err = await process.communicate()
    if check and process.returncode:
        raise RuntimeError(f"External command failed ({argv[0]}): {err.decode(errors='replace')}")
    return process.returncode, out.decode(errors="replace"), err.decode(errors="replace")


def mount(source, destination, readonly=True):
    return ["--mount", f"type=bind,src={source},dst={destination}" + (",readonly" if readonly else "")]


def prepare_configuration(config, spec, directory):
    home = directory / "home"
    home.mkdir()
    profile = spec["profile"]
    deepseek = profile["family"] == "deepseek"
    environment = {"HOME": "/home/bench", "USER": "bench", "LOGNAME": "bench",
                   "PATH": "/bench/bin:/opt/node/bin:/opt/uv/bin:/usr/local/bin:/usr/bin:/bin", "TMPDIR": "/tmp",
                   "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TERM": "dumb", "TZ": "UTC",
                   "NO_COLOR": "1", "DO_NOT_TRACK": "1", "PIP_DISABLE_PIP_VERSION_CHECK": "1"}
    private_environment = {}
    if deepseek:
        key = os.environ.get("DEEPSEEK_API_KEY") or Path(config["deepseek_key_source"]).read_text().strip()
        private_environment["DEEPSEEK_API_KEY"] = key
    if spec["harness"] == "base-context":
        agent_home = home / ".base-context"
        agent_home.mkdir()
        if deepseek:
            auth = {"deepseek": {"type": "api_key", "key": private_environment["DEEPSEEK_API_KEY"]}}
        else:
            auth = {"openai-codex": json.loads(Path(config["base_auth_source"]).read_text())["openai-codex"]}
        write_json(agent_home / "auth.json", auth, secret=True)
        if "base_settings" in config:
            write_json(agent_home / "settings.json", config["base_settings"])
        environment.update({"BASE_CONTEXT_HOME": "/home/bench/.base-context", "BASE_CONTEXT_OFFLINE": "1"})
        argv = [str(Path(config["base_install"]) / "bin/base-context"), "--mode", "rpc",
                "--rpc-protocol-version", "13", "--provider", "deepseek" if deepseek else "openai-codex",
                "--model", profile["model"], "--thinking", profile["effort"], "--cwd", "/workspace",
                "--session-dir", "/home/bench/.base-context/sessions"]
        install = Path(config["base_install"])
    else:
        agent_home = home / ".codex"
        agent_home.mkdir()
        if not deepseek:
            write_json(agent_home / "auth.json", json.loads(Path(config["codex_auth_source"]).read_text()), secret=True)
        config_text = 'cli_auth_credentials_store = "file"\n'
        if deepseek:
            shutil.copyfile(config["deepseek_catalog"], agent_home / "deepseek-models.json")
            config_text += 'model_catalog_json = "/home/bench/.codex/deepseek-models.json"\n'
            config_text += ('model_provider = "deepseek"\n[model_providers.deepseek]\n'
                            'name = "DeepSeek"\nbase_url = "https://api.deepseek.com"\n'
                            'wire_api = "responses"\nenv_key = "DEEPSEEK_API_KEY"\n'
                            'requires_openai_auth = false\n')
        (agent_home / "config.toml").write_text(config_text)
        environment.update({"CODEX_HOME": "/home/bench/.codex", "LOG_FORMAT": "json",
                            "RUST_LOG": "warn,codex_otel.trace_safe=info"})
        argv = [str(Path(config["codex_install"]) / "bin/codex"), "app-server", "--listen", "stdio://"]
        install = Path(config["codex_install"])
    driver = directory / "driver"
    driver.mkdir()
    (driver / "bin").mkdir()
    (driver / "bin/python").symlink_to("/usr/bin/python3.12")
    write_json(driver / "launch.json", {"command": argv, "environment": environment})
    write_json(driver / "secret-environment.json", private_environment, secret=True)
    return home, driver, install


async def copy_stream(reader, path, append=False):
    with path.open("ab" if append else "wb") as output:
        while chunk := await reader.read(65536):
            output.write(chunk)
            output.flush()


async def start_fixture(config, scenario, task_dir, workspace, directory, main_name, containers, readers):
    spec = scenario.get("fixture_service")
    if not spec:
        return
    name = main_name + "-fixture"
    containers.append(name)
    argv = [str(part).replace("{workspace}", "/workspace") for part in spec["command"]]
    if argv[0] in {"python", "python3", "python3.12"}:
        argv[0:1] = ["/usr/bin/python3.12", "-E", "-S"]
    docker = ["docker", "run", "--rm", "--name", name, "--user", f"{os.getuid()}:{os.getgid()}",
              "--network", "container:" + main_name, "--workdir", "/fixture"]
    docker += mount("/usr", "/usr") + mount(task_dir, "/fixture") + mount(workspace, "/workspace", False)
    docker += [config["container_image"], *argv]
    process = await asyncio.create_subprocess_exec(*docker, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    output_path = directory / "fixture-service.log"
    first = await asyncio.wait_for(process.stdout.readline(), spec.get("startup_timeout_seconds", 20))
    output_path.write_bytes(first)
    words = first.decode().strip().split()
    if len(words) != 2 or words[0] != "LISTENING" or not words[1].isdigit():
        raise RuntimeError("Original fixture service did not report LISTENING <port>")
    url = spec.get("url_template", "http://127.0.0.1:{port}").format(port=int(words[1]))
    if spec.get("url_file"):
        target = workspace / spec["url_file"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.parent.chmod(target.parent.stat().st_mode | 0o700)
        if target.exists():
            target.chmod(target.stat().st_mode | 0o600)
        target.write_text(url + "\n")
        make_read_only(target)
        make_read_only(target.parent)
    readers.append(asyncio.create_task(copy_stream(process.stdout, directory / "fixture-service-tail.log")))
    readers.append(asyncio.create_task(process.wait()))


def base_collector_command(config, directory, session_dir, output):
    """Load the selected installation's public decoder through static ESM imports."""
    package = Path(config["base_package"])
    version = json.loads((package / "package.json").read_text())["version"]
    bootstrap = directory / "collect-base-usage.mjs"
    bootstrap.write_text(
        "import { SessionManager } from " + json.dumps((package / "dist/index.js").as_uri()) + ";\n"
        "import { main } from " + json.dumps((ROOT / "collect_base_usage.mjs").as_uri()) + ";\n"
        "await main(SessionManager, " + json.dumps(version) + ");\n"
    )
    return [config["node"], "--experimental-sqlite", str(bootstrap),
            "--session-dir", str(session_dir), "--out", str(output)]


async def run_attempt(spec, config, output):
    directory = output.parent
    directory.mkdir(parents=True, exist_ok=True)
    workspace = directory / "workspace"
    preparation_started = time.monotonic()
    source_task_dir, scenario = load_task(Path(config["corpus_root"]), int(spec["task_id"]))
    stress = scenario["schema"] == STRESS_SCHEMA
    # Frozen inputs are read-only. Seed scripts may copy TASK.md and the original
    # preparation helper then overwrites it. Use an owned, byte-unchanged source
    # copy with normal owner write permission; the helper protects public inputs.
    task_dir = directory / "fixture-source"
    await asyncio.to_thread(shutil.copytree, source_task_dir, task_dir)
    make_writable_tree(task_dir)
    await asyncio.to_thread(prepare_workspace, task_dir, scenario, workspace)
    home, driver, install = prepare_configuration(config, spec, directory)
    runtime_state = None
    if spec["harness"] == "base-context":
        # Native bootstrap needs a writable lock beside its Python environment.
        # Isolate that mutable state while keeping the published Node package read-only.
        runtime_state = directory / "runtime-state"
        runtime_state.mkdir()
        await asyncio.to_thread(shutil.copytree, Path(config["base_version"]) / "runtime",
                                runtime_state / "runtime", symlinks=True)
    name = "published-bench-" + uuid.uuid4().hex[:16]
    containers = [name]
    process = client = watchdog = None
    clients = []
    generation = 0
    readers = []
    candidate_service = CandidateService(config, scenario, workspace, directory, name, readers)
    first_prompt = None
    first_prompt_utc = None
    watchdog_events = []
    stages = []
    result = {"schema": "published-native-attempt-v1", "identity": spec,
              "product_build": config.get("product_build"),
              "controller_variant": config.get("controller_variant"),
              "requested_model": spec["profile"]["model"], "requested_effort": spec["profile"]["effort"],
              "original_timeout_seconds": scenario["timeout_seconds"],
              "timeout_seconds": scenario["timeout_seconds"] * config["timeout_multiplier"],
              "provider_error_observed": False, "completion": False, "status": "startup_failure",
              "prepared_at": utc_now(), "stages": stages,
              "candidate_service_events": candidate_service.events}
    native_finished = None
    startup_started = preparation_started
    try:
        docker = ["docker", "run", "--rm", "--interactive", "--name", name,
                  "--network", config.get("network", "bridge"), "--user", f"{os.getuid()}:{os.getgid()}", "--workdir", "/workspace"]
        if config.get("container_cpus") is not None:
            docker += ["--cpus", str(config["container_cpus"])]
        if config.get("container_memory") is not None:
            docker += ["--memory", str(config["container_memory"])]
        for resolver in config.get("dns", []):
            docker += ["--dns", resolver]
        docker += mount("/usr", "/usr") + mount(config["node"], "/opt/node/bin/node")
        docker += mount(config["uv"], "/opt/uv/bin/uv")
        docker += mount(install, install) + mount(workspace, "/workspace", False) + mount(home, "/home/bench", False)
        docker += mount(driver, "/bench") + mount(ROOT / "native_container_entry.py", "/entry.py")
        for path in ("/etc/ssl/certs", "/etc/ld.so.cache"):
            docker += mount(path, path)
        if spec["harness"] == "base-context":
            version = Path(config["base_version"])
            docker += mount(runtime_state, version, False)
            docker += mount(version / "node_modules", version / "node_modules")
            docker += mount(version / "package.json", version / "package.json")
            prefix = Path(config["python_base"])
            docker += mount(prefix / "bin", prefix / "bin") + mount(prefix / "lib", prefix / "lib")
        docker += [config["container_image"], "/usr/bin/python3.12", "/entry.py"]
        result["native_launch_started_at"] = utc_now()
        startup_started = time.monotonic()
        process = await asyncio.create_subprocess_exec(*docker, stdin=asyncio.subprocess.PIPE,
                                                       stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stderr_reader = asyncio.create_task(copy_stream(process.stderr, directory / "native-stderr.jsonl"))
        readers.append(stderr_reader)
        client_class = BaseContextProtocol if spec["harness"] == "base-context" else CodexProtocol
        client = client_class(process, directory / "native-events.jsonl")
        clients.append(client)
        params = {}
        if spec["harness"] == "codex":
            params = {"model": spec["profile"]["model"],
                      "modelProvider": "deepseek" if spec["profile"]["family"] == "deepseek" else "openai",
                      "cwd": "/workspace", "approvalPolicy": "never", "sandbox": config["codex_sandbox"],
                      "config": {**config.get("codex_thread_config", {}),
                                 "model_reasoning_effort": spec["profile"]["effort"]}, "ephemeral": False}
        ready = await client.ready(params)
        if spec["harness"] == "base-context":
            resolved = {"model": (ready.get("model") or {}).get("id"), "provider": (ready.get("model") or {}).get("provider"),
                        "effort": ready.get("thinkingLevel")}
        else:
            resolved = {"model": ready.get("model"), "provider": ready.get("modelProvider"),
                        "effort": ready.get("reasoningEffort"), "thread_id": (ready.get("thread") or {}).get("id")}
        result["resolved"] = resolved
        if resolved["model"] != spec["profile"]["model"] or resolved["effort"] != spec["profile"]["effort"]:
            raise RuntimeError("Native readiness resolved a different requested model or effort")
        result["native_ready_at"] = utc_now()
        await start_fixture(config, scenario, task_dir, workspace, directory, name, containers, readers)
        watchdog_argv = [sys.executable, str(ROOT / "deadline_watchdog.py")]
        result["containment"] = {"backend": "owned-pid-namespace-init-sigkill", "containers": list(containers), "namespace_init_pids": []}
        if scenario.get("candidate_service"):
            result["containment"]["candidate_container"] = candidate_service.name
            result["containment"]["candidate_shares_agent_pid_namespace"] = True
        for container in containers:
            _, text, _ = await command("docker", "inspect", "--format", "{{.State.Pid}}", container)
            pid = int(text.strip())
            if pid <= 0:
                raise RuntimeError("Owned container stopped before first prompt")
            result["containment"]["namespace_init_pids"].append(pid)
            watchdog_argv += ["--namespace-init-pid", str(pid)]
        watchdog = await asyncio.create_subprocess_exec(*watchdog_argv, stdin=asyncio.subprocess.PIPE,
                                                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                        start_new_session=True)
        watchdog_ready = json.loads(await watchdog.stdout.readline())
        if not watchdog_ready.get("ready"):
            raise RuntimeError("External deadline watchdog not ready")

        def before_send():
            nonlocal first_prompt, first_prompt_utc
            if first_prompt is not None:
                return
            first_prompt = time.monotonic()
            first_prompt_utc = utc_now()
            watchdog.stdin.write((json.dumps({"first_prompt_monotonic": first_prompt,
                                              "timeout_seconds": result["timeout_seconds"]}) + "\n").encode())
            asyncio.get_running_loop().call_soon(write_json, directory / "timing.json", {
                "first_prompt_monotonic": first_prompt, "first_prompt_at": first_prompt_utc,
                "deadline_monotonic": first_prompt + result["timeout_seconds"],
                "timeout_seconds": result["timeout_seconds"]})

        async def watchdog_request(message, response_key):
            watchdog.stdin.write((json.dumps(message) + "\n").encode())
            await watchdog.stdin.drain()
            while line := await watchdog.stdout.readline():
                event = json.loads(line)
                watchdog_events.append(event)
                if event.get(response_key):
                    return event
                if event.get("reason"):
                    raise RuntimeError("Deadline watchdog stopped: " + str(event))
            raise RuntimeError("Deadline watchdog closed during restart")

        for index, stage in enumerate(scenario["stages"]):
            if index:
                await asyncio.to_thread(inject_stage, task_dir, workspace, stage, "main")
                for editable in scenario["editable_paths"]:
                    make_writable_tree(workspace / editable)
            await candidate_service.before_stage(str(stage["id"]))
            text = scenario["initial_prompt"] if index == 0 else stage["message"]
            if index == 0 and config.get("task_instructions"):
                text = config["task_instructions"].strip() + "\n\n" + text
            stage_result = await client.prompt(text, spec["profile"]["effort"], before_send=before_send)
            stages.append({"index": index, "native": stage_result})
            if stress and spec["harness"] == "codex":
                stages[-1]["settlement"] = await client.wait_for_family_idle()
            if stage_result["status"] != "completed":
                break
            if stress and stage.get("compact_after"):
                stages[-1]["compaction"] = await client.compact()
                if spec["harness"] == "codex":
                    stages[-1]["compaction"]["settlement"] = await client.wait_for_family_idle()
            if stress and stage.get("cold_resume_after"):
                identity = await client.resume_identity()
                remaining = first_prompt + result["timeout_seconds"] - time.monotonic()
                async with asyncio.timeout(max(0, remaining)):
                    await watchdog_request({"begin_restart": True}, "restart_ready")
                    await command("docker", "rm", "--force", name)
                    await process.wait()
                    await stderr_reader
                    await client.close()
                    if spec["harness"] == "base-context":
                        launch = json.loads((driver / "launch.json").read_text())
                        launch["command"] += ["--session", identity["sessionFile"]]
                        write_json(driver / "launch.json", launch)
                    if watchdog.returncode is not None:
                        raise RuntimeError("Deadline watchdog exited before namespace restart")
                    generation += 1
                    process = await asyncio.create_subprocess_exec(
                        *docker, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE)
                    stderr_reader = asyncio.create_task(copy_stream(
                        process.stderr, directory / "native-stderr.jsonl", append=True))
                    readers.append(stderr_reader)
                    client = client_class(process, directory / f"native-events-resume-{generation}.jsonl")
                    clients.append(client)
                    # Register the new namespace before native readiness or another prompt.
                    # Docker's attach process is admitted before the daemon reports its PID.
                    pid = 0
                    while pid <= 0:
                        if watchdog.returncode is not None:
                            raise RuntimeError("Deadline watchdog exited during namespace restart")
                        code, text, _ = await command("docker", "inspect", "--format", "{{.State.Pid}}", name,
                                                      check=False)
                        pid = int(text.strip()) if code == 0 else 0
                        if pid <= 0:
                            if process.returncode is not None:
                                raise RuntimeError("Restarted native container exited before registration")
                            await asyncio.sleep(0.05)
                    registered = await watchdog_request({"namespace_init_pids": [pid]}, "namespace_registered")
                    result["containment"]["namespace_init_pids"].append(pid)
                    ready = await client.ready(params, resume=identity)
                    if watchdog.returncode is not None:
                        raise RuntimeError("Deadline watchdog exited during native resume")
                    if spec["harness"] == "base-context":
                        resumed_model = (ready.get("model") or {}).get("id")
                        resumed_effort = ready.get("thinkingLevel")
                    else:
                        resumed_model, resumed_effort = ready.get("model"), ready.get("reasoningEffort")
                    if (resumed_model, resumed_effort) != (spec["profile"]["model"], spec["profile"]["effort"]):
                        raise RuntimeError("Cold resume changed the requested model or effort")
                    stages[-1]["cold_resume"] = {"status": "completed", "identity": identity,
                                                 "generation": registered["generation"]}
        process.stdin.close()
        await process.wait()
        native_finished = time.monotonic()
        result["native_exit_code"] = process.returncode
        result["completion"] = len(stages) == len(scenario["stages"]) and all(s["native"]["status"] == "completed" for s in stages) and process.returncode == 0
        result["status"] = "completed" if result["completion"] else "product_failure"
    except Exception as exc:
        result["controller_observed_error"] = {"type": type(exc).__name__, "message": str(exc)}
        result["status"] = "product_failure" if first_prompt is not None else "startup_failure"
        if isinstance(exc, PermissionError):
            result["measurement_error"] = result["controller_observed_error"]
            result["status"] = "measurement_failure"
    finally:
        # The watcher remains armed until all containers, including private services, have stopped.
        await candidate_service.close()
        for container in reversed(containers):
            await command("docker", "rm", "--force", container, check=False)
        if process is not None:
            await process.wait()
        if native_finished is None:
            native_finished = time.monotonic()
        if watchdog is not None:
            if watchdog.returncode is None:
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    watchdog.stdin.write(b'{"done":true}\n')
                    await watchdog.stdin.drain()
                watchdog.stdin.close()
            remainder, watchdog_error = await watchdog.communicate()
            watchdog_events.extend(json.loads(line) for line in remainder.splitlines() if line.strip())
            write_json(directory / "deadline.json", {"events": watchdog_events, "stderr": watchdog_error.decode()})
            exit_seen = next((event["native_exit_monotonic"] for event in watchdog_events
                              if "native_exit_monotonic" in event and event.get("generation", 0) == generation), None)
            deadline_kill = next((event for event in watchdog_events if event.get("reason") == "timeout"), None)
            if exit_seen is not None:
                result["native_exit_observed_monotonic"] = exit_seen
                native_finished = exit_seen
            if deadline_kill is not None and exit_seen is None:
                native_finished = deadline_kill["kill_monotonic"]
                result["status"] = "timeout"
                result["completion"] = False
        if clients:
            result["protocol_provider_errors"] = [error for item in clients for error in item.provider_errors]
            result["provider_error_observed"] = bool(result["protocol_provider_errors"])
            if spec["harness"] == "codex":
                result["protocol_errors"] = [error for item in clients for error in item.errors]
                result["protocol_usage_events"] = [event for item in clients for event in item.usage_events]
            else:
                result["protocol_message_usage"] = [usage for item in clients for usage in item.message_usage]
            for item in clients:
                await item.close()
        if readers:
            await asyncio.gather(*readers, return_exceptions=True)
        for secret in (home / ".base-context/auth.json", home / ".codex/auth.json", driver / "secret-environment.json"):
            secret.unlink(missing_ok=True)
    result.update({"first_prompt_at": first_prompt_utc, "first_prompt_monotonic": first_prompt,
                   "elapsed_seconds": None if first_prompt is None else native_finished - first_prompt,
                   "preparation_and_startup_seconds": (first_prompt or native_finished) - preparation_started,
                   "native_startup_seconds": (first_prompt or native_finished) - startup_started,
                   "native_finished_at": utc_now(), "deadline_events": watchdog_events})
    collector_output = directory / "native-usage.json"
    if spec["harness"] == "base-context":
        collector_command = base_collector_command(config, directory, home / ".base-context/sessions", collector_output)
    else:
        collector_command = [sys.executable, str(ROOT / "collect_codex_usage.py"), "--codex-home", str(home / ".codex"),
                             "--stderr", str(directory / "native-stderr.jsonl"), "--out", str(collector_output)]
    code, out, err = await command(*collector_command, check=False)
    (directory / "collector.log").write_text(out + err)
    if code:
        write_json(output, result)
        raise RuntimeError("Native numeric collector failed; raw attempt retained")
    usage = json.loads(collector_output.read_text())
    result["provider_error_observed"] |= bool(usage.get("provider_error_observed"))
    result["usage_path"] = str(collector_output)
    price_output = directory / "api-rate-cost.json"
    code, out, err = await command(sys.executable, ROOT / "price_usage.py", "--usage", collector_output,
                                   "--harness", spec["harness"], "--out", price_output, check=False)
    (directory / "pricing.log").write_text(out + err)
    if code:
        write_json(output, result)
        raise RuntimeError("Mechanical usage pricing failed; raw attempt retained")
    result["api_rate_cost"] = json.loads(price_output.read_text())
    result["valid_for_selection"] = not result["provider_error_observed"] and not result.get("measurement_error")
    if stress:
        judge, judge_seconds, transcript = await asyncio.to_thread(
            run_stress_judge, task_dir, scenario, workspace, config["node"])
    else:
        judge, judge_seconds, transcript = await asyncio.to_thread(run_judge, task_dir, scenario, workspace, "/usr/bin/bwrap")
    result["judge"] = judge
    result["judge_seconds"] = judge_seconds
    (directory / "judge.log").write_text(transcript)
    result["recorded_at"] = utc_now()
    write_json(output, result)
    if runtime_state is not None:
        await asyncio.to_thread(shutil.rmtree, runtime_state)
    if result.get("measurement_error"):
        raise RuntimeError("Controller permission failure; raw attempt retained and campaign stopped")
    return result


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    spec_path = args.spec.resolve()
    spec = json.loads(spec_path.read_text())
    config_path = Path(spec["config_path"])
    if not config_path.is_absolute():
        config_path = spec_path.parent / config_path
    config = json.loads(config_path.read_text())
    if spec["harness"] == "base-context":
        for key in ("base_version", "base_package"):
            if not Path(config[key]).is_absolute():
                raise ValueError(f"{key} must be an absolute installed directory, not a version label")
    await run_attempt(spec, config, args.out.resolve())


if __name__ == "__main__":
    asyncio.run(main())
