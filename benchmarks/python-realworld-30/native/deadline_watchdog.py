#!/usr/bin/env python3
"""Kill owned task processes at an explicitly armed first-prompt deadline."""
import argparse
import errno
import json
import os
import selectors
import signal
import time


def main():
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--cgroup")
    target.add_argument("--namespace-init-pid", type=int, action="append")
    args = parser.parse_args()
    if args.cgroup:
        kill_fd = os.open(os.path.join(args.cgroup, "cgroup.kill"), os.O_WRONLY)
    else:
        kill_fds = [os.pidfd_open(pid) for pid in args.namespace_init_pid]
        for fd in kill_fds:
            signal.pidfd_send_signal(fd, 0)

    def kill_owned():
        try:
            if args.cgroup:
                os.write(kill_fd, b"1")
            else:
                for fd in kill_fds:
                    try:
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        except OSError as error:
            if error.errno not in {errno.ESRCH, errno.ENOENT, errno.ENODEV}:
                raise
    selector = selectors.DefaultSelector()
    selector.register(0, selectors.EVENT_READ)
    if not args.cgroup:
        selector.register(kill_fds[0], selectors.EVENT_READ)
    deadline = None
    pending = b""
    print(json.dumps({"ready": True}), flush=True)
    try:
        while True:
            remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
            events = selector.select(remaining)
            if deadline is not None and time.monotonic() >= deadline:
                killed_at = time.monotonic()
                kill_owned()
                print(json.dumps({"reason": "timeout", "deadline_monotonic": deadline,
                                  "kill_monotonic": killed_at}), flush=True)
                return
            if not args.cgroup and any(key.fd == kill_fds[0] for key, _ in events):
                selector.unregister(kill_fds[0])
                print(json.dumps({"native_exit_monotonic": time.monotonic()}), flush=True)
            if not any(key.fd == 0 for key, _ in events):
                continue
            chunk = os.read(0, 65536)
            if not chunk:
                kill_owned()
                print(json.dumps({"reason": "controller_closed"}), flush=True)
                return
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                message = json.loads(line)
                if message.get("done"):
                    kill_owned()
                    print(json.dumps({"reason": "finished"}), flush=True)
                    return
                if deadline is not None:
                    raise ValueError("The first-prompt deadline cannot be reset")
                deadline = float(message["first_prompt_monotonic"]) + float(message["timeout_seconds"])
                print(json.dumps({"armed": True, "deadline_monotonic": deadline}), flush=True)
    finally:
        for fd in ([kill_fd] if args.cgroup else kill_fds):
            os.close(fd)
        selector.close()


if __name__ == "__main__":
    main()
