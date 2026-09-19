import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from firedrill.browser import (
    browser_test_definition_from_result,
    bundle_browser_test_report,
    list_browser_test_reports,
    list_browser_tests,
    load_browser_test,
    run_browser_test,
    run_browser_test_async,
    save_browser_test,
    verify_browser_test_report,
)


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            b"<html><body><button onclick=\"this.textContent='Saved'\">Save</button></body></html>"
        )

    def log_message(self, *args):
        pass


def test_real_browser_actions_capture_replay_bundle_and_python_driver(tmp_path):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    events = []
    definition = {
        "schemaVersion": 1,
        "id": "save-form",
        "startUrl": f"http://127.0.0.1:{server.server_port}",
        "steps": [
            {
                "action": "click",
                "selector": {"by": "role", "role": "button", "name": "Save"},
            }
        ],
        "assertions": [
            {
                "id": "saved",
                "kind": "visible",
                "selector": {"by": "role", "role": "button", "name": "Saved"},
            }
        ],
    }
    try:
        source_path = save_browser_test(definition, root=tmp_path)
        assert load_browser_test(source_path, root=tmp_path).id == "save-form"
        assert list_browser_tests(root=tmp_path)
        result = run_browser_test(
            definition,
            root=tmp_path,
            on_event=lambda e: events.append(e.type),
            capture={"screenshot": "always", "video": "always", "trace": "always"},
        )
        result.assert_passed()
        assert events[0] == "started"
        assert events[-1] == "finished"
        verify_browser_test_report(result.report_directory).assert_passed()
        assert list_browser_test_reports(root=tmp_path)
        bundle = bundle_browser_test_report(result.report_directory)
        assert bundle.data[:2] == b"\x1f\x8b"
        replay = browser_test_definition_from_result(result, id="save-replay")
        assert replay.steps[0].action == "click"

        async def run():
            async def driver(context):
                page = await context.observe()
                assert "Save" in page.snapshot
                await context.step(
                    {
                        "action": "click",
                        "selector": {"by": "role", "role": "button", "name": "Save"},
                    }
                )

            driven = {
                **definition,
                "id": "python-browser-driver",
                "task": "Save the form",
                "steps": [],
            }
            (
                await run_browser_test_async(driven, root=tmp_path, driver=driver)
            ).assert_passed()

        asyncio.run(run())
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
