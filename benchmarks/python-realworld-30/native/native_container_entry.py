"""Container PID 1: load a private environment, then exec the installed CLI unchanged."""
import json
import os
from pathlib import Path

config = json.loads(Path("/bench/launch.json").read_text())
environment = dict(config["environment"])
environment.update(json.loads(Path("/bench/secret-environment.json").read_text()))
os.chdir("/workspace")
os.execvpe(config["command"][0], config["command"], environment)
