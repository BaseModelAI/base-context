"""Runner-managed candidate service in the agent's network and PID namespaces."""
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from benchlib import make_read_only


class CandidateStartupError(RuntimeError):
    """The candidate process did not announce a listening service."""


async def docker_command(*arguments, check=True):
    process = await asyncio.create_subprocess_exec(
        "docker", *map(str, arguments), stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    output, error = await process.communicate()
    if check and process.returncode:
        raise RuntimeError(f"docker {arguments[0]} failed: {error.decode(errors='replace')}")
    return output.decode(errors="replace")


class CandidateService:
    """Call before_stage before each prompt, and close in the runner's finally block.

    Only the public workspace and /usr are mounted. The candidate shares the
    main container's PID namespace; do not register its PID with the watchdog.
    """

    def __init__(self, config, scenario, workspace, directory, main_name, readers):
        self.config = config
        self.scenario = scenario
        self.spec = scenario.get("candidate_service")
        self.workspace = Path(workspace)
        self.directory = Path(directory)
        self.main_name = main_name
        self.name = main_name + "-candidate"
        self.readers = readers
        self.events = []
        self.process = None
        self.port = None
        self.url = None
        self._stage = None
        self._drainer = None
        self._output = None

    def _event(self, event, stage, **details):
        self.events.append({"kind": "candidate_service", "event": event,
                            "stage": stage, "at": datetime.now(timezone.utc).isoformat(),
                            **details})

    async def _prepare_url(self):
        url_file = self.spec.get("url_file")
        target = self.workspace / url_file if url_file else None
        if target and target.is_file():
            self.port = urlsplit(target.read_text().strip()).port
        if self.port is None:
            allocation = await docker_command(
                "exec", "--workdir", "/", self.main_name,
                "/usr/bin/python3.12", "-E", "-S", "-c",
                "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); "
                "print(s.getsockname()[1]); s.close()",
            )
            self.port = int(allocation.strip())
        self._publish_url()

    def _publish_url(self):
        self.url = self.spec.get("url_template", "http://127.0.0.1:{port}").format(port=self.port)
        url_file = self.spec.get("url_file")
        target = self.workspace / url_file if url_file else None
        if target:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.parent.chmod(target.parent.stat().st_mode | 0o700)
            if target.exists():
                target.chmod(target.stat().st_mode | 0o600)
            target.write_text(self.url + "\n")
            make_read_only(target)
            make_read_only(target.parent)

    async def _drain(self):
        try:
            while chunk := await self.process.stdout.read(65536):
                self._output.write(chunk)
                self._output.flush()
        finally:
            self._output.close()

    async def _start(self):
        argv = [str(part).replace("{workspace}", "/workspace") for part in self.spec["command"]]
        if argv[0] in {"python", "python3", "python3.12"}:
            argv[0:1] = ["/usr/bin/python3.12", "-E", "-S", "-u"]
        if "--port" in argv:
            index = argv.index("--port") + 1
            argv[index:index + 1] = [str(self.port)]
        else:
            argv += ["--port", str(self.port)]
        cwd = self.spec.get("cwd", "{workspace}").replace("{workspace}", "/workspace")
        command = [
            "docker", "run", "--rm", "--pull=never", "--name", self.name,
            "--user", f"{os.getuid()}:{os.getgid()}",
            "--network", "container:" + self.main_name,
            "--pid", "container:" + self.main_name, "--workdir", cwd,
            "--mount", "type=bind,src=/usr,dst=/usr,readonly",
            "--mount", f"type=bind,src={self.workspace},dst=/workspace",
            self.config["container_image"], *argv,
        ]
        self._output = (self.directory / "candidate-service.log").open("ab")
        self.process = await asyncio.create_subprocess_exec(
            *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        try:
            async with asyncio.timeout(float(self.spec.get("startup_timeout_seconds", 20))):
                while line := await self.process.stdout.readline():
                    self._output.write(line)
                    self._output.flush()
                    words = line.decode(errors="replace").strip().split()
                    if len(words) == 2 and words[0] == "LISTENING" and words[1].isdigit():
                        self.port = int(words[1])
                        self._publish_url()
                        self._drainer = asyncio.create_task(self._drain())
                        self.readers.append(self._drainer)
                        return
                code = await self.process.wait()
                if code == 125:
                    raise RuntimeError("Docker could not start the candidate container; see candidate-service.log")
                raise CandidateStartupError(f"candidate did not report LISTENING <port> (exit {code})")
        except TimeoutError as error:
            raise CandidateStartupError("candidate startup timed out before LISTENING <port>") from error

    async def _stop(self):
        if self.process is not None:
            await docker_command("rm", "--force", self.name, check=False)
            await self.process.wait()
            if self._drainer is not None:
                await self._drainer
            self.process = None
            self._drainer = None
        if self._output is not None:
            self._output.close()
            self._output = None

    async def before_stage(self, stage_id):
        if not self.spec:
            return
        stages = [str(stage["id"]) for stage in self.scenario["stages"]]
        start_at = str(self.spec.get("start_at_stage", "initial"))
        if stages.index(stage_id) < stages.index(start_at):
            return
        if self.process is not None:
            if not self.spec.get("restart_each_stage", False):
                return
            await self._stop()
            self._event("stopped", stage_id)
        self._stage = stage_id
        if self.port is None:
            await self._prepare_url()
        try:
            await self._start()
        except CandidateStartupError as error:
            await self._stop()
            self._event("start_failed", stage_id, error=f"{type(error).__name__}: {error}")
            return
        self._event("started", stage_id, url=self.url)

    async def close(self):
        running = self.process is not None
        await self._stop()
        if running:
            self._event("stopped", self._stage)
