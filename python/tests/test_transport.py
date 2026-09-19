import asyncio
import concurrent.futures
import sys
import threading
import time

import pytest
from firedrill import AbortSignal, FiredrillError, sdk
from firedrill._process import Runtime, resolve_callback

SERVER = """
import sys,json
pending = None
for line in sys.stdin:
    message = json.loads(line)
    if message.get('type') == 'callback_result':
        print(json.dumps({'id':pending,'result':message.get('result')}),flush=True)
        continue
    method = message['method']
    if method == 'session.close':
        print(json.dumps({'id':message['id'],'result':None}),flush=True)
        break
    if method == 'nested':
        pending = message['id']
        print(json.dumps({'type':'callback','id':'callback','runId':'run','scope':'scope','callback':'agent','context':{}}),flush=True)
    elif method == 'invalid':
        print('not-json',flush=True)
        break
    elif method == 'failure':
        print(json.dumps({'id':message['id'],'error':{'code':'framework.TEST','message':'Expected failure','details':{'key':2},'diagnostics':[{'code':'D1'}]}}),flush=True)
    else:
        print(json.dumps({'id':message['id'],'result':message['params']}),flush=True)
"""


def test_transport_nested_calls_do_not_block_reader_and_errors_are_structured():
    with Runtime(command=[sys.executable, "-u", "-c", SERVER]) as runtime:
        runtime.register("run", lambda _: runtime.request("echo", {"nested": True}))
        assert runtime.request("nested", timeout=3) == {"nested": True}
        runtime.unregister("run")
        with pytest.raises(FiredrillError) as caught:
            runtime.request("failure", timeout=3)
        assert caught.value.code == "framework.TEST"
        assert caught.value.details == {"key": 2}
        assert caught.value.diagnostics == [{"code": "D1"}]
    with pytest.raises(FiredrillError, match="closed"):
        runtime.request("echo")


def test_invalid_runtime_protocol_fails_waiter_instead_of_hanging():
    with Runtime(command=[sys.executable, "-u", "-c", SERVER]) as runtime:
        with pytest.raises(FiredrillError) as caught:
            runtime.request("invalid", timeout=3)
        assert caught.value.code == "framework.RUNTIME_PROTOCOL_ERROR"


def test_async_callback_cancellation_observes_owning_loop_and_disposes_task():
    async def run():
        signal = AbortSignal()
        entered = asyncio.Event()
        cleaned = asyncio.Event()

        async def callback():
            entered.set()
            try:
                await asyncio.sleep(60)
            finally:
                cleaned.set()

        loop = asyncio.get_running_loop()
        task = asyncio.create_task(
            asyncio.to_thread(resolve_callback, callback(), loop, signal)
        )
        await asyncio.wait_for(entered.wait(), 2)
        signal._abort("test cancelled")
        with pytest.raises((asyncio.CancelledError, concurrent.futures.CancelledError)):
            await task
        await asyncio.wait_for(cleaned.wait(), 2)

    asyncio.run(run())


def test_pre_cancelled_call_creates_no_runtime_or_event_worker():
    import threading

    from firedrill import run_drills

    before = {
        thread.ident
        for thread in threading.enumerate()
        if thread.name.startswith("firedrill")
    }
    signal = AbortSignal()
    signal.abort("already cancelled")
    for _ in range(3):
        with pytest.raises(FiredrillError) as error:
            run_drills(signal=signal)
        assert error.value.code == "framework.CANCELLED"
    after = {
        thread.ident
        for thread in threading.enumerate()
        if thread.name.startswith("firedrill")
    }
    assert after == before


def test_blocked_runtime_stdin_cannot_defeat_request_timeout_or_cleanup():
    runtime = Runtime(command=[sys.executable, "-c", "import time; time.sleep(60)"])
    started = time.monotonic()
    with pytest.raises(concurrent.futures.TimeoutError):
        runtime.request("unread", {"large": "x" * 2_000_000}, timeout=0.05)
    assert time.monotonic() - started < 2
    runtime.close()
    assert time.monotonic() - started < 8
    assert runtime._process.poll() is not None


def test_async_cancellation_keeps_cancelled_error_when_drain_times_out(monkeypatch):
    # Python 3.10 has distinct asyncio and concurrent.futures timeout classes.
    # Emulate that distinction even when this test runs on newer interpreters.
    class AsyncTimeout(Exception):
        pass

    started = threading.Event()
    released = threading.Event()
    calls = []

    class RuntimeStub:
        def request(self, method, params, *, timeout):
            calls.append(method)

        def close(self):
            calls.append("close")
            released.set()

    def uncooperative_request(*args, **kwargs):
        started.set()
        assert released.wait(5)

    async def timeout_drain(awaitable, timeout):
        assert timeout == 10
        awaitable.cancel()
        raise AsyncTimeout("cancellation drain expired")

    monkeypatch.setattr(sdk, "Runtime", RuntimeStub)
    monkeypatch.setattr(sdk, "_run_request", uncooperative_request)
    monkeypatch.setattr(asyncio, "TimeoutError", AsyncTimeout)
    monkeypatch.setattr(asyncio, "wait_for", timeout_drain)

    async def run():
        task = asyncio.create_task(sdk._execute_async("runDrills", {}, {}))
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert calls == ["run.cancel", "close"]
