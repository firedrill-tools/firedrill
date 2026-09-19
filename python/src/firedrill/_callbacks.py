"""Python callbacks borrow scoped world and capture handles during a run."""

from __future__ import annotations

import asyncio
import inspect
import uuid
from collections.abc import Callable, Mapping
from contextvars import copy_context
from typing import Any

from ._process import Runtime, resolve_callback
from .models import Record, camel, options, record


class BoundWorld:
    """An actor-scoped direct binding. Its access expires with the invocation."""

    def __init__(
        self, runtime: Runtime, scope: str, actor_binding_id: str | None = None
    ) -> None:
        self._runtime = runtime
        self._scope = scope
        self.actor_binding_id = actor_binding_id

    def invoke(
        self,
        operation: Mapping[str, Any],
        arguments: Mapping[str, Any] | None = None,
        call_options: Mapping[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
    ) -> Record:
        return record(
            self._runtime.request(
                "callback.invoke",
                {
                    "scope": self._scope,
                    "method": "world.invoke",
                    "args": [
                        options(operation),
                        dict(arguments or {}),
                        options(call_options, idempotency_key=idempotency_key),
                    ],
                },
            )
        )


class AsyncBoundWorld:
    def __init__(self, world: BoundWorld) -> None:
        self._world = world
        self.actor_binding_id = world.actor_binding_id

    async def invoke(
        self,
        operation: Mapping[str, Any],
        arguments: Mapping[str, Any] | None = None,
        call_options: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> Record:
        return await asyncio.to_thread(
            self._world.invoke, operation, arguments, call_options, **kwargs
        )


class Capture:
    def __init__(
        self, dispatcher: CallbackDispatcher, scope: str, policies: Mapping[str, Any]
    ) -> None:
        self._dispatcher = dispatcher
        self._scope = scope
        self.policies = record(dict(policies))

    def _call(self, method: str, value: Any) -> Any:
        return record(
            self._dispatcher.runtime.request(
                "callback.invoke",
                {
                    "scope": self._scope,
                    "method": "capture." + method,
                    "args": [value],
                },
            )
        )

    def log(self, message: str) -> None:
        self._call("log", message)

    def file(
        self, path: Any = None, *, media_type: str | None = None, **kwargs: Any
    ) -> None:
        self._call(
            "file",
            options(
                path if isinstance(path, Mapping) else None,
                **({"path": path} if not isinstance(path, Mapping) else {}),
                media_type=media_type,
                **kwargs,
            ),
        )

    def screenshot(
        self, path: Any = None, *, media_type: str = "image/png", **kwargs: Any
    ) -> None:
        self._call(
            "screenshot",
            options(
                path if isinstance(path, Mapping) else None,
                **({"path": path} if not isinstance(path, Mapping) else {}),
                **({"media_type": media_type} if not isinstance(path, Mapping) else {}),
                **kwargs,
            ),
        )

    def video(
        self, path: Any = None, *, media_type: str = "video/webm", **kwargs: Any
    ) -> None:
        self._call(
            "video",
            options(
                path if isinstance(path, Mapping) else None,
                **({"path": path} if not isinstance(path, Mapping) else {}),
                **({"media_type": media_type} if not isinstance(path, Mapping) else {}),
                **kwargs,
            ),
        )

    def register_driver(
        self, driver: Any = None, **callbacks: Callable[..., Any]
    ) -> None:
        driver_id = uuid.uuid4().hex
        registered = []
        for snake in ("screenshot", "start_video", "stop_video", "dispose"):
            name = camel(snake)
            handler = callbacks.get(snake, callbacks.get(name))
            if handler is None and driver is not None:
                handler = (
                    driver.get(snake, driver.get(name))
                    if isinstance(driver, Mapping)
                    else getattr(driver, snake, None)
                )
            if handler is not None:
                if not callable(handler):
                    raise TypeError(f"capture driver {snake} must be callable")
                self._dispatcher.callbacks[f"capture.{driver_id}.{name}"] = handler
                registered.append(name)
        if not registered:
            raise ValueError("A capture driver requires at least one callback")
        self._call("registerDriver", {"driverId": driver_id, "methods": registered})


class AsyncCapture:
    def __init__(self, capture: Capture) -> None:
        self._capture = capture
        self.policies = capture.policies

    async def log(self, message: str) -> None:
        await asyncio.to_thread(self._capture.log, message)

    async def file(self, path: Any = None, **kwargs: Any) -> None:
        await asyncio.to_thread(self._capture.file, path, **kwargs)

    async def screenshot(self, path: Any = None, **kwargs: Any) -> None:
        await asyncio.to_thread(self._capture.screenshot, path, **kwargs)

    async def video(self, path: Any = None, **kwargs: Any) -> None:
        await asyncio.to_thread(self._capture.video, path, **kwargs)

    async def register_driver(
        self, driver: Any = None, **callbacks: Callable[..., Any]
    ) -> None:
        await asyncio.to_thread(self._capture.register_driver, driver, **callbacks)


class AgentBinding(Record):
    environment: dict[str, str]
    apps: list[Record]
    world: BoundWorld


class AsyncAgentBinding(Record):
    environment: dict[str, str]
    apps: list[Record]
    world: AsyncBoundWorld


class AgentInvocation(Record):
    run_id: str
    drill_id: str
    target_id: str
    interaction_id: str
    actor_id: str
    task: Record
    binding: AgentBinding
    signal: Any
    capture: Capture
    attach: Callable[..., Any]


class AsyncAgentInvocation(Record):
    run_id: str
    drill_id: str
    target_id: str
    interaction_id: str
    actor_id: str
    task: Record
    binding: AsyncAgentBinding
    signal: Any
    capture: AsyncCapture
    attach: Callable[..., Any]


class CallbackDispatcher:
    def __init__(
        self,
        runtime: Runtime,
        callbacks: Mapping[str, Callable[..., Any]],
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        self.runtime = runtime
        self.callbacks = dict(callbacks)
        self.loop = loop
        self._context = copy_context()

    def __call__(self, message: Mapping[str, Any]) -> Any:
        return self._context.copy().run(self._dispatch, message)

    def _dispatch(self, message: Mapping[str, Any]) -> Any:
        callback_name = message.get("callback", message.get("event"))
        handler = self.callbacks[callback_name]
        if message.get("type") == "event":
            return resolve_callback(handler(record(message.get("value"))), self.loop)
        scope = str(message["scope"])
        data = record(message.get("context", {}))
        is_async = inspect.iscoroutinefunction(handler) or inspect.iscoroutinefunction(
            getattr(handler, "__call__", None)
        )
        if callback_name == "agent":
            data = (AsyncAgentInvocation if is_async else AgentInvocation)(data)
            data["binding"] = (AsyncAgentBinding if is_async else AgentBinding)(
                data["binding"]
            )
        data["signal"] = self.runtime.scope_signal(scope)
        if message.get("context", {}).get("signal", {}).get("aborted"):
            data["signal"]._abort("execution cancelled")
        binding = data.get("binding")
        if binding is not None and binding.get("world") is not None:
            world = BoundWorld(
                self.runtime, scope, binding["world"].get("actorBindingId")
            )
            binding["world"] = AsyncBoundWorld(world) if is_async else world
        if "capture" in data:
            capture = Capture(self, scope, data["capture"].get("policies", {}))
            data["capture"] = AsyncCapture(capture) if is_async else capture

        def call(method: str, *args: Any) -> Any:
            return record(
                self.runtime.request(
                    "callback.invoke",
                    {"scope": scope, "method": method, "args": list(args)},
                )
            )

        if data.get("attach"):

            def attach(
                path: Any = None, *, media_type: str | None = None, **kwargs: Any
            ) -> Any:
                value = options(
                    path if isinstance(path, Mapping) else None,
                    **({"path": path} if not isinstance(path, Mapping) else {}),
                    media_type=media_type,
                    **kwargs,
                )
                return call("attach", value)

            async def async_attach(path: Any = None, **kwargs: Any) -> Any:
                return await asyncio.to_thread(attach, path, **kwargs)

            data["attach"] = async_attach if is_async else attach
        if data.get("observe"):

            def observe() -> Record:
                return call("observe")

            def step(value: Mapping[str, Any]) -> None:
                call("step", value)

            async def async_observe() -> Record:
                return await asyncio.to_thread(observe)

            async def async_step(value: Mapping[str, Any]) -> None:
                await asyncio.to_thread(step, value)

            data["observe"] = async_observe if is_async else observe
            data["step"] = async_step if is_async else step
        argument = data.hostname if callback_name == "browser.resolveAddress" else data
        returned = handler(argument)
        # A normal callable may return a coroutine (for example a decorated agent).
        # Upgrade the shared context before the coroutine body starts executing.
        if not is_async and inspect.isawaitable(returned):
            if binding is not None and isinstance(binding.get("world"), BoundWorld):
                binding["world"] = AsyncBoundWorld(binding["world"])
            if isinstance(data.get("capture"), Capture):
                data["capture"] = AsyncCapture(data["capture"])
            if data.get("attach"):
                data["attach"] = async_attach
            if data.get("observe"):
                data["observe"] = async_observe
                data["step"] = async_step
        result = resolve_callback(returned, self.loop, data["signal"])
        if str(callback_name).startswith("capture.") and isinstance(result, Mapping):
            return options(result)
        return result
