"""Method 0.3.1 ARI: parse (embedded ari-data block → weekly rows), gate (ref_n floor), provenance (methodology in sidecar),
no-lookahead (history years before the first week byte-identical to 0.3.0) — on the frozen 0.3.1 fixture."""
import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fixture_lib import R, run_fixture  # noqa: E402

from wt import method as M  # noqa: E402
from wt.extract import ARI_CATS, ARI_META, HEADER, ari_block, x_ari  # noqa: E402

FX = R / "tests" / "fixtures" / "0.3.1"
URL = "https://dweeb-xzys-mac-studio.tail5435b1.ts.net/api/artifact/report-ari.html"
WEIGHTS = {"os_restriction": 3, "platform_ban": 3, "datacenter_backlash": 2, "safety_exit": 2, "legal_wall": 1}


def raw_html():
    return next((FX / "raw" / "ari" / "report").glob("*.html"))


class TestAri(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = run_fixture(FX, Path(cls.tmp.name), drop_mapping=("github.",))  # 0.4.1 rows: not this test's method
        cls.series = Path(cls.tmp.name) / "series" / "ari.index.csv"

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_parse(self):
        rows = x_ari({}, raw_html(), {})
        self.assertEqual(len(rows), 26)
        self.assertEqual(rows[0][:3], ("2026-04-12", "2026-04-12", 79.0))
        self.assertAlmostEqual(rows[-1][2], 79.0, delta=0.5)
        self.assertTrue(all(0 <= r[2] <= 100 for r in rows))
        with open(self.series, newline="") as f:
            got = list(csv.DictReader(f))
        self.assertEqual(list(got[0]), HEADER + ARI_META)
        self.assertEqual(len(got), 26)
        for r in got:  # s = Σ weighted points, n = Σ event counts, points = count × component weight
            self.assertEqual(int(r["s"]), sum(int(r[f"pts_{c}"]) for c in ARI_CATS))
            self.assertEqual(int(r["n"]), sum(int(r[f"n_{c}"]) for c in ARI_CATS))
            for c in ARI_CATS:
                self.assertEqual(int(r[f"pts_{c}"]), WEIGHTS[c] * int(r[f"n_{c}"]), (r["date"], c))
        self.assertIsNone(ari_block(b"<html>no block</html>"))

    def test_weekly_pidx(self):
        a, b = M.pidx("2026-09-27", "weekly"), M.pidx("2026-10-04", "weekly")
        self.assertEqual(b - a, 1)

    def test_gate(self):
        rows = x_ari({}, raw_html(), {})
        rows = [(p, d, v) for p, d, v, _ in rows]
        res = M.score("rank_level", rows, "weekly", {"h": "104"}, +1)
        self.assertEqual(res["ref_n"], 25)
        self.assertGreaterEqual(res["ref_n"], M.FLOOR["weekly"])
        self.assertEqual(M.FLOOR["weekly"], M.FLOOR["monthly"])
        with self.assertRaises(M.Excluded) as e:  # 24 weeks → 23 reference points < 24
            M.score("rank_level", rows[:24], "weekly", {"h": "104"}, +1)
        self.assertEqual(e.exception.reason, "short_history")
        prov = json.loads((self.out / "realms.provenance.json").read_text())
        ind = [i for i in prov["realms"]["control"]["indicators"] if i["series_id"] == "ari.index"]
        self.assertEqual(len(ind), 1)
        self.assertEqual((ind[0]["ref_n"], ind[0]["latest_value"], ind[0]["transform"]), (25, 79, "rank_level"))
        self.assertIn("B14", ind[0]["bias"])

    def test_provenance(self):
        sc = json.loads(Path(str(raw_html()) + ".prov.json").read_text())
        self.assertEqual((sc["schema"], sc["http_status"], sc["source_id"]), ("worldtree.prov/1", 200, "ari"))
        self.assertEqual(sc["methodology_url"], URL + "#method")
        self.assertEqual({c["id"]: c["weight"] for c in sc["methodology"]["components"]}, WEIGHTS)
        self.assertEqual(sc["methodology"]["K"], 5.77)
        self.assertIn("§method", sc["license"])
        self.assertIn("methodology at report §method", sc["attribution"])
        r = json.loads((self.out / "realms.json").read_text())
        self.assertEqual(r["sources"]["Mac Studio ARI pipeline"], 1)
        self.assertEqual([f["state"] for f in r["feeds"] if f["name"] == "Agent Restriction Index (ARI)"],
                         ["2026-10-04 · score 0.90"])
        self.assertEqual(r["geography"]["ari"]["source_doc"], URL)

    def test_history_unborn(self):
        """ARI starts 2026-04-12: every earlier year's per-year provenance blob is byte-identical to method 0.3.0."""
        new = json.loads((self.out / "realms-history.json").read_text())["years"]
        old = json.loads((R / "tests" / "fixtures" / "0.3.0" / "realms-history.json").read_text())["years"]
        hp = json.loads((self.out / "realms-history.provenance.json").read_text())["years"]
        for x, y in zip(old, new):
            ids = {i["series_id"] for R_ in hp[str(y["year"])]["realms"].values() for i in R_["indicators"]}
            if y["year"] < 2026:
                self.assertEqual(x["provenance"]["sha256"], y["provenance"]["sha256"], y["year"])
                self.assertEqual(x["weights"], y["weights"], y["year"])
                self.assertNotIn("ari.index", ids)
            else:
                self.assertIn("ari.index", ids)


if __name__ == "__main__":
    unittest.main()
