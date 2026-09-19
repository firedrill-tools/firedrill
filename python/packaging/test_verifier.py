"""Keep release failures actionable without requiring a native wheel fixture."""

import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from verify_wheel import run


class VerifierDiagnosticsTests(unittest.TestCase):
    def test_timeout_keeps_captured_pip_diagnostics(self):
        failure = subprocess.TimeoutExpired(
            ["python", "-m", "pip"], 120,
            output=b"Collecting optional dependency\n",
            stderr=b"Building native extension\n",
        )
        with patch("verify_wheel.subprocess.run", side_effect=failure):
            with self.assertRaises(RuntimeError) as result:
                run(["python", "-m", "pip"], environment=os.environ, cwd=Path.cwd())
        self.assertIn("timed out after 120 seconds", str(result.exception))
        self.assertIn("Collecting optional dependency", str(result.exception))
        self.assertIn("Building native extension", str(result.exception))

    def test_timeout_without_output_still_reports_command(self):
        with patch("verify_wheel.subprocess.run", side_effect=subprocess.TimeoutExpired(["firedrill"], 1)):
            with self.assertRaisesRegex(RuntimeError, "firedrill.*timed out after 1 seconds"):
                run(["firedrill"], environment=os.environ, cwd=Path.cwd(), timeout=1)


if __name__ == "__main__":
    unittest.main()
