"""Fail-closed release-set checks; these fixtures do not execute a runtime."""

import json
import runpy
import tempfile
import unittest
import zipfile
from pathlib import Path

from check_release import check_release


class ReleaseSetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        root = Path(__file__).resolve().parents[1]
        self.version = runpy.run_path(str(root / "build_backend.py"))["VERSION"]
        self.releases = json.loads((root / "packaging/node-releases.json").read_text())["releases"]
        for target in self.releases:
            self.write_wheel(target)

    def write_wheel(self, target, *, name="firedrill-run", runtime_target=None):
        tag = self.releases[target]["wheelPlatform"]
        path = self.directory / f"firedrill_run-{self.version}-py3-none-{tag}.whl"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(
                f"firedrill_run-{self.version}.dist-info/METADATA",
                f"Metadata-Version: 2.4\nName: {name}\nVersion: {self.version}\n",
            )
            archive.writestr(
                "firedrill/_runtime/manifest.json",
                json.dumps({"target": runtime_target or target, "wheelPlatform": tag}),
            )
        return path

    def test_complete_set_has_digest_receipt(self):
        receipt = check_release(self.directory)
        self.assertEqual(len(receipt), len(self.releases))
        self.assertTrue(all(len(row["sha256"]) == 64 for row in receipt))

    def test_missing_or_extra_files_block_publication(self):
        self.write_wheel("win32-x64").unlink()
        with self.assertRaisesRegex(ValueError, "missing="):
            check_release(self.directory)
        self.write_wheel("win32-x64")
        (self.directory / "unreviewed.tar.gz").write_bytes(b"not a wheel")
        with self.assertRaisesRegex(ValueError, "unexpected="):
            check_release(self.directory)

    def test_wrong_identity_blocks_publication(self):
        self.write_wheel("linux-x64", name="unrelated-distribution")
        with self.assertRaisesRegex(ValueError, "distribution identity"):
            check_release(self.directory)

    def test_wrong_runtime_architecture_blocks_publication(self):
        self.write_wheel("linux-x64", runtime_target="linux-arm64")
        with self.assertRaisesRegex(ValueError, "Runtime target"):
            check_release(self.directory)


if __name__ == "__main__":
    unittest.main()
