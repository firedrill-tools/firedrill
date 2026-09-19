"""Local synthetic worlds, protocol bindings, resets and the inspector."""

from __future__ import annotations

import asyncio
import os
import threading
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from ._callbacks import CallbackDispatcher
from ._process import Runtime
from .errors import FiredrillError
from .models import Record, options, record


class Binding(Record):
    """Actor-scoped Tool endpoints. Close the binding to revoke access."""

    def __init__(self, runtime: Runtime, values: Mapping[str, Any]) -> None:
        super().__init__(record(dict(values)))
        self._runtime = runtime
        self._closed = False

    def __repr__(self) -> str:
        # Endpoint URLs can contain credentials. Avoid printing them accidentally.
        return f"Binding(actor_id={self.get('actorId')!r}, closed={self._closed})"

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._runtime.request("binding.close", {"handle": self["handle"]})

    def __enter__(self) -> Binding:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class Inspector:
    """Running browser inspector; its lifetime is explicit."""

    def __init__(
        self,
        runtime: Runtime,
        values: Mapping[str, Any],
        *,
        owns_runtime: bool = False,
        callback_id: str | None = None,
    ) -> None:
        self.url: str = values["url"]
        self._handle = values["handle"]
        self._runtime = runtime
        self._owns_runtime = owns_runtime
        self._closed = False
        self._callback_id = callback_id

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            try:
                self._runtime.request("inspector.close", {"handle": self._handle})
            finally:
                try:
                    if self._callback_id is not None:
                        self._runtime.unregister(self._callback_id)
                finally:
                    if self._owns_runtime:
                        self._runtime.close()

    def __enter__(self) -> Inspector:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class World:
    """A synthetic environment backed by the canonical local Firedrill engine.

    Use ``with World.from_project('.') as world:`` to guarantee listeners and
    processes are closed. Generated SQLite and report files remain in the project.
    """

    def __init__(
        self, runtime: Runtime, values: Mapping[str, Any], *, owns_runtime: bool = True
    ) -> None:
        self._runtime = runtime
        self._handle = values["handle"]
        self._owns_runtime = owns_runtime
        self._closed = False
        self.repository_root: str = values["repositoryRoot"]
        self.directory_path: str = values["directoryPath"]
        self.world_file_path: str = values["worldFilePath"]
        self.baseline_file_path: str = values["baselineFilePath"]
        self.diagnostics = record(values.get("diagnostics", []))

    @classmethod
    def from_project(cls, root: str | os.PathLike[str] = ".", **kwargs: Any) -> World:
        runtime = Runtime()
        try:
            values = runtime.request(
                "world.create", {"options": options(kwargs, root=os.fspath(root))}
            )
            return cls(runtime, values)
        except BaseException:
            runtime.close()
            raise

    def _invoke(self, method: str, *args: Any) -> Any:
        if self._closed:
            raise FiredrillError("This world is closed", code="framework.WORLD_CLOSED")
        return record(
            self._runtime.request(
                "world.invoke",
                {
                    "handle": self._handle,
                    "method": method,
                    "args": list(args),
                },
            )
        )

    def describe(self) -> Record:
        return self._invoke("describe")

    def metadata(self) -> Record:
        return self._invoke("metadata")

    def call(
        self,
        call: Mapping[str, Any] | None = None,
        *,
        actor_id: str | None = None,
        package_id: str | None = None,
        operation_id: str | None = None,
        arguments: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Record:
        return self._invoke(
            "call",
            options(
                call,
                actor_id=actor_id,
                package_id=package_id,
                operation_id=operation_id,
                arguments=arguments,
                idempotency_key=idempotency_key,
            ),
        )

    def state(
        self,
        query: Mapping[str, Any] | None = None,
        *,
        package_id: str | None = None,
        namespace: str | None = None,
        **kwargs: Any,
    ) -> list[Record]:
        return self._invoke(
            "state",
            options(query, package_id=package_id, namespace=namespace, **kwargs),
        )

    def evidence(
        self, *, from_sequence: int | None = None, limit: int | None = None
    ) -> list[Record]:
        return self._invoke(
            "evidence", options(from_sequence=from_sequence, limit=limit)
        )

    def scheduled_events(self, status: str | None = None) -> list[Record]:
        return self._invoke("scheduledEvents", *([] if status is None else [status]))

    def callbacks(self, status: str | None = None) -> list[Record]:
        return self._invoke("callbacks", *([] if status is None else [status]))

    def faults(self, package_id: str | None = None) -> list[Record]:
        return self._invoke("faults", *([] if package_id is None else [package_id]))

    def set_fault(
        self, package_id: str, fault_id: str, *, active: bool = True
    ) -> Record:
        return self._invoke(
            "setFault", options(package_id=package_id, fault_id=fault_id, active=active)
        )

    def advance_time(self, to_us: int, *, max_events: int | None = None) -> Record:
        return self._invoke("advanceTime", to_us, options(max_events=max_events))

    def reset(self, *, packages: Sequence[str] | None = None) -> Record:
        """Restore baseline state for this world or the selected Tool packages."""
        return self._invoke("reset", options(packages=packages))

    def export_scenario(
        self,
        id: str,
        *,
        title: str | None = None,
        packages: Sequence[str] | None = None,
    ) -> Record:
        return self._invoke(
            "exportScenario", options(id=id, title=title, packages=packages)
        )

    def save_scenario(self, id: str, **kwargs: Any) -> Record:
        return self._invoke("saveScenario", options(kwargs, id=id))

    def listen(
        self,
        *,
        actor_id: str | None = None,
        protocols: Sequence[str] | None = None,
        **kwargs: Any,
    ) -> Binding:
        values = self._runtime.request(
            "world.listen",
            {
                "handle": self._handle,
                "options": options(kwargs, actor_id=actor_id, protocols=protocols),
            },
        )
        return Binding(self._runtime, values)

    def inspect(
        self,
        *,
        binding: Binding | None = None,
        agent: Any = None,
        _loop: asyncio.AbstractEventLoop | None = None,
        **kwargs: Any,
    ) -> Inspector:
        callback_id = uuid.uuid4().hex if agent is not None else None
        if callback_id is not None:
            self._runtime.register(
                callback_id, CallbackDispatcher(self._runtime, {"agent": agent}, _loop)
            )
        try:
            values = self._runtime.request(
                "inspector.start",
                {
                    "options": options(kwargs, root=self.repository_root),
                    "worldHandle": self._handle,
                    "agent": agent is not None,
                    "runId": callback_id,
                    **(
                        {"bindingHandle": binding["handle"]}
                        if binding is not None
                        else {}
                    ),
                },
            )
            return Inspector(self._runtime, values, callback_id=callback_id)
        except BaseException:
            if callback_id is not None:
                self._runtime.unregister(callback_id)
            raise

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            try:
                self._runtime.request("world.close", {"handle": self._handle})
            finally:
                if self._owns_runtime:
                    self._runtime.close()

    def __enter__(self) -> World:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def create_world(root: str | os.PathLike[str] = ".", **kwargs: Any) -> World:
    return World.from_project(root, **kwargs)


create_local_world = create_world


def start_inspector(
    root: str | os.PathLike[str] = ".",
    *,
    agent: Any = None,
    _loop: asyncio.AbstractEventLoop | None = None,
    **kwargs: Any,
) -> Inspector:
    runtime = Runtime()
    callback_id = uuid.uuid4().hex if agent is not None else None
    if callback_id is not None:
        runtime.register(
            callback_id, CallbackDispatcher(runtime, {"agent": agent}, _loop)
        )
    try:
        values = runtime.request(
            "inspector.start",
            {
                "options": options(kwargs, root=root),
                "agent": agent is not None,
                "runId": callback_id,
            },
        )
        return Inspector(runtime, values, owns_runtime=True, callback_id=callback_id)
    except BaseException:
        runtime.close()
        raise


class AsyncBinding:
    def __init__(self, binding: Binding) -> None:
        self._binding = binding

    def __getattr__(self, name: str) -> Any:
        return getattr(self._binding, name)

    async def close(self) -> None:
        await asyncio.to_thread(self._binding.close)

    async def __aenter__(self) -> AsyncBinding:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()


class AsyncInspector:
    def __init__(self, inspector: Inspector) -> None:
        self._inspector = inspector
        self.url = inspector.url

    async def close(self) -> None:
        await asyncio.to_thread(self._inspector.close)

    async def __aenter__(self) -> AsyncInspector:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()


async def _owned_async(factory: Any, *args: Any, **kwargs: Any) -> Any:
    """Cancellation during creation still disposes the resource created by the worker."""
    ownership = threading.Lock()
    cancelled = threading.Event()
    unclaimed: list[Any] = []

    def create() -> Any:
        resource = factory(*args, **kwargs)
        with ownership:
            dispose = cancelled.is_set()
            if not dispose:
                unclaimed.append(resource)
        if dispose:
            resource.close()
        return resource

    task = asyncio.create_task(asyncio.to_thread(create))
    try:
        resource = await asyncio.shield(task)
        with ownership:
            unclaimed.clear()
        return resource
    except asyncio.CancelledError:
        with ownership:
            cancelled.set()
            resource = unclaimed.pop() if unclaimed else None

        def observe(done: asyncio.Task[Any]) -> None:
            if not done.cancelled():
                done.exception()

        task.add_done_callback(observe)
        if resource is not None:
            # Creation finished before cancellation was delivered. Schedule the
            # finalizer in the executor, which outlives asyncio task shutdown.
            await asyncio.to_thread(resource.close)
        raise


class AsyncWorld:
    """Asyncio interface to a local world with the same lifecycle and semantics."""

    def __init__(self, world: World) -> None:
        self._world = world
        self.repository_root = world.repository_root
        self.directory_path = world.directory_path
        self.world_file_path = world.world_file_path
        self.baseline_file_path = world.baseline_file_path
        self.diagnostics = world.diagnostics

    @classmethod
    async def from_project(
        cls, root: str | os.PathLike[str] = ".", **kwargs: Any
    ) -> AsyncWorld:
        return cls(await _owned_async(World.from_project, root, **kwargs))

    async def describe(self) -> Record:
        return await asyncio.to_thread(self._world.describe)

    async def metadata(self) -> Record:
        return await asyncio.to_thread(self._world.metadata)

    async def call(
        self, call: Mapping[str, Any] | None = None, **kwargs: Any
    ) -> Record:
        return await asyncio.to_thread(self._world.call, call, **kwargs)

    async def state(
        self, query: Mapping[str, Any] | None = None, **kwargs: Any
    ) -> list[Record]:
        return await asyncio.to_thread(self._world.state, query, **kwargs)

    async def evidence(self, **kwargs: Any) -> list[Record]:
        return await asyncio.to_thread(self._world.evidence, **kwargs)

    async def scheduled_events(self, status: str | None = None) -> list[Record]:
        return await asyncio.to_thread(self._world.scheduled_events, status)

    async def callbacks(self, status: str | None = None) -> list[Record]:
        return await asyncio.to_thread(self._world.callbacks, status)

    async def faults(self, package_id: str | None = None) -> list[Record]:
        return await asyncio.to_thread(self._world.faults, package_id)

    async def set_fault(
        self, package_id: str, fault_id: str, *, active: bool = True
    ) -> Record:
        return await asyncio.to_thread(
            self._world.set_fault, package_id, fault_id, active=active
        )

    async def advance_time(
        self, to_us: int, *, max_events: int | None = None
    ) -> Record:
        return await asyncio.to_thread(
            self._world.advance_time, to_us, max_events=max_events
        )

    async def reset(self, *, packages: Sequence[str] | None = None) -> Record:
        return await asyncio.to_thread(self._world.reset, packages=packages)

    async def export_scenario(self, id: str, **kwargs: Any) -> Record:
        return await asyncio.to_thread(self._world.export_scenario, id, **kwargs)

    async def save_scenario(self, id: str, **kwargs: Any) -> Record:
        return await asyncio.to_thread(self._world.save_scenario, id, **kwargs)

    async def listen(self, **kwargs: Any) -> AsyncBinding:
        return AsyncBinding(await _owned_async(self._world.listen, **kwargs))

    async def inspect(
        self, *, binding: AsyncBinding | None = None, **kwargs: Any
    ) -> AsyncInspector:
        return AsyncInspector(
            await _owned_async(
                self._world.inspect,
                binding=None if binding is None else binding._binding,
                _loop=asyncio.get_running_loop(),
                **kwargs,
            )
        )

    async def close(self) -> None:
        await asyncio.to_thread(self._world.close)

    async def __aenter__(self) -> AsyncWorld:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()


async def create_world_async(
    root: str | os.PathLike[str] = ".", **kwargs: Any
) -> AsyncWorld:
    return await AsyncWorld.from_project(root, **kwargs)


create_local_world_async = create_world_async


async def start_inspector_async(
    root: str | os.PathLike[str] = ".", **kwargs: Any
) -> AsyncInspector:
    return AsyncInspector(
        await _owned_async(
            start_inspector, root, _loop=asyncio.get_running_loop(), **kwargs
        )
    )
