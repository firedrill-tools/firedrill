"""Function-scoped pytest fixtures for worlds, bindings and drill runs."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from .sdk import run_drills, run_drills_async
from .world import Binding, World


def pytest_addoption(parser: Any) -> None:
    group = parser.getgroup("firedrill")
    group.addoption(
        "--firedrill-root",
        default=None,
        help="Project directory containing firedrill.json",
    )


def pytest_configure(config: Any) -> None:
    config.addinivalue_line(
        "markers",
        "firedrill(root=None, scenario=None, drill=None, seed=None, actor_id=None): configure a test's isolated local world",
    )


class FiredrillFixture:
    """Per-test project handle; the world is created lazily on first access."""

    def __init__(self, root: Path, settings: dict[str, Any]) -> None:
        self.root = root
        self._settings = settings
        self._world: World | None = None

    @property
    def world(self) -> World:
        if self._world is None:
            settings = {
                key: value for key, value in self._settings.items() if key != "actor_id"
            }
            self._world = World.from_project(self.root, **settings)
        return self._world

    def listen(self, **kwargs: Any) -> Binding:
        settings = (
            {"actor_id": self._settings["actor_id"]}
            if "actor_id" in self._settings
            else {}
        )
        settings.update(kwargs)
        return self.world.listen(**settings)

    def run(self, drill: str | None = None, **kwargs: Any) -> Any:
        settings = {
            key: value
            for key, value in self._settings.items()
            if key in {"drill", "seed", "build_hash"}
        }
        settings.update(kwargs)
        if drill is not None:
            settings["drill"] = drill
        return run_drills(self.root, **settings)

    async def run_async(self, drill: str | None = None, **kwargs: Any) -> Any:
        settings = {
            key: value
            for key, value in self._settings.items()
            if key in {"drill", "seed", "build_hash"}
        }
        settings.update(kwargs)
        if drill is not None:
            settings["drill"] = drill
        return await run_drills_async(self.root, **settings)

    def close(self) -> None:
        if self._world is not None:
            self._world.close()


@pytest.fixture
def firedrill(request: Any) -> Iterator[FiredrillFixture]:
    marker = request.node.get_closest_marker("firedrill")
    settings = dict(marker.kwargs) if marker else {}
    root = settings.pop("root", None) or request.config.getoption("--firedrill-root")
    if root is None:
        directory = Path(str(request.path)).resolve().parent
        root = next(
            (
                path
                for path in (directory, *directory.parents)
                if (path / "firedrill.json").is_file()
            ),
            None,
        )
        if root is None:
            pytest.fail(
                "No firedrill.json found. Run 'firedrill init' or pass --firedrill-root PATH.",
                pytrace=False,
            )
    selected = Path(root)
    if not selected.is_absolute():
        selected = Path(request.config.rootpath) / selected
    fixture = FiredrillFixture(selected.resolve(), settings)
    try:
        yield fixture
    finally:
        fixture.close()


@pytest.fixture
def firedrill_world(firedrill: FiredrillFixture) -> World:
    return firedrill.world


@pytest.fixture
def firedrill_binding(firedrill: FiredrillFixture) -> Iterator[Binding]:
    with firedrill.listen() as binding:
        yield binding
