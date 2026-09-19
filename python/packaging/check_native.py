"""Reject a wheel payload whose native binaries exceed its declared OS baseline."""

from __future__ import annotations

from pathlib import Path
import platform
import re
import subprocess
import sys


def version(value):
    return tuple(int(part) for part in value.split("."))


def check(root):
    checked = 0
    for path in Path(root).rglob("*"):
        if not path.is_file():
            continue
        with path.open("rb") as file:
            magic = file.read(4)
        if platform.system() == "Darwin" and magic in (
            b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf",
            b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
        ):
            output = subprocess.check_output(["otool", "-l", str(path)], text=True)
            minimums = []
            for command in output.split("Load command "):
                if "LC_BUILD_VERSION" in command:
                    match = re.search(r"\bminos (\d+(?:\.\d+)+)", command)
                elif "LC_VERSION_MIN_MACOSX" in command:
                    match = re.search(r"\bversion (\d+(?:\.\d+)+)", command)
                else:
                    continue
                if match:
                    minimums.append(version(match[1]))
            if not minimums or any(value > (13, 0, 0) for value in minimums):
                raise RuntimeError(f"{path} requires macOS newer than the declared 13.0 wheel baseline: {minimums}")
            checked += 1
        elif platform.system() == "Linux" and magic == b"\x7fELF":
            output = subprocess.check_output(["readelf", "--version-info", str(path)], text=True, stderr=subprocess.DEVNULL)
            for namespace, baseline in [("GLIBC", (2, 35)), ("GLIBCXX", (3, 4, 30)), ("CXXABI", (1, 3, 13))]:
                required = [version(value) for value in re.findall(r"\b" + namespace + r"_(\d+(?:\.\d+)+)\b", output)]
                if required and max(required) > baseline:
                    raise RuntimeError(f"{path} requires {namespace} {max(required)} above the wheel's Linux baseline {baseline}")
            checked += 1
    if platform.system() in ("Darwin", "Linux") and not checked:
        raise RuntimeError("No native runtime binaries were found to check.")
    print(f"Native OS baseline verified for {checked} binaries")


if __name__ == "__main__":
    check(sys.argv[1])
