"""Optional local authoring agent. Requires firedrill-run[agent] and a model key."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ._process import AbortSignal
from .models import Record, options, record
from .sdk import _execute, _execute_async


def run_agent(
    *,
    root: Any = ".",
    prompt: str | None = None,
    on_event: Callable[..., Any] | None = None,
    signal: AbortSignal | None = None,
    **kwargs: Any,
) -> Record:
    callbacks = {"onEvent": on_event} if on_event is not None else {}
    return record(
        _execute(
            "runFiredrillAgent",
            options(kwargs, root=root, prompt=prompt),
            callbacks,
            signal,
        )
    )


async def run_agent_async(
    *,
    root: Any = ".",
    prompt: str | None = None,
    on_event: Callable[..., Any] | None = None,
    signal: AbortSignal | None = None,
    **kwargs: Any,
) -> Record:
    callbacks = {"onEvent": on_event} if on_event is not None else {}
    return record(
        await _execute_async(
            "runFiredrillAgent",
            options(kwargs, root=root, prompt=prompt),
            callbacks,
            signal,
        )
    )
