import asyncio

import pytest
from firedrill import AbortSignal
from firedrill._callbacks import CallbackDispatcher
from firedrill.browser import _callbacks


class CallbackRuntime:
    def scope_signal(self, scope):
        return AbortSignal()


def next_message(dispatcher, scope):
    return dispatcher(
        {
            "type": "callback",
            "callback": "browser.nextMessage",
            "scope": scope,
            "context": {},
        }
    )


def test_browser_message_iterable_and_turn_callback_use_protocol_envelopes():
    completed = []
    callbacks = _callbacks(
        None,
        None,
        None,
        None,
        messages=["Inspect another record", "Finish"],
        on_turn_completed=lambda: completed.append(True),
    )
    dispatcher = CallbackDispatcher(CallbackRuntime(), callbacks)
    assert next_message(dispatcher, "first") == {
        "done": False,
        "value": "Inspect another record",
    }
    assert next_message(dispatcher, "second") == {
        "done": False,
        "value": "Finish",
    }
    assert next_message(dispatcher, "end") == {"done": True}
    dispatcher({"type": "event", "event": "onTurnCompleted", "value": None})
    assert completed == [True]


def test_async_browser_messages_and_turn_callback_run_on_callers_loop():
    async def execute():
        loop = asyncio.get_running_loop()
        completed = []

        async def messages():
            assert asyncio.get_running_loop() is loop
            yield "Inspect another record"

        async def on_turn_completed():
            assert asyncio.get_running_loop() is loop
            completed.append(True)

        dispatcher = CallbackDispatcher(
            CallbackRuntime(),
            _callbacks(
                None,
                None,
                None,
                None,
                messages=messages(),
                on_turn_completed=on_turn_completed,
            ),
            loop,
        )
        assert await asyncio.to_thread(next_message, dispatcher, "first") == {
            "done": False,
            "value": "Inspect another record",
        }
        assert await asyncio.to_thread(next_message, dispatcher, "end") == {
            "done": True
        }
        await asyncio.to_thread(
            dispatcher,
            {"type": "event", "event": "onTurnCompleted", "value": None},
        )
        assert completed == [True]

    asyncio.run(execute())


def test_browser_messages_reject_bare_text_and_nontext_items():
    for value in ("do not split this", b"or this"):
        with pytest.raises(TypeError, match="iterable of strings"):
            _callbacks(None, None, None, None, messages=value)
    dispatcher = CallbackDispatcher(
        CallbackRuntime(), _callbacks(None, None, None, None, messages=[{}])
    )
    with pytest.raises(TypeError, match="message must be a string"):
        next_message(dispatcher, "invalid")
