"""Public Python entry points against the packaged real engine and SQLite."""

import asyncio
import base64
import json
import re
import shutil
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from firedrill import (
    AbortSignal,
    AsyncWorld,
    DrillAssertionError,
    FiredrillError,
    World,
    compare_runs,
    inspect_tool,
    mock_tool,
    run_drills,
    run_drills_async,
    start_inspector,
    verify_report,
)


@pytest.fixture
def project(tmp_path):
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
                    "bindings": ["direct", "http", "mcp", "cli"],
                    "timeoutMs": 5000,
                },
            }
        )
    )
    return tmp_path


def agent(context):
    return context.binding.world.invoke(
        {"packageId": "workspace", "operationId": "records.set"},
        context.task.input,
        idempotency_key="set-primary",
    ).outcome.value


def test_world_real_state_endpoints_reset_inspector_and_cleanup(project):
    with World.from_project(project) as world:
        description = world.describe()
        assert description.tools[0].package_id == "workspace"
        result = world.call(
            actor_id="agent",
            package_id="workspace",
            operation_id="records.set",
            arguments={"value": 21},
            idempotency_key="first",
        )
        assert result.outcome.value == {"value": 21}
        assert world.state(package_id="workspace", namespace="records")[0].value == {
            "value": 21
        }
        export = world.export_scenario("from-python")
        assert export.record_count == 1
        saved = world.save_scenario(
            "from-python", expected_source_hash=export.source_hash
        )
        assert (project / saved.path).is_file()
        with world.listen(actor_id="agent") as binding:
            assert "FIREDRILL_HTTP_TOKEN" in binding.environment
            assert "FIREDRILL_MCP_URL" in binding.environment
            assert "FIREDRILL_CLI_URL" in binding.environment
            request = urllib.request.Request(
                binding.http.url + "/api/records/primary",
                data=b'{"value":22}',
                method="PUT",
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": binding.http.token,
                    "idempotency-key": "http-value",
                },
            )
            with urllib.request.urlopen(request) as response:
                assert json.load(response) == {"value": 22}
            with world.inspect(binding=binding) as inspector:
                with urllib.request.urlopen(inspector.url) as response:
                    assert response.status == 200
            world.reset(packages=["workspace"])
            assert world.state(package_id="workspace", namespace="records") == []
            world.reset()
            assert binding.environment["FIREDRILL_HTTP_TOKEN"]
        assert world.evidence() is not None
    with pytest.raises(FiredrillError):
        world.describe()


def test_python_drills_real_assertions_reports_hooks_failure_and_reproduction(project):
    hooks = []
    result = run_drills(
        project,
        drill="set-record",
        agent=agent,
        seed="42",
        hooks={
            "before_all": lambda c: hooks.append(c.drill_ids),
            "after_drill": lambda c: hooks.append(c.result.verdict),
        },
    )
    result.assert_passed()
    assert hooks == [["set-record"], "passed"]
    assert Path(result.report_index).is_file()
    trial = result.drills[0].trials[0]
    report = Path(trial.report.directory)
    verify_report(report)
    repeated = run_drills(
        project,
        drill="set-record",
        agent=agent,
        seed="42",
        build_hash=result.build_hash,
    )
    repeated.assert_passed()
    comparison = compare_runs(report, repeated.drills[0].trials[0].report.directory)
    assert comparison
    failed = run_drills(project, drill="set-record", agent=lambda _: None)
    assert failed.verdict == "failed"
    with pytest.raises(DrillAssertionError):
        failed.assert_passed()
    assert Path(failed.report_index).is_file()


def test_async_agent_uses_callers_event_loop_and_async_world(project):
    async def run():
        owner = asyncio.get_running_loop()

        async def callback(context):
            assert asyncio.get_running_loop() is owner
            outcome = await context.binding.world.invoke(
                {"packageId": "workspace", "operationId": "records.set"},
                context.task.input,
                idempotency_key="async",
            )
            await context.capture.log("Called from Python")
            return outcome.outcome.value

        result = await run_drills_async(
            project, agent=callback, capture={"logs": "always"}
        )
        result.assert_passed()
        async with await AsyncWorld.from_project(project) as world:
            assert (await world.describe()).world_id == "quickstart-world"
            async with await world.listen(actor_id="agent") as binding:
                assert binding.environment["FIREDRILL_HTTP_URL"]
            await world.advance_time(1)
            await world.reset()

    asyncio.run(run())


def test_scope_is_revoked_after_agent_returns_and_capture_retained(project):
    retained = []
    artifact = project / "message.txt"
    artifact.write_text("Python artifact")

    def callback(context):
        retained.append(context.binding.world)
        context.capture.log("Executed agent callback")
        context.capture.file("message.txt", media_type="text/plain")
        context.attach("message.txt", media_type="text/plain", name="attached.txt")
        return agent(context)

    result = run_drills(
        project, agent=callback, capture={"logs": "always", "files": "always"}
    )
    result.assert_passed()
    with pytest.raises(FiredrillError):
        retained[0].invoke(
            {"packageId": "workspace", "operationId": "records.set"}, {"value": 100}
        )
    verify_report(result.drills[0].trials[0].report.directory)


def test_test_side_mock_changes_world_without_changing_agent(project):
    class CustomerLibrary:
        @staticmethod
        def write(value):
            raise AssertionError("Real service must not be contacted")

    with World.from_project(project) as world:
        globals()["CustomerLibrary"] = CustomerLibrary
        try:
            with mock_tool(
                __name__ + ".CustomerLibrary.write",
                world,
                actor_id="agent",
                package_id="workspace",
                operation_id="records.set",
                arguments=lambda value: {"value": value},
                idempotency_key="mock",
            ) as mocked:
                assert CustomerLibrary.write(7) == {"value": 7}
                mocked.assert_called_once_with(7)
            assert world.state(package_id="workspace", namespace="records")[
                0
            ].value == {"value": 7}
            with pytest.raises(AssertionError, match="Real service"):
                CustomerLibrary.write(8)
        finally:
            globals().pop("CustomerLibrary", None)


def test_tool_inspection_and_invalid_source_preserve_diagnostics(project):
    assert inspect_tool("workspace", root=project).manifest.id == "workspace"
    (project / "firedrill/world.yaml").write_text("schemaVersion: 400\n")
    with pytest.raises(FiredrillError) as caught:
        World.from_project(project)
    assert caught.value.diagnostics


def test_capture_driver_and_async_cancellation_cleanup(project):
    image = project / "screen.png"
    image.write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHZkAAAAASUVORK5CYII="
        )
    )
    calls = []

    def callback(context):
        context.capture.register_driver(
            screenshot=lambda _: {"path": "screen.png", "media_type": "image/png"},
            dispose=lambda _: calls.append("disposed"),
        )
        return agent(context)

    result = run_drills(project, agent=callback, capture={"screenshots": "always"})
    result.assert_passed()
    assert calls == ["disposed"]
    assert list(Path(result.drills[0].trials[0].report.directory).rglob("*.png"))

    async def cancel():
        entered = asyncio.Event()
        cleaned = asyncio.Event()

        async def pending(context):
            entered.set()
            try:
                await asyncio.sleep(100)
            finally:
                cleaned.set()

        running = asyncio.create_task(run_drills_async(project, agent=pending))
        await asyncio.wait_for(entered.wait(), 3)
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running
        await asyncio.wait_for(cleaned.wait(), 2)

    asyncio.run(cancel())


def test_sync_abort_finishes_with_cancelled_report(project):
    signal = AbortSignal()

    def pending(context):
        signal.abort("test requested stop")
        context.signal.wait(2)
        context.signal.throw_if_aborted()

    result = run_drills(project, agent=pending, signal=signal)
    assert result.verdict != "passed"
    trial = result.drills[0].trials[0]
    assert trial.result.status == "cancelled"
    verify_report(trial.report.directory)


def test_python_command_target_receives_tools_and_host_variables(project):
    target = project / "firedrill/targets/local-agent.target.json"
    target.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "target": {
                    "id": "local-agent",
                    "kind": "command",
                    "bindings": ["http"],
                    "executable": sys.executable,
                    "arguments": ["agent.py"],
                    "timeoutMs": 5000,
                    "environmentFromHost": {"PYTHON_TEST_MARKER": "PYTHON_TEST_MARKER"},
                },
            }
        )
    )
    (project / "agent.py").write_text("""import json,os,sys,urllib.request
invocation=json.loads(sys.stdin.readline())
assert os.environ['PYTHON_TEST_MARKER']=='from-host'
request=urllib.request.Request(os.environ['FIREDRILL_HTTP_URL']+'/api/records/primary',
 data=json.dumps(invocation['input']).encode(),method='PUT',headers={'Content-Type':'application/json',
 'x-api-key':os.environ['FIREDRILL_HTTP_TOKEN'],'idempotency-key':'python-command'})
with urllib.request.urlopen(request) as response:
 print(json.dumps(json.load(response)))
""")
    result = run_drills(project, host_environment={"PYTHON_TEST_MARKER": "from-host"})
    result.assert_passed()


def test_inspector_runs_python_external_agent_and_retains_result(project):
    with start_inspector(project, agent=agent) as inspector:
        with urllib.request.urlopen(inspector.url) as response:
            html = response.read().decode()
        token = re.search(r'name="firedrill-token" content="([^"]+)"', html).group(1)
        url = inspector.url.rstrip("/")
        headers = {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        }
        request = urllib.request.Request(
            url + "/api/v1/runs",
            data=b'{"drillId":"set-record"}',
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            request_id = json.load(response)["requestId"]
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with urllib.request.urlopen(
                urllib.request.Request(
                    url + "/api/v1/run-requests/" + request_id, headers=headers
                )
            ) as response:
                result = json.load(response)
            if result["status"] in {"completed", "failed", "cancelled"}:
                break
            time.sleep(0.05)
        assert result["status"] == "completed", result
        assert result["verdict"] == "passed", result


def test_sync_wrapper_returning_coroutine_receives_async_binding(project):
    async def actual(context):
        result = await context.binding.world.invoke(
            {"packageId": "workspace", "operationId": "records.set"},
            context.task.input,
            idempotency_key="wrapped",
        )
        await context.capture.log("Wrapped coroutine")
        return result.outcome.value

    def wrapped(context):
        return actual(context)

    asyncio.run(
        run_drills_async(project, agent=wrapped, capture={"logs": "always"})
    ).assert_passed()


def test_concurrent_function_mocks_cannot_write_another_world(project):
    class Client:
        @staticmethod
        def write(value):
            return {"production": value}

    globals()["ConcurrentClient"] = Client
    target = __name__ + ".ConcurrentClient.write"
    barrier = threading.Barrier(2)
    try:
        with (
            World.from_project(project) as first,
            World.from_project(project) as second,
        ):

            def execute(world, value):
                with mock_tool(
                    target,
                    world,
                    actor_id="agent",
                    package_id="workspace",
                    operation_id="records.set",
                    arguments=lambda value: {"value": value},
                    idempotency_key=str(value),
                ):
                    barrier.wait(timeout=3)
                    assert Client.write(value) == {"value": value}
                    barrier.wait(timeout=3)

            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [
                    pool.submit(execute, first, 11),
                    pool.submit(execute, second, 22),
                ]
                for future in futures:
                    future.result(timeout=5)
            assert first.state(package_id="workspace", namespace="records")[
                0
            ].value == {"value": 11}
            assert second.state(package_id="workspace", namespace="records")[
                0
            ].value == {"value": 22}
            assert Client.write(100) == {"production": 100}
    finally:
        globals().pop("ConcurrentClient", None)


def test_invalid_python_options_fail_before_using_unintended_defaults(project):
    with pytest.raises(FiredrillError, match="scnerio"):
        World.from_project(project, scnerio="misspelled")
    with pytest.raises(FiredrillError, match="trails"):
        run_drills(project, trails=3, agent=agent)


def test_python_callback_receiver_delivers_to_loopback_application(project):
    tool_path = project / "firedrill/tools/workspace/workspace.tool.yaml"
    record_schema = {
        "type": "object",
        "required": ["value"],
        "properties": {"value": {"type": "integer"}},
        "additionalProperties": False,
    }
    tool_path.with_suffix(".json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "module": "./behavior.js",
                "manifest": {
                    "schemaVersion": 1,
                    "id": "workspace",
                    "version": "1.0.0",
                    "engine": ">=0.1.0 <0.2.0",
                    "capabilities": ["state.read", "state.write", "event.emit"],
                    "state": [{"namespace": "records", "schema": record_schema}],
                    "operations": [
                        {
                            "id": "records.set",
                            "inputSchema": record_schema,
                            "outputSchema": record_schema,
                            "idempotency": "required",
                            "fidelity": "stateful",
                        }
                    ],
                    "events": [{"id": "record.set", "payloadSchema": record_schema}],
                    "callbacks": [
                        {
                            "id": "notify-application",
                            "eventId": "record.set",
                            "receiverId": "my_receiver",
                            "method": "POST",
                            "path": "/callbacks/records",
                            "idempotencyHeader": "Idempotency-Key",
                        }
                    ],
                },
            }
        )
    )
    tool_path.unlink()
    tool_path.with_name("behavior.js").write_text("""export default {
  operations: { "records.set": (input, context) => {
    const value = { value: Number(input.value) };
    context.state.put("records", "primary", value);
    context.events.emit("record.set", value);
    return value;
  } },
  callbacks: { "notify-application": {
    encode: ({ deliveryId, payload }) => ({
      body: { kind: "json", value: { deliveryId, ...payload } },
    }),
  } },
};
""")
    received = []

    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append(
                json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            )
            self.send_response(204)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        result = run_drills(
            project,
            agent=agent,
            callback_receivers={
                "my_receiver": {"base_url": f"http://127.0.0.1:{server.server_port}"}
            },
        )
        result.assert_passed()
        assert [item["value"] for item in received] == [7]
        evidence = result.drills[0].trials[0].evidence
        assert any(
            item.kind == "callback" and item.phase == "delivered" for item in evidence
        )
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
