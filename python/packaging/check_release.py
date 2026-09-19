"""Require one matching, verified-platform wheel for every supported target."""

from __future__ import annotations

import argparse
import email.parser
import hashlib
import json
from pathlib import Path
import runpy
import zipfile


def check_release(directory: Path) -> list[dict[str, str]]:
    root = Path(__file__).resolve().parents[1]
    version = runpy.run_path(str(root / "build_backend.py"))["VERSION"]
    releases = json.loads((root / "packaging/node-releases.json").read_text())["releases"]
    expected = {
        f"firedrill_run-{version}-py3-none-{release['wheelPlatform']}.whl": target
        for target, release in releases.items()
    }
    actual = {path.name for path in directory.iterdir()}
    if actual != set(expected):
        raise ValueError(
            f"Release must contain exactly the supported wheels; "
            f"missing={sorted(set(expected) - actual)}, unexpected={sorted(actual - set(expected))}"
        )
    receipt = []
    for name, target in sorted(expected.items()):
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size >= 100 * 1024 * 1024:
            raise ValueError(f"Invalid or oversized wheel: {name}")
        with zipfile.ZipFile(path) as archive:
            metadata_path = f"firedrill_run-{version}.dist-info/METADATA"
            metadata = email.parser.BytesParser().parsebytes(archive.read(metadata_path))
            if metadata.get_all("Name") != ["firedrill-run"] or metadata.get_all("Version") != [version]:
                raise ValueError(f"Unexpected distribution identity: {name}")
            manifest = json.loads(archive.read("firedrill/_runtime/manifest.json"))
            if manifest["target"] != target or manifest["wheelPlatform"] != releases[target]["wheelPlatform"]:
                raise ValueError(f"Runtime target does not match wheel: {name}")
            corrupt = archive.testzip()
            if corrupt is not None:
                raise ValueError(f"Corrupt wheel member: {name}:{corrupt}")
        receipt.append({"file": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args()
    print(json.dumps({"wheels": check_release(arguments.directory)}, indent=2))
