"""Exercise fixtures as an end-user pytest process, including test isolation."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def test_pytest_fixture_isolates_state_and_marker_controls_run(tmp_path):
    source = Path(__file__).resolve().parents[2] / "examples/quickstart"
    shutil.copytree(source / "firedrill", tmp_path / "firedrill")
    shutil.copyfile(source / "firedrill.json", tmp_path / "firedrill.json")
    target = tmp_path / "firedrill/targets/local-agent.target.yaml"
    target.unlink()
    target.with_suffix(".json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "target": {
                    "id": "local-agent",
                    "kind": "external",
                    "bindings": ["direct"],
                    "timeoutMs": 5000,
                },
            }
        )
    )
    (tmp_path / "test_example.py").write_text("""import pytest

def test_first(firedrill_world):
    assert firedrill_world.state(package_id='workspace',namespace='records') == []
    firedrill_world.call(actor_id='agent',package_id='workspace',operation_id='records.set',arguments={'value':18},idempotency_key='first')

def test_second(firedrill_world):
    assert firedrill_world.state(package_id='workspace',namespace='records') == []

@pytest.mark.firedrill(drill='set-record',seed='987')
def test_run(firedrill):
    def agent(context):
        return context.binding.world.invoke({'packageId':'workspace','operationId':'records.set'},context.task.input,idempotency_key='pytest')
    result = firedrill.run(agent=agent)
    result.assert_passed()
    assert result.drills[0].trials[0].seed == '987'
""")
    env = dict(os.environ)
    if env.get("PYTHONPATH"):
        # The child runs in a temporary project. Preserve source tests' import
        # paths, but do not insert a source tree into installed-wheel proofs.
        env["PYTHONPATH"] = os.pathsep.join(
            str(Path(part or ".").resolve())
            for part in env["PYTHONPATH"].split(os.pathsep)
        )
    env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-p", "firedrill.pytest_plugin", "-q"],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "3 passed" in result.stdout
