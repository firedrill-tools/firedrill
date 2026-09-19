"""Private process transport for the runtime shipped in the Python wheel."""

from __future__ import annotations

import asyncio
import atexit
import concurrent.futures
import importlib.util
import inspect
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import uuid
import weakref
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .errors import FiredrillError, RuntimeUnavailableError
from .models import plain


def runtime_directory() -> Path:
    selected = os.environ.get("FIREDRILL_RUNTIME_DIR")
    return (
        Path(selected).resolve()
        if selected
        else Path(__file__).resolve().parent / "_runtime"
    )


def runtime_environment(directory: Path | None = None) -> dict[str, str]:
    directory = directory or runtime_directory()
    env = dict(os.environ)
    env["FIREDRILL_PYTHON_EXECUTABLE"] = sys.executable
    env["PATH"] = os.pathsep.join(
        [str(directory / "bin"), str(Path(sys.executable).parent), env.get("PATH", "")]
    )
    env["FIREDRILL_BUNDLED_NPM_CLI"] = str(
        directory / "app/node_modules/npm/bin/npm-cli.js"
    )
    env["FIREDRILL_BUNDLED_PNPM_CLI"] = str(
        directory / "app/node_modules/pnpm/bin/pnpm.cjs"
    )
    companion = importlib.util.find_spec("claude_agent_sdk")
    if companion is not None and companion.origin:
        executable = (
            Path(companion.origin).parent
            / "_bundled"
            / ("claude.exe" if os.name == "nt" else "claude")
        )
        if executable.is_file():
            env["FIREDRILL_AGENT_EXECUTABLE"] = str(executable)
    return env


def runtime_command(entry: str = "bridge") -> list[str]:
    directory = runtime_directory()
    executable = directory / "bin" / ("node.exe" if os.name == "nt" else "node")
    script = (
        directory
        / "app"
        / (
            "bridge.mjs"
            if entry == "bridge"
            else "node_modules/@firedrill-run/cli/dist/bin.js"
        )
    )
    if not executable.is_file() or not script.is_file():
        raise RuntimeUnavailableError(
            "The Firedrill installation is missing its bundled runtime. "
            "Reinstall the firedrill-run wheel for your operating system and architecture.",
            code="framework.RUNTIME_UNAVAILABLE",
        )
    return [str(executable), str(script)]


class AbortSignal:
    """Cooperative cancellation for caller-owned Python agent code."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self.reason: Any = None

    @property
    def aborted(self) -> bool:
        return self._event.is_set()

    def wait(self, timeout: float | None = None) -> bool:
        return self._event.wait(timeout)

    def throw_if_aborted(self) -> None:
        if self.aborted:
            raise FiredrillError(
                "The Firedrill operation was cancelled", code="framework.CANCELLED"
            )

    def _abort(self, reason: Any = None) -> None:
        self.reason = reason
        self._event.set()

    def abort(self, reason: Any = None) -> None:
        """Request cancellation. The runner retains the cancelled attempt's report."""
        self._abort(reason)


_PROCESSES: weakref.WeakSet[Runtime] = weakref.WeakSet()


class Runtime:
    """One owned local runtime. The reader never blocks on Python callbacks."""

    def __init__(self, *, command: list[str] | None = None) -> None:
        self._lock = threading.RLock()
        self._writes: queue.Queue[str | None] = queue.Queue(maxsize=128)
        self._pending: dict[str, concurrent.futures.Future[Any]] = {}
        self._handlers: dict[str, Callable[[Mapping[str, Any]], Any]] = {}
        self._signals: dict[str, AbortSignal] = {}
        self._events: dict[str, tuple[queue.Queue[Any], threading.Thread]] = {}
        self._event_errors: dict[str, BaseException] = {}
        self._closed = False
        self._closing = False
        kwargs: dict[str, Any] = {"start_new_session": True} if os.name != "nt" else {}
        self._process = subprocess.Popen(
            command or runtime_command(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            encoding="utf-8",
            bufsize=1,
            env=runtime_environment(),
            **kwargs,
        )
        self._reader = threading.Thread(
            target=self._read, daemon=True, name="firedrill-runtime"
        )
        self._reader.start()
        self._writer = threading.Thread(
            target=self._write, daemon=True, name="firedrill-writer"
        )
        self._writer.start()
        _PROCESSES.add(self)

    def __enter__(self) -> Runtime:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def register(
        self, run_id: str, handler: Callable[[Mapping[str, Any]], Any]
    ) -> None:
        with self._lock:
            self._handlers[run_id] = handler
            events: queue.Queue[Any] = queue.Queue(maxsize=128)
            worker = threading.Thread(
                target=self._events_worker,
                args=(run_id, events),
                daemon=True,
                name="firedrill-events",
            )
            self._events[run_id] = (events, worker)
            worker.start()

    def unregister(self, run_id: str) -> None:
        with self._lock:
            events = self._events.pop(run_id, None)
        if events is not None:
            event_queue, worker = events
            try:
                event_queue.put(None, timeout=1)
            except queue.Full:
                pass
            worker.join(timeout=10)
            if worker.is_alive():
                with self._lock:
                    self._event_errors.setdefault(
                        run_id,
                        TimeoutError("event callback did not finish within 10 seconds"),
                    )
        with self._lock:
            self._handlers.pop(run_id, None)
            error = self._event_errors.pop(run_id, None)
        if error is not None:
            raise FiredrillError(
                f"Python browser event callback failed: {error}",
                code="framework.PYTHON_CALLBACK_ERROR",
            ) from error

    def scope_signal(self, scope: str) -> AbortSignal:
        with self._lock:
            return self._signals.setdefault(scope, AbortSignal())

    def _send(self, message: Mapping[str, Any]) -> None:
        encoded = (
            json.dumps(plain(message), allow_nan=False, separators=(",", ":")) + "\n"
        )
        if self._closed or self._process.stdin is None:
            raise FiredrillError(
                "The local runtime is closed", code="framework.RUNTIME_CLOSED"
            )
        try:
            self._writes.put_nowait(encoded)
        except queue.Full as error:
            raise FiredrillError(
                "The local runtime is not accepting requests",
                code="framework.RUNTIME_BACKPRESSURE",
            ) from error

    def _write(self) -> None:
        while True:
            encoded = self._writes.get()
            if encoded is None:
                return
            try:
                self._process.stdin.write(encoded)
                self._process.stdin.flush()
            except (BrokenPipeError, OSError, ValueError):
                with self._lock:
                    pending = list(self._pending.values())
                for future in pending:
                    if not future.done():
                        future.set_exception(
                            FiredrillError(
                                "The local runtime exited unexpectedly",
                                code="framework.RUNTIME_EXITED",
                            )
                        )
                return

    def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> Any:
        request_id = uuid.uuid4().hex
        future: concurrent.futures.Future[Any] = concurrent.futures.Future()
        with self._lock:
            if self._closed:
                raise FiredrillError(
                    "The local runtime is closed", code="framework.RUNTIME_CLOSED"
                )
            self._pending[request_id] = future
        try:
            self._send({"id": request_id, "method": method, "params": params or {}})
            return future.result(timeout=timeout)
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def _read(self) -> None:
        assert self._process.stdout is not None
        failure = FiredrillError(
            "The local runtime exited unexpectedly", code="framework.RUNTIME_EXITED"
        )
        try:
            maximum_frame = 256 * 1024 * 1024
            for line in iter(
                lambda: self._process.stdout.readline(maximum_frame + 1), ""
            ):
                if len(line.encode("utf-8")) > maximum_frame:
                    failure = FiredrillError(
                        "Runtime response exceeds 256 MiB; use paginated reads",
                        code="framework.RUNTIME_MESSAGE_LIMIT",
                    )
                    break
                try:
                    message = json.loads(line)
                    if not isinstance(message, dict):
                        raise ValueError("Expected an object")
                except (ValueError, TypeError):
                    failure = FiredrillError(
                        "The runtime returned an invalid protocol message",
                        code="framework.RUNTIME_PROTOCOL_ERROR",
                    )
                    break
                if message.get("type") == "callback":
                    threading.Thread(
                        target=self._callback,
                        args=(message,),
                        daemon=True,
                        name="firedrill-callback",
                    ).start()
                    continue
                if message.get("type") == "event":
                    run_id = str(message.get("runId", ""))
                    with self._lock:
                        events = self._events.get(run_id)
                    if events is not None:
                        try:
                            events[0].put_nowait(message)
                        except queue.Full:
                            # Frames are ephemeral previews. Never discard durable events silently.
                            if message.get("event") != "onFrame":
                                with self._lock:
                                    self._event_errors.setdefault(
                                        run_id,
                                        RuntimeError(
                                            "event callback cannot keep up with execution"
                                        ),
                                    )
                    continue
                if message.get("type") == "cancelled":
                    self.scope_signal(str(message.get("scope", "")))._abort(
                        message.get("reason")
                    )
                    continue
                with self._lock:
                    future = self._pending.get(str(message.get("id", "")))
                if future is not None and not future.done():
                    if "error" in message:
                        future.set_exception(
                            FiredrillError.from_payload(message["error"])
                        )
                    else:
                        future.set_result(message.get("result"))
        finally:
            with self._lock:
                pending = list(self._pending.values())
                signals = list(self._signals.values())
                self._closed = True
            for pending_signal in signals:
                pending_signal._abort("runtime closed")
            for future in pending:
                if not future.done():
                    future.set_exception(failure)

    def _callback(self, message: Mapping[str, Any]) -> None:
        with self._lock:
            handler = self._handlers.get(str(message.get("runId", "")))
        try:
            if handler is None:
                raise FiredrillError(
                    "No Python callback is registered for this run",
                    code="framework.CALLBACK_UNAVAILABLE",
                )
            result = handler(message)
            self._send(
                {
                    "type": "callback_result",
                    "id": message["id"],
                    "result": plain(result),
                }
            )
        except BaseException as error:
            try:
                self._send(
                    {
                        "type": "callback_result",
                        "id": message["id"],
                        "error": {
                            "code": getattr(
                                error, "code", "framework.PYTHON_CALLBACK_ERROR"
                            ),
                            "message": str(error) or type(error).__name__,
                        },
                    }
                )
            except (FiredrillError, TypeError, ValueError):
                pass
        finally:
            with self._lock:
                self._signals.pop(str(message.get("scope", "")), None)

    def _events_worker(self, run_id: str, events: queue.Queue[Any]) -> None:
        while True:
            try:
                message = events.get(timeout=0.25)
            except queue.Empty:
                with self._lock:
                    if run_id not in self._handlers:
                        return
                continue
            if message is None:
                return
            with self._lock:
                handler = self._handlers.get(run_id)
            if handler is None:
                return
            try:
                handler(message)
            except BaseException as error:
                with self._lock:
                    self._event_errors.setdefault(run_id, error)

    def close(self) -> None:
        with self._lock:
            if self._closing:
                return
            self._closing = True
            was_closed = self._closed
        try:
            if not was_closed:
                try:
                    self.request("session.close", timeout=5)
                except (FiredrillError, concurrent.futures.TimeoutError, OSError):
                    self._terminate()
                    self._process.wait(timeout=5)
            try:
                self._writes.put_nowait(None)
            except queue.Full:
                self._terminate()
            self._writer.join(timeout=1)
            if self._writer.is_alive():
                self._terminate()
                self._writer.join(timeout=2)
            if self._process.stdin is not None:
                self._process.stdin.close()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._terminate()
                self._process.wait(timeout=5)
        finally:
            self._closed = True
            with self._lock:
                registrations = list(self._handlers)
            for run_id in registrations:
                try:
                    self.unregister(run_id)
                except FiredrillError:
                    pass
            if self._process.stdout is not None:
                self._process.stdout.close()
            _PROCESSES.discard(self)

    def _terminate(self) -> None:
        try:
            if os.name == "nt":
                try:
                    subprocess.run(
                        ["taskkill", "/PID", str(self._process.pid), "/T", "/F"],
                        check=False,
                        capture_output=True,
                        timeout=5,
                    )
                except (OSError, subprocess.TimeoutExpired):
                    self._process.kill()
            else:
                os.killpg(self._process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _shutdown() -> None:
    for runtime in list(_PROCESSES):
        runtime.close()


atexit.register(_shutdown)


def resolve_callback(
    value: Any,
    loop: asyncio.AbstractEventLoop | None,
    signal: AbortSignal | None = None,
) -> Any:
    if not inspect.isawaitable(value):
        return value

    async def await_value() -> Any:
        task = asyncio.ensure_future(value)
        try:
            while True:
                done, _ = await asyncio.wait([task], timeout=0.05)
                if task in done:
                    return task.result()
                if signal is not None and signal.aborted:
                    raise asyncio.CancelledError("Firedrill callback cancelled")
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    if loop is not None and loop.is_running():
        return asyncio.run_coroutine_threadsafe(await_value(), loop).result()
    return asyncio.run(await_value())
