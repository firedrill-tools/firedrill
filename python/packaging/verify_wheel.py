"""Install and exercise a release wheel with no external Node or npm on PATH."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
import venv
import zipfile


def run(command, *, environment, cwd, expected=0, timeout=120):
    result = subprocess.run(command, cwd=cwd, env=environment, capture_output=True, text=True, timeout=timeout)
    if result.returncode != expected:
        raise RuntimeError(f"{command!r} failed ({result.returncode})\n{result.stdout}\n{result.stderr}")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    parser.add_argument("--agent", action="store_true", help="Also install the official Agent SDK extra and verify its bundled executable")
    parser.add_argument("--sdk-tests", type=Path, help="Run the Python SDK suite against the installed wheel")
    arguments = parser.parse_args()
    wheel = arguments.wheel.resolve()
    if wheel.stat().st_size >= 100 * 1024 * 1024:
        raise RuntimeError("Wheel exceeds PyPI's default 100 MiB file-size limit.")
    with zipfile.ZipFile(wheel) as archive:
        if any((item.external_attr >> 16) & 0o170000 == 0o120000 for item in archive.infolist()):
            raise RuntimeError("Wheel contains a symlink.")
        required = [
            "firedrill/_runtime/app/bridge.mjs",
            "firedrill/_runtime/app/node_modules/@firedrill-run/cli/dist/bin.js",
            "firedrill/_runtime/app/node_modules/npm/bin/npm-cli.js",
            "firedrill/_runtime/app/node_modules/pnpm/bin/pnpm.cjs",
        ]
        for name in required:
            if name not in archive.namelist():
                raise RuntimeError(f"Wheel is missing {name}")
        metadata = archive.read(next(name for name in archive.namelist() if name.endswith(".dist-info/METADATA"))).decode()
        agent_requirement = next(line.removeprefix("Requires-Dist: ").split(";")[0].strip() for line in metadata.splitlines() if line.startswith("Requires-Dist: claude-agent-sdk"))
    with tempfile.TemporaryDirectory(prefix="firedrill-python-consumer-") as temporary:
        root = Path(temporary)
        environment_root = root / "venv"
        venv.EnvBuilder(with_pip=True).create(environment_root)
        scripts = environment_root / ("Scripts" if os.name == "nt" else "bin")
        interpreter = scripts / ("python.exe" if os.name == "nt" else "python")
        command = scripts / ("firedrill.exe" if os.name == "nt" else "firedrill")
        run([str(interpreter), "-m", "pip", "install", "--no-index", "--no-deps", str(wheel)], environment=os.environ, cwd=root)
        if arguments.agent:
            run([str(interpreter), "-m", "pip", "install", agent_requirement], environment=os.environ, cwd=root)
        if arguments.sdk_tests:
            run([str(interpreter), "-m", "pip", "install", "pytest>=7.4"], environment=os.environ, cwd=root)
        environment = dict(os.environ)
        environment.pop("NODE_PATH", None)
        environment.pop("FIREDRILL_RUNTIME_DIR", None)
        environment.pop("PYTHONPATH", None)
        environment["PATH"] = str(scripts)
        if os.name == "nt":
            environment["PATH"] += os.pathsep + str(Path(environment["SystemRoot"]) / "System32")
        for executable in ("node", "npm", "pnpm"):
            if shutil.which(executable, path=environment["PATH"]):
                raise RuntimeError(f"Acceptance PATH unexpectedly contains {executable}")
        if arguments.agent:
            run([str(interpreter), "-c", "import json,subprocess; from firedrill._process import runtime_environment,runtime_directory; env=runtime_environment(); expected=json.loads((runtime_directory()/'app/node_modules/@anthropic-ai/claude-agent-sdk/package.json').read_text())['claudeCodeVersion']; version=subprocess.check_output([env['FIREDRILL_AGENT_EXECUTABLE'],'--version'],env=env,text=True).strip(); assert version.startswith(expected+' '),(expected,version)"], environment=environment, cwd=root)
            agent_home = root / "agent-home"
            agent_home.mkdir()
            # Only operating-system essentials cross this boundary. Never pick
            # up a developer's provider key, login session, or project settings.
            agent_environment = {key: value for key, value in environment.items() if key in {"PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"}}
            agent_environment.update({
                "HOME": str(agent_home), "USERPROFILE": str(agent_home),
                "CLAUDE_CONFIG_DIR": str(agent_home / ".claude"),
                "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            })
            probe = Path(__file__).with_name("agent_probe.mjs").resolve()
            run([str(interpreter), "-c", "import subprocess,sys; from firedrill._process import runtime_environment,runtime_directory; runtime=runtime_directory(); env=runtime_environment(); node=runtime/'bin'/('node.exe' if sys.platform=='win32' else 'node'); subprocess.run([str(node),sys.argv[1],str(runtime/'app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'),env['FIREDRILL_AGENT_EXECUTABLE']],env=env,check=True)", str(probe)], environment=agent_environment, cwd=agent_home, timeout=45)
        project = root / "project"
        project.mkdir()
        run([str(command), "--help"], environment=environment, cwd=project)
        run([str(command), "init", "--path", "template", "--json"], environment=environment, cwd=project)
        run([str(command), "validate", "--json"], environment=environment, cwd=project)
        output = run([str(command), "run", "changes-resource", "--json"], environment=environment, cwd=project)
        if json.loads(output).get("verdict") != "passed":
            raise RuntimeError(f"Installed drill did not pass: {output}")
        report_index = project / ".firedrill/reports/index.html"
        if not report_index.is_file():
            raise RuntimeError("The installed CLI did not generate the local HTML report index.")
        run([str(interpreter), "-c", "from firedrill import run_drills; result=run_drills(); result.assert_passed()"], environment=environment, cwd=project)
        drill = project / "firedrill/drills/changes-resource.drill.yaml"
        source = drill.read_bytes()
        try:
            before, separator, after = source.rpartition(b"value: 7")
            if not separator:
                raise RuntimeError("Template assertion to deliberately fail is missing.")
            drill.write_bytes(before + b"value: 8" + after)
            failure = json.loads(run([str(command), "run", "changes-resource", "--json"], environment=environment, cwd=project, expected=1))
            if failure.get("verdict") != "failed":
                raise RuntimeError("The deliberate failed assertion was not reported as a failed drill.")
            trial = failure["drills"][0]["trials"][0]
            report = Path(trial["reportDirectory"])
            run([str(command), "report", "verify", str(report), "--json"], environment=environment, cwd=project)
            html = Path(trial["htmlReport"])
            original_report = html.read_bytes()
            try:
                html.write_bytes(original_report + b"\n")
                run([str(command), "report", "verify", str(report), "--json"], environment=environment, cwd=project, expected=1)
            finally:
                html.write_bytes(original_report)
        finally:
            drill.write_bytes(source)
        run([str(command), "run", "changes-resource", "--json"], environment=environment, cwd=project)
        tool_source = root / "independent-tool"
        run([str(command), "tool", "create", "wheel-records", "--package", "--root", str(tool_source), "--json"], environment=environment, cwd=root)
        tool_project = root / "tool-consumer"
        tool_project.mkdir()
        run([str(command), "init", "--tool", str(tool_source), "--install", "--json"], environment=environment, cwd=tool_project)
        run([str(command), "tool", "validate", "wheel-records", "--json"], environment=environment, cwd=tool_project)
        run([str(command), "tool", "test", "wheel-records", "--json"], environment=environment, cwd=tool_project)
        inspector = subprocess.Popen([str(command), "inspect", "--json", "--no-open", "--port", "0"], cwd=project, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        messages = queue.Queue()
        def collect():
            assert inspector.stdout is not None
            for line in inspector.stdout:
                messages.put(line)
        threading.Thread(target=collect, daemon=True).start()
        try:
            message = json.loads(messages.get(timeout=30))
            if message.get("status") != "ready":
                raise RuntimeError(f"Inspector failed to start: {message}")
            with urllib.request.urlopen(message["url"], timeout=10) as response:
                if response.status != 200 or b"<html" not in response.read().lower():
                    raise RuntimeError("The installed inspector did not serve its bundled UI.")
        finally:
            if os.name == "nt":
                # The Windows console entry point has an owned Node child.
                # Kill this exact process tree before its parent PID exits.
                subprocess.run([str(Path(environment["SystemRoot"]) / "System32/taskkill.exe"), "/PID", str(inspector.pid), "/T", "/F"], capture_output=True, check=False)
            else:
                inspector.terminate()
            try:
                inspector.wait(timeout=10)
            except subprocess.TimeoutExpired:
                inspector.kill()
                inspector.wait()
        if arguments.sdk_tests:
            run([str(interpreter), "-m", "pytest", str(arguments.sdk_tests.resolve()), "-q"], environment=environment, cwd=root, timeout=600)
        print(json.dumps({"wheel": wheel.name, "installation": "offline", "externalNode": False, "cli": "passed", "pythonSdk": "passed", "failedAssertions": "passed", "reportTamper": "detected", "toolInstallation": "passed", "reports": "passed", "inspector": "passed", "agentExecutable": "passed" if arguments.agent else "not requested", "sdkSuite": "passed" if arguments.sdk_tests else "not requested"}))


if __name__ == "__main__":
    main()
