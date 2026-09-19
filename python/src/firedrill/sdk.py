"""Repository-oriented Python API for the local engine."""

from __future__ import annotations

import asyncio
import concurrent.futures
import os
import threading
import uuid
from collections.abc import Callable, Mapping
from typing import Any

from ._callbacks import CallbackDispatcher
from ._process import AbortSignal, Runtime
from .errors import FiredrillError
from .models import Record, RunResult, camel, options, record


def _invoke(name: str, *, args: list[Any] | None = None, **kwargs: Any) -> Any:
    with Runtime() as runtime:
        return record(
            runtime.request(
                "sdk.invoke",
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


def _run_request(
    runtime: Runtime,
    name: str,
    values: Mapping[str, Any],
    callbacks: Mapping[str, Callable[..., Any]],
    *,
    run_id: str,
    loop: asyncio.AbstractEventLoop | None = None,
    signal: AbortSignal | None = None,
    browser: bool = False,
) -> Any:
    if signal is not None:
        signal.throw_if_aborted()
    dispatcher = CallbackDispatcher(runtime, callbacks, loop)
    runtime.register(run_id, dispatcher)
    finished = threading.Event()
    if signal is not None:

        def monitor() -> None:
            while not finished.wait(0.05):
                if signal.aborted:
                    try:
                        runtime.request("run.cancel", {"runId": run_id}, timeout=5)
                    except (FiredrillError, concurrent.futures.TimeoutError):
                        pass
                    return

        threading.Thread(
            target=monitor, daemon=True, name="firedrill-cancellation"
        ).start()
    params: dict[str, Any] = {"name": name, "options": options(values), "runId": run_id}
    if name == "runFiredrillAgent":
        params["onEvent"] = "onEvent" in callbacks
    elif browser:
        if "agentOptions" in params["options"]:
            params["agentOptions"] = params["options"].pop("agentOptions")
        params.update(
            {
                "driver": "browser.driver" in callbacks,
                "resolveAddress": "browser.resolveAddress" in callbacks,
                "onEvent": "onEvent" in callbacks,
                "onFrame": "onFrame" in callbacks,
                "messages": "browser.nextMessage" in callbacks,
                "onTurnCompleted": "onTurnCompleted" in callbacks,
            }
        )
    else:
        params.update(
            {
                "agent": "agent" in callbacks,
                "hooks": [key for key in callbacks if key != "agent"],
            }
        )
    try:
        method = (
            "agent.run"
            if name == "runFiredrillAgent"
            else "browser.run"
            if browser
            else "run.start"
        )
        return runtime.request(method, params)
    except KeyboardInterrupt:
        runtime.request("run.cancel", {"runId": run_id}, timeout=5)
        raise
    finally:
        finished.set()
        runtime.unregister(run_id)


def _callbacks(
    agent: Callable[..., Any] | None, hooks: Mapping[str, Callable[..., Any]] | None
) -> dict[str, Callable[..., Any]]:
    result = {camel(name): callback for name, callback in (hooks or {}).items()}
    if agent is not None:
        result["agent"] = agent
    if any(not callable(callback) for callback in result.values()):
        raise TypeError("Firedrill agent and lifecycle hooks must be callable")
    return result


def _execute(
    name: str,
    values: Mapping[str, Any],
    callbacks: Mapping[str, Callable[..., Any]],
    signal: AbortSignal | None = None,
    *,
    browser: bool = False,
) -> Any:
    if signal is not None:
        signal.throw_if_aborted()
    with Runtime() as runtime:
        return _run_request(
            runtime,
            name,
            values,
            callbacks,
            run_id=uuid.uuid4().hex,
            signal=signal,
            browser=browser,
        )


async def _execute_async(
    name: str,
    values: Mapping[str, Any],
    callbacks: Mapping[str, Callable[..., Any]],
    signal: AbortSignal | None = None,
    *,
    browser: bool = False,
) -> Any:
    if signal is not None:
        signal.throw_if_aborted()
    runtime = Runtime()
    run_id = uuid.uuid4().hex
    task = asyncio.create_task(
        asyncio.to_thread(
            _run_request,
            runtime,
            name,
            values,
            callbacks,
            run_id=run_id,
            loop=asyncio.get_running_loop(),
            signal=signal,
            browser=browser,
        )
    )
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await asyncio.to_thread(
                runtime.request, "run.cancel", {"runId": run_id}, timeout=5
            )
            await asyncio.wait_for(asyncio.shield(task), timeout=10)
        except (
            FiredrillError,
            concurrent.futures.TimeoutError,
            asyncio.CancelledError,
        ):
            pass
        raise
    finally:
        await asyncio.to_thread(runtime.close)


def run_drills(
    root: str | os.PathLike[str] = ".",
    *,
    drill: str | None = None,
    agent: Callable[..., Any] | None = None,
    hooks: Mapping[str, Callable[..., Any]] | None = None,
    signal: AbortSignal | None = None,
    **kwargs: Any,
) -> RunResult:
    """Run selected drills and retain reports under the consumer project.

    Keyword options match the TypeScript SDK in snake_case: suite, tags, filter,
    shard, trials, retries, concurrency, seed, build_hash, setup, capture,
    callback_receivers, host_environment, run_directory and report_directory.
    """
    values = options(kwargs, root=root, drill=drill)
    return RunResult(
        record(_execute("runDrills", values, _callbacks(agent, hooks), signal))
    )


async def run_drills_async(
    root: str | os.PathLike[str] = ".",
    *,
    drill: str | None = None,
    agent: Callable[..., Any] | None = None,
    hooks: Mapping[str, Callable[..., Any]] | None = None,
    signal: AbortSignal | None = None,
    **kwargs: Any,
) -> RunResult:
    """Asyncio drill runner; coroutine callbacks run on the caller's event loop."""
    values = options(kwargs, root=root, drill=drill)
    return RunResult(
        record(
            await _execute_async("runDrills", values, _callbacks(agent, hooks), signal)
        )
    )


def compare_runs(
    baseline_report: str | os.PathLike[str], candidate_report: str | os.PathLike[str]
) -> Record:
    return _invoke(
        "compareRuns",
        baseline_report=baseline_report,
        candidate_report=candidate_report,
    )


def compare_run_details(
    baseline_report: str | os.PathLike[str],
    candidate_report: str | os.PathLike[str],
    **kwargs: Any,
) -> Record:
    return _invoke(
        "compareRunDetails",
        baseline_report=baseline_report,
        candidate_report=candidate_report,
        **kwargs,
    )


def verify_report(report: str | os.PathLike[str]) -> Record:
    return _invoke("verifyReport", report=report)


def inspect_tool(tool_id: str, *, root: str | os.PathLike[str] = ".") -> Record:
    return _invoke("inspectTool", root=root, tool_id=tool_id)


def validate_tool(tool_id: str, *, root: str | os.PathLike[str] = ".") -> Record:
    return _invoke("validateTool", root=root, tool_id=tool_id)


def test_tool(
    tool_id: str,
    *,
    root: str | os.PathLike[str] = ".",
    agent: Callable[..., Any] | None = None,
    signal: AbortSignal | None = None,
    **kwargs: Any,
) -> Record:
    return record(
        _execute(
            "testTool",
            options(kwargs, root=root, tool_id=tool_id),
            _callbacks(agent, None),
            signal,
        )
    )


async def test_tool_async(
    tool_id: str,
    *,
    root: str | os.PathLike[str] = ".",
    agent: Callable[..., Any] | None = None,
    signal: AbortSignal | None = None,
    **kwargs: Any,
) -> Record:
    return record(
        await _execute_async(
            "testTool",
            options(kwargs, root=root, tool_id=tool_id),
            _callbacks(agent, None),
            signal,
        )
    )


def prepare_tool_contribution(
    tool_id: str,
    *,
    root: str | os.PathLike[str] = ".",
    agent: Callable[..., Any] | None = None,
    signal: AbortSignal | None = None,
    **kwargs: Any,
) -> Record:
    return record(
        _execute(
            "prepareToolContribution",
            options(kwargs, root=root, tool_id=tool_id),
            _callbacks(agent, None),
            signal,
        )
    )


async def prepare_tool_contribution_async(
    tool_id: str,
    *,
    root: str | os.PathLike[str] = ".",
    agent: Callable[..., Any] | None = None,
    signal: AbortSignal | None = None,
    **kwargs: Any,
) -> Record:
    return record(
        await _execute_async(
            "prepareToolContribution",
            options(kwargs, root=root, tool_id=tool_id),
            _callbacks(agent, None),
            signal,
        )
    )


def preview_data_import(
    plan: Mapping[str, Any],
    *,
    consent: str,
    root: str | os.PathLike[str] = ".",
    **kwargs: Any,
) -> Record:
    return _invoke("previewDataImport", plan=plan, consent=consent, root=root, **kwargs)


def save_data_import(
    preview: Mapping[str, Any],
    *,
    expected_preview_hash: str,
    confirm: str,
    root: str | os.PathLike[str] = ".",
) -> Record:
    return _invoke(
        "saveDataImport",
        preview=preview,
        expected_preview_hash=expected_preview_hash,
        confirm=confirm,
        root=root,
    )


def store_data_import_preview(
    root: str | os.PathLike[str], preview: Mapping[str, Any]
) -> str:
    return _invoke("storeDataImportPreview", args=[os.fspath(root), preview])


def load_data_import_preview(
    root: str | os.PathLike[str], path: str | os.PathLike[str]
) -> Record:
    return _invoke("loadDataImportPreview", args=[os.fspath(root), os.fspath(path)])


def load_data_import_plan(
    root: str | os.PathLike[str], path: str | os.PathLike[str]
) -> Record:
    return _invoke("loadDataImportPlan", args=[os.fspath(root), os.fspath(path)])


def validate_capture_options(capture: Mapping[str, Any]) -> None:
    _invoke("validateCaptureOptions", args=[options(capture)])


async def compare_runs_async(baseline_report: Any, candidate_report: Any) -> Record:
    return await asyncio.to_thread(compare_runs, baseline_report, candidate_report)


async def compare_run_details_async(
    baseline_report: Any, candidate_report: Any, **kwargs: Any
) -> Record:
    return await asyncio.to_thread(
        compare_run_details, baseline_report, candidate_report, **kwargs
    )


async def verify_report_async(report: Any) -> Record:
    return await asyncio.to_thread(verify_report, report)


async def inspect_tool_async(tool_id: str, **kwargs: Any) -> Record:
    return await asyncio.to_thread(inspect_tool, tool_id, **kwargs)


async def validate_tool_async(tool_id: str, **kwargs: Any) -> Record:
    return await asyncio.to_thread(validate_tool, tool_id, **kwargs)


async def preview_data_import_async(plan: Mapping[str, Any], **kwargs: Any) -> Record:
    return await asyncio.to_thread(preview_data_import, plan, **kwargs)


async def save_data_import_async(preview: Mapping[str, Any], **kwargs: Any) -> Record:
    return await asyncio.to_thread(save_data_import, preview, **kwargs)


async def store_data_import_preview_async(root: Any, preview: Mapping[str, Any]) -> str:
    return await asyncio.to_thread(store_data_import_preview, root, preview)


async def load_data_import_preview_async(root: Any, path: Any) -> Record:
    return await asyncio.to_thread(load_data_import_preview, root, path)


async def load_data_import_plan_async(root: Any, path: Any) -> Record:
    return await asyncio.to_thread(load_data_import_plan, root, path)
