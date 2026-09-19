"""Test-side replacement of existing Python function and SDK call sites."""

from __future__ import annotations

import inspect
import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from pkgutil import resolve_name
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from .errors import ToolError


class _Patch:
    def __init__(self, owner: Any, name: str) -> None:
        descriptor = inspect.getattr_static(owner, name)
        self.original = (
            descriptor.__func__
            if isinstance(descriptor, (staticmethod, classmethod))
            else getattr(owner, name)
        )
        if not callable(self.original):
            raise TypeError("mock_tool requires a callable lookup target")
        self.active: ContextVar[Any] = ContextVar(
            "firedrill_mock_" + name, default=None
        )
        self.users = 0
        self.is_async = inspect.iscoroutinefunction(self.original)

        def dispatch(*args: Any, **kwargs: Any) -> Any:
            selected = self.active.get()
            return (self.original if selected is None else selected)(*args, **kwargs)

        async def async_dispatch(*args: Any, **kwargs: Any) -> Any:
            result = dispatch(*args, **kwargs)
            return await result if inspect.isawaitable(result) else result

        replacement: Any = async_dispatch if self.is_async else dispatch
        if isinstance(descriptor, staticmethod):
            replacement = staticmethod(replacement)
        elif isinstance(descriptor, classmethod):
            replacement = classmethod(replacement)
        self.patcher = patch.object(owner, name, replacement)
        self.patcher.start()


_PATCHES: dict[tuple[int, str], _Patch] = {}
_PATCH_LOCK = threading.RLock()


def _arguments(
    mapper: Any, args: tuple[Any, ...], kwargs: dict[str, Any]
) -> Mapping[str, Any]:
    if callable(mapper):
        return mapper(*args, **kwargs)
    if mapper is not None:
        return mapper
    if not args:
        return kwargs
    if len(args) == 1 and not kwargs and isinstance(args[0], Mapping):
        return args[0]
    raise TypeError(
        "Provide arguments=lambda *args, **kwargs: {...} to map positional function arguments"
    )


def _value(result: Any, transform: Callable[[Any], Any] | None) -> Any:
    if transform is not None:
        return transform(result)
    outcome = result["outcome"]
    if outcome["status"] != "ok":
        error = outcome.get("error", {})
        raise ToolError(
            error.get("message", "Synthetic Tool operation failed"),
            code=error.get("code", "tool.OPERATION_FAILED"),
            result=result,
        )
    return outcome.get("value")


@contextmanager
def mock_tool(
    target: str,
    world: Any,
    *,
    package_id: str,
    operation_id: str,
    actor_id: str | None = None,
    arguments: Mapping[str, Any] | Callable[..., Any] | None = None,
    transform: Callable[[Any], Any] | None = None,
    idempotency_key: str | Callable[..., str] | None = None,
    asynchronous: bool | None = None,
) -> Iterator[Any]:
    """Patch the name the agent imports, invoking the real synthetic behavior.

    The patch belongs in the test; the agent source stays unchanged. Patch the
    lookup site (``agent_module.send_email``), as with ``unittest.mock.patch``.
    ``transform`` receives the complete operation result for provider-specific
    response and error mapping. Default behavior returns the outcome value.
    Overrides are scoped to the current thread/async context. A new thread that
    does not inherit that context calls the original function, not the fake.
    Use ``contextvars.copy_context().run`` or protocol bindings when the agent
    starts its own worker threads. This helper does not block real network I/O.
    """

    def invoke(*args: Any, **kwargs: Any) -> Any:
        mapped = _arguments(arguments, args, kwargs)
        key = (
            idempotency_key(*args, **kwargs)
            if callable(idempotency_key)
            else idempotency_key
        )
        if actor_id is not None:
            return world.call(
                actor_id=actor_id,
                package_id=package_id,
                operation_id=operation_id,
                arguments=mapped,
                idempotency_key=key,
            )
        return world.invoke(
            {"packageId": package_id, "operationId": operation_id},
            mapped,
            **({"idempotency_key": key} if key is not None else {}),
        )

    def sync_call(*args: Any, **kwargs: Any) -> Any:
        result = invoke(*args, **kwargs)
        if inspect.isawaitable(result):
            if inspect.iscoroutine(result):
                result.close()
            raise TypeError("Use asynchronous=True when mocking with an async world")
        return _value(result, transform)

    async def async_call(*args: Any, **kwargs: Any) -> Any:
        result = invoke(*args, **kwargs)
        if inspect.isawaitable(result):
            result = await result
        transformed = _value(result, transform)
        return await transformed if inspect.isawaitable(transformed) else transformed

    owner_path, separator, name = target.rpartition(".")
    if not separator:
        raise ValueError("mock_tool target must include a module and lookup name")
    owner = resolve_name(owner_path)
    key = (id(owner), name)
    with _PATCH_LOCK:
        entry = _PATCHES.get(key)
        if entry is None:
            entry = _Patch(owner, name)
            _PATCHES[key] = entry
        entry.users += 1
    use_async = entry.is_async if asynchronous is None else asynchronous
    mocked = (AsyncMock if use_async else MagicMock)(
        name=target, side_effect=async_call if use_async else sync_call
    )
    token = entry.active.set(mocked)
    try:
        yield mocked
    finally:
        entry.active.reset(token)
        with _PATCH_LOCK:
            entry.users -= 1
            if entry.users == 0:
                entry.patcher.stop()
                del _PATCHES[key]
