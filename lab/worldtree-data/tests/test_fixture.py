"""Determinism: current code on the current method version's frozen fixture is byte-identical (prediction.md §6)."""
import filecmp
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fixture_lib import R, run_fixture  # noqa: E402

from wt.common import method_version  # noqa: E402


class TestFixture(unittest.TestCase):
    def test_byte_identical(self):
        fx = R / "tests" / "fixtures" / method_version()
        self.assertTrue((fx / "realms.json").exists(), f"no fixture for {method_version()}")
        with tempfile.TemporaryDirectory() as tmp:
            out = run_fixture(fx, Path(tmp))
            self.assertTrue(filecmp.cmp(out / "realms.json", fx / "realms.json", shallow=False), "realms.json differs")
            self.assertTrue(filecmp.cmp(out / "realms.provenance.json", fx / "provenance.json", shallow=False),
                            "provenance.json differs")


if __name__ == "__main__":
    unittest.main()
