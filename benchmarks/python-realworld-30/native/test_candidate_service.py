"""Two local-Docker checks using synthetic code only; no benchmark or model runs.

Run from this directory with an existing local-Docker run configuration:
    /usr/bin/python3.12 -B test_candidate_service.py --config /path/to/run-config.json
"""
import argparse
import asyncio
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

from candidate_service import CandidateService, docker_command


SERVER = """import argparse
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, required=True)
args = parser.parse_args()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = str(os.getpid()).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

server = HTTPServer(('127.0.0.1', args.port), Handler)
print('LISTENING', server.server_port, flush=True)
server.serve_forever()
"""
CONFIG = {}


class CandidateServiceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="candidate-service-test-")
        self.directory = Path(self.temporary.name)
        self.workspace = self.directory / "workspace"
        (self.workspace / "service").mkdir(parents=True)
        self.script = self.workspace / "service/server.py"
        self.main_name = "candidate-test-" + uuid.uuid4().hex[:12]
        self.readers = []
        self.candidate = CandidateService(
            CONFIG,
            {"stages": [{"id": "initial"}, {"id": "next"}], "candidate_service": {
                "command": ["python", "server.py", "--port", "0"],
                "cwd": "{workspace}/service", "url_file": "inputs/service_url.txt",
                "start_at_stage": "initial", "restart_each_stage": True,
            }},
            self.workspace, self.directory, self.main_name, self.readers,
        )
        await docker_command(
            "run", "--detach", "--rm", "--pull=never", "--name", self.main_name,
            "--user", f"{os.getuid()}:{os.getgid()}",
            "--network", CONFIG["network"],
            "--mount", "type=bind,src=/usr,dst=/usr,readonly",
            CONFIG["container_image"], "/usr/bin/python3.12", "-E", "-S", "-c",
            "import signal; signal.pause()",
        )

    async def asyncTearDown(self):
        try:
            await self.candidate.close()
        finally:
            await docker_command("rm", "--force", self.main_name, check=False)
            await asyncio.gather(*self.readers, return_exceptions=True)
            self.temporary.cleanup()

    async def fetch_pid(self, url):
        result = await docker_command(
            "exec", "--workdir", "/", self.main_name,
            "/usr/bin/python3.12", "-E", "-S", "-c",
            "import sys, urllib.request; "
            "print(urllib.request.urlopen(sys.argv[1], timeout=5).read().decode())", url,
        )
        return int(result.strip())

    async def test_happy_restart_keeps_url_and_main_namespace_exit_stops_service(self):
        self.script.write_text(SERVER)
        await self.candidate.before_stage("initial")
        url_file = self.workspace / "inputs/service_url.txt"
        first_url = url_file.read_text().strip()
        first_pid = await self.fetch_pid(first_url)
        self.assertGreater(first_pid, 1)
        await self.candidate.before_stage("next")
        self.assertEqual(url_file.read_text().strip(), first_url)
        second_pid = await self.fetch_pid(first_url)
        self.assertNotEqual(first_pid, second_pid)
        self.assertEqual([event["event"] for event in self.candidate.events],
                         ["started", "stopped", "started"])

        await docker_command("rm", "--force", self.main_name)
        await asyncio.wait_for(self.candidate.process.wait(), timeout=5)
        self.assertIsNotNone(self.candidate.process.returncode)

    async def test_broken_starter_keeps_url_and_can_recover_next_stage(self):
        self.script.write_text("raise RuntimeError('synthetic broken starter')\n")
        await self.candidate.before_stage("initial")
        url_file = self.workspace / "inputs/service_url.txt"
        first_url = url_file.read_text().strip()
        self.assertEqual(self.candidate.events[-1]["event"], "start_failed")
        self.assertIsNone(self.candidate.process)
        self.assertIn("synthetic broken starter", (self.directory / "candidate-service.log").read_text())

        self.script.write_text(SERVER)
        await self.candidate.before_stage("next")
        self.assertEqual(url_file.read_text().strip(), first_url)
        self.assertGreater(await self.fetch_pid(first_url), 1)
        self.assertEqual(self.candidate.events[-1]["event"], "started")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True,
                        help="Run configuration providing container_image and network")
    options, remaining = parser.parse_known_args()
    CONFIG = json.loads(options.config.read_text())
    unittest.main(argv=[sys.argv[0], *remaining])
