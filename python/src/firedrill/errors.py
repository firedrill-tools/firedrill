"""Errors raised by the local Firedrill runtime."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class FiredrillError(RuntimeError):
    """A runtime error with a stable code and structured diagnostic details."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "framework.PYTHON_ERROR",
        details: Any = None,
        diagnostics: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details
        self.diagnostics = diagnostics if diagnostics is not None else []

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> FiredrillError:
        return cls(
            str(payload.get("message", "Firedrill operation failed")),
            code=str(payload.get("code", "framework.RUNTIME_ERROR")),
            details=payload.get("details"),
            diagnostics=payload.get("diagnostics"),
        )


class RuntimeUnavailableError(FiredrillError):
    """The installed distribution does not contain a usable local runtime."""


class DrillAssertionError(AssertionError):
    """A drill selection did not pass. The complete result remains available."""

    def __init__(self, message: str, result: Any) -> None:
        super().__init__(message)
        self.result = result


class ToolError(FiredrillError):
    """A synthetic operation returned a declared Tool error."""

    def __init__(self, message: str, *, result: Any, code: str) -> None:
        super().__init__(message, code=code)
        self.result = result
