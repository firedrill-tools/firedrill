"""Console entry point forwarding directly to the packaged Firedrill CLI."""

from __future__ import annotations

import os
import signal
import subprocess
import sys

from ._process import runtime_command, runtime_environment
from .errors import FiredrillError


def main() -> int:
    try:
        command = [*runtime_command("cli"), *sys.argv[1:]]
        environment = runtime_environment()
        if (
            sys.argv[1:2] == ["agent"]
            and "--help" not in sys.argv[2:]
            and "-h" not in sys.argv[2:]
            and not environment.get("FIREDRILL_AGENT_EXECUTABLE")
        ):
            print(
                "Install the optional authoring agent with: pip install 'firedrill-run[agent]'",
                file=sys.stderr,
            )
            return 1
        if os.name != "nt":
            os.execve(command[0], command, environment)
        child = subprocess.Popen(
            command, env=environment, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        )
        try:
            return child.wait()
        except KeyboardInterrupt:
            child.send_signal(
                signal.CTRL_BREAK_EVENT
                if hasattr(signal, "CTRL_BREAK_EVENT")
                else signal.SIGTERM
            )
            return child.wait()
    except FiredrillError as error:
        print(f"{error.code}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
