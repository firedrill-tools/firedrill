"""Optional browser tests, saved definitions, artifacts and replay."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Callable, Mapping
from typing import Any

from ._process import AbortSignal, Runtime
from .models import BrowserResult, Record, options, record
from .sdk import _execute, _execute_async


def _invoke(name: str, *, args: list[Any] | None = None, **kwargs: Any) -> Any:
    with Runtime() as runtime:
        return record(
            runtime.request(
                "browser.invoke",
                {
                    "name": name,
                    **(
                        {"args": args}
                        if args is not None
                        else {"options": options(kwargs)}
                    ),
                },
            )
        )


def _callbacks(
    driver: Any,
    on_event: Any,
    on_frame: Any,
    resolve_address: Any,
    messages: Any = None,
    on_turn_completed: Any = None,
) -> dict[str, Any]:
    callbacks = {
        name: callback
        for name, callback in (
            ("browser.driver", driver),
            ("onEvent", on_event),
            ("onFrame", on_frame),
            ("browser.resolveAddress", resolve_address),
        )
        if callback is not None
    }
    if messages is not None:
        if isinstance(messages, (str, bytes)):
            raise TypeError(
                "messages must be an iterable of strings, not a single string"
            )

        def message_result(value: Any) -> dict[str, Any]:
            if not isinstance(value, str):
                raise TypeError("each browser agent message must be a string")
            return {"done": False, "value": value}

        if hasattr(messages, "__aiter__"):
            iterator = messages.__aiter__()

            async def next_message(_: Any) -> dict[str, Any]:
                try:
                    return message_result(await iterator.__anext__())
                except StopAsyncIteration:
                    return {"done": True}
        else:
            iterator = iter(messages)

            def next_message(_: Any) -> dict[str, Any]:
                try:
                    return message_result(next(iterator))
                except StopIteration:
                    return {"done": True}

        callbacks["browser.nextMessage"] = next_message
    if on_turn_completed is not None:
        callbacks["onTurnCompleted"] = lambda _: on_turn_completed()
    return callbacks


def run_browser_test(
    definition: Mapping[str, Any],
    *,
    root: Any = ".",
    driver: Callable[..., Any] | None = None,
    on_event: Callable[..., Any] | None = None,
    on_frame: Callable[..., Any] | None = None,
    resolve_address: Callable[..., Any] | None = None,
    signal: AbortSignal | None = None,
    messages: Any = None,
    on_turn_completed: Callable[..., Any] | None = None,
    **kwargs: Any,
) -> BrowserResult:
    return BrowserResult(
        record(
            _execute(
                "runBrowserTest",
                options(kwargs, root=root, definition=definition),
                _callbacks(
                    driver,
                    on_event,
                    on_frame,
                    resolve_address,
                    messages,
                    on_turn_completed,
                ),
                signal,
                browser=True,
            )
        )
    )


async def run_browser_test_async(
    definition: Mapping[str, Any],
    *,
    root: Any = ".",
    driver: Callable[..., Any] | None = None,
    on_event: Callable[..., Any] | None = None,
    on_frame: Callable[..., Any] | None = None,
    resolve_address: Callable[..., Any] | None = None,
    signal: AbortSignal | None = None,
    messages: Any = None,
    on_turn_completed: Callable[..., Any] | None = None,
    **kwargs: Any,
) -> BrowserResult:
    return BrowserResult(
        record(
            await _execute_async(
                "runBrowserTest",
                options(kwargs, root=root, definition=definition),
                _callbacks(
                    driver,
                    on_event,
                    on_frame,
                    resolve_address,
                    messages,
                    on_turn_completed,
                ),
                signal,
                browser=True,
            )
        )
    )


def run_browser_agent_test(
    definition: Mapping[str, Any],
    *,
    agent_options: Mapping[str, Any] | None = None,
    **kwargs: Any,
) -> BrowserResult:
    """Drive a browser task with the optional Claude Agent SDK browser driver."""
    return run_browser_test(
        definition, agent_options=options(agent_options or {}), **kwargs
    )


async def run_browser_agent_test_async(
    definition: Mapping[str, Any],
    *,
    agent_options: Mapping[str, Any] | None = None,
    **kwargs: Any,
) -> BrowserResult:
    return await run_browser_test_async(
        definition, agent_options=options(agent_options or {}), **kwargs
    )


def list_browser_tests(*, root: Any = ".", **kwargs: Any) -> Record:
    return _invoke("listBrowserTests", root=root, **kwargs)


def list_browser_test_reports(*, root: Any = ".", **kwargs: Any) -> Record:
    return _invoke("listBrowserTestReports", root=root, **kwargs)


def load_browser_test(path: Any, *, root: Any = ".") -> Record:
    return _invoke("loadBrowserTest", path=path, root=root)


def save_browser_test(
    definition: Mapping[str, Any], *, root: Any = ".", path: Any = None
) -> str:
    return _invoke("saveBrowserTest", definition=definition, root=root, path=path)


def browser_test_definition_from_result(
    result: Mapping[str, Any], **kwargs: Any
) -> Record:
    return _invoke("browserTestDefinitionFromResult", result=result, **kwargs)


def verify_browser_test_report(directory: Any) -> BrowserResult:
    return BrowserResult(_invoke("verifyBrowserTestReport", args=[str(directory)]))


def bundle_browser_test_report(directory: Any) -> Record:
    result = _invoke("bundleBrowserTestReport", args=[str(directory)])
    result["data"] = base64.b64decode(result["data"], validate=True)
    result.pop("encoding", None)
    return result


async def list_browser_tests_async(**kwargs: Any) -> Record:
    return await asyncio.to_thread(list_browser_tests, **kwargs)


async def list_browser_test_reports_async(**kwargs: Any) -> Record:
    return await asyncio.to_thread(list_browser_test_reports, **kwargs)


async def load_browser_test_async(path: Any, **kwargs: Any) -> Record:
    return await asyncio.to_thread(load_browser_test, path, **kwargs)


async def save_browser_test_async(definition: Mapping[str, Any], **kwargs: Any) -> str:
    return await asyncio.to_thread(save_browser_test, definition, **kwargs)


async def browser_test_definition_from_result_async(
    result: Mapping[str, Any], **kwargs: Any
) -> Record:
    return await asyncio.to_thread(
        browser_test_definition_from_result, result, **kwargs
    )


async def verify_browser_test_report_async(directory: Any) -> BrowserResult:
    return await asyncio.to_thread(verify_browser_test_report, directory)


async def bundle_browser_test_report_async(directory: Any) -> Record:
    return await asyncio.to_thread(bundle_browser_test_report, directory)
