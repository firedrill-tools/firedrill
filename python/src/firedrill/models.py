"""Mapping-based results preserve authored JSON keys and provide Python attributes."""

from __future__ import annotations

import dataclasses
import os
from collections.abc import Mapping
from typing import Any

from .errors import DrillAssertionError


def camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


class Record(dict[str, Any]):
    """A JSON mapping, with snake_case aliases when accessed as attributes.

    Dictionary keys and user data are never renamed. Use square brackets for
    keys that coincide with dictionary methods, such as ``items``.
    """

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        key = name if name in self else camel(name)
        try:
            return self[key]
        except KeyError:
            raise AttributeError(name) from None

    def to_dict(self) -> dict[str, Any]:
        return plain(self)


def record(value: Any) -> Any:
    if isinstance(value, dict):
        return Record({key: record(item) for key, item in value.items()})
    if isinstance(value, list):
        return [record(item) for item in value]
    return value


def plain(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return plain(dataclasses.asdict(value))
    if isinstance(value, Mapping):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    if isinstance(value, os.PathLike):
        return os.fspath(value)
    return value


# Only API option envelopes are translated. Authored source, inputs, schemas,
# environment variable names and arbitrary JSON always keep their exact keys.
_ENVELOPES = {"capture", "redaction", "shard"}


def options(value: Mapping[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    combined = dict(value or {})
    combined.update({key: value for key, value in kwargs.items() if value is not None})
    result: dict[str, Any] = {}
    for key, item in combined.items():
        if item is None:
            continue
        translated = camel(key)
        if translated in result:
            raise TypeError(f"Duplicate Firedrill option: {translated}")
        result[translated] = (
            options(item)
            if key in _ENVELOPES and isinstance(item, Mapping)
            else plain(item)
        )
    return result


class RunResult(Record):
    """A complete drill result, including every trial, attempt and report path."""

    schema_version: int
    repository_root: str
    build_hash: str
    package_lock_hash: str
    report_index: str
    verdict: str
    diagnostics: list[Record]
    selection: Record
    drills: list[Record]

    def assert_passed(self) -> RunResult:
        if self.get("verdict") == "passed":
            return self
        failures = []
        for drill in self.get("drills", []):
            if drill.get("verdict") != "passed":
                failures.append(
                    f"{drill.get('drillId', '?')}: {drill.get('verdict', 'unknown')}"
                )
        report = self.get("reportIndex")
        message = "Drills did not pass"
        if failures:
            message += ": " + "; ".join(failures)
        if report:
            message += f"\nReport: {report}"
        raise DrillAssertionError(message, self)


class BrowserResult(Record):
    """Browser test result with the same assertion convenience as drill results."""

    run_id: str
    status: str
    definition: Record
    report_directory: str
    report_path: str
    duration_ms: int
    assertions: list[Record]
    events: list[Record]
    artifacts: list[Record]
    errors: list[Record]
    replayable: bool
    replay_issues: list[str]

    def assert_passed(self) -> BrowserResult:
        if self.get("status") == "passed":
            return self
        raise DrillAssertionError(
            f"Browser test did not pass: {self.get('status', 'unknown')}\n"
            f"Report: {self.get('directory', self.get('reportDirectory', 'see result'))}",
            self,
        )
