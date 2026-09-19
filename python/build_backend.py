"""PEP 517 backend for wheels containing the private Firedrill runtime.

The runtime is assembled by tooling/build-python-runtime.mts in native release
jobs. Installation never downloads a runtime or executes an npm build.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import stat
import time
import zipfile

ROOT = Path(__file__).resolve().parent
VERSION = "0.1.0rc1"


def _distribution(config_settings=None):
    return "firedrill_run"


def _payload(config_settings=None):
    return ROOT / "src" / "firedrill"


def _runtime_manifest(config_settings=None):
    package = _payload(config_settings)
    path = package / "_runtime/manifest.json"
    if not path.is_file():
        raise RuntimeError(
            "Build the bundled runtime first from the repository root: "
            "pnpm build && pnpm exec tsx tooling/build-python-runtime.mts. "
            "End users should install a published wheel with pip install firedrill-run."
        )
    manifest = json.loads(path.read_text(encoding="utf-8"))
    expected = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}.get(platform.system())
    architecture = {"AMD64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    if manifest["target"] != f"{expected}-{architecture}":
        raise RuntimeError("The staged runtime belongs to a different platform. Build each wheel natively.")
    runtime = path.parent
    actual = set()
    for file in runtime.rglob("*"):
        if file.is_symlink():
            raise RuntimeError(f"Runtime payload contains a symlink: {file}")
        if not file.is_file() or file == path:
            continue
        relative = file.relative_to(runtime).as_posix()
        actual.add(relative)
        expected_hash = manifest["files"].get(relative)
        if expected_hash is None or hashlib.sha256(file.read_bytes()).hexdigest() != expected_hash:
            raise RuntimeError(f"Runtime payload differs from its assembly manifest: {relative}. Rebuild the runtime.")
    if actual != set(manifest["files"]):
        raise RuntimeError("Runtime payload is missing files recorded in its assembly manifest. Rebuild the runtime.")
    return manifest


def _metadata(config_settings=None):
    name = "firedrill-run"
    summary = "Stateful simulation and testing for AI agents"
    lines = [
        "Metadata-Version: 2.4",
        f"Name: {name}",
        f"Version: {VERSION}",
        f"Summary: {summary}",
        "Author: Reload Tech Inc.",
        "Requires-Python: >=3.10",
        "License-Expression: Apache-2.0",
        "License-File: LICENSE",
        "Project-URL: Homepage, https://firedrill.run",
        "Project-URL: Documentation, https://docs.firedrill.run",
        "Project-URL: Source, https://github.com/firedrill-tools/firedrill",
        "Description-Content-Type: text/markdown",
    ]
    lines.extend([
        "Provides-Extra: pytest",
        'Requires-Dist: pytest>=7.4; extra == "pytest"',
        "Provides-Extra: agent",
        'Requires-Dist: claude-agent-sdk==0.2.145; extra == "agent"',
        # Keep Intel macOS installs binary-only; newer releases require Rust.
        'Requires-Dist: cryptography>=48.0.1,<49; sys_platform == "darwin" and platform_machine == "x86_64" and extra == "agent"',
    ])
    readme = ROOT / "README.md"
    description = readme.read_text(encoding="utf-8") if readme.exists() else summary
    return ("\n".join(lines) + "\n\n" + description).encode()


def _metadata_files(config_settings=None):
    manifest = _runtime_manifest(config_settings)
    distribution = _distribution(config_settings)
    prefix = f"{distribution}-{VERSION}.dist-info"
    tag = f"py3-none-{manifest['wheelPlatform']}"
    files = {
        f"{prefix}/METADATA": _metadata(config_settings),
        f"{prefix}/WHEEL": (
            "Wheel-Version: 1.0\nGenerator: firedrill.build_backend\n"
            f"Root-Is-Purelib: false\nTag: {tag}\n"
        ).encode(),
    }
    files[f"{prefix}/entry_points.txt"] = (
        "[console_scripts]\nfiredrill = firedrill.cli:main\n\n"
        "[pytest11]\nfiredrill = firedrill.pytest_plugin\n"
    ).encode()
    license_path = ROOT.parent / "LICENSE"
    files[f"{prefix}/licenses/LICENSE"] = license_path.read_bytes()
    return files, tag, prefix


def get_requires_for_build_wheel(config_settings=None):
    return []


def prepare_metadata_for_build_wheel(metadata_directory, config_settings=None):
    files, _, prefix = _metadata_files(config_settings)
    for name, content in files.items():
        destination = Path(metadata_directory) / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    return prefix


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    del metadata_directory
    metadata, tag, prefix = _metadata_files(config_settings)
    package = _payload(config_settings)
    files = []
    for path in sorted(package.rglob("*")):
        if path.is_symlink():
            raise RuntimeError(f"Runtime wheel must not contain symlinks: {path}")
        if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        files.append((path.relative_to(ROOT / "src").as_posix(), path))
    destination = Path(wheel_directory)
    destination.mkdir(parents=True, exist_ok=True)
    filename = f"{_distribution(config_settings)}-{VERSION}-{tag}.whl"
    records = []
    timestamp = time.gmtime(max(int(os.environ.get("SOURCE_DATE_EPOCH", "315532800")), 315532800))[:6]
    with zipfile.ZipFile(destination / filename, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as wheel:
        def write(name, data, mode=0o644):
            info = zipfile.ZipInfo(name, timestamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | mode) << 16
            wheel.writestr(info, data)
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            records.append((name, f"sha256={digest}", str(len(data))))

        for name, path in files:
            write(name, path.read_bytes(), 0o755 if path.stat().st_mode & 0o111 else 0o644)
        for name, data in sorted(metadata.items()):
            write(name, data)
        record = io.StringIO(newline="")
        writer = csv.writer(record, lineterminator="\n")
        writer.writerows(records)
        writer.writerow((f"{prefix}/RECORD", "", ""))
        info = zipfile.ZipInfo(f"{prefix}/RECORD", timestamp)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        wheel.writestr(info, record.getvalue())
    return filename


def build_sdist(sdist_directory, config_settings=None):
    del sdist_directory, config_settings
    raise RuntimeError(
        "Firedrill publishes platform wheels containing its runtime. "
        "Build a wheel with python -m build --wheel; source builds use the Git repository."
    )
