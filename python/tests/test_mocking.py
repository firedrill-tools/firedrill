import contextvars
import sys
import threading
import types

from firedrill import mock_tool


def test_mock_context_is_explicit_across_new_threads(monkeypatch):
    module = types.ModuleType("firedrill_test_thread_agent")
    original_calls = []
    synthetic_calls = []

    def original(value):
        original_calls.append(value)
        return "original"

    class BoundWorld:
        def invoke(self, operation, arguments, **options):
            synthetic_calls.append(arguments)
            return {"outcome": {"status": "ok", "value": "synthetic"}}

    module.send = original
    monkeypatch.setitem(sys.modules, module.__name__, module)
    results = []
    with mock_tool(
        module.__name__ + ".send",
        BoundWorld(),
        package_id="messages",
        operation_id="send",
        arguments=lambda value: {"message": value},
    ):
        assert module.send("caller") == "synthetic"
        for context, message in (
            (contextvars.Context(), "unbound thread"),
            (contextvars.copy_context(), "inherited thread"),
        ):
            worker = threading.Thread(
                target=context.run,
                args=(lambda value: results.append(module.send(value)), message),
            )
            worker.start()
            worker.join(timeout=2)
            assert not worker.is_alive()
    assert results == ["original", "synthetic"]
    assert original_calls == ["unbound thread"]
    assert synthetic_calls == [{"message": "caller"}, {"message": "inherited thread"}]
    assert module.send is original
