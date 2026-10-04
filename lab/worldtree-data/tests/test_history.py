"""Method 0.3.0 history: no-lookahead, determinism, sum-to-100, provisional flags (on the frozen 0.3.0 fixture)."""
import csv
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fixture_lib import R  # noqa: E402

from wt.common import REALMS, dumps, sha256_bytes, sha256_file  # noqa: E402

FX = R / "tests" / "fixtures" / "0.3.0"
CUT_YEAR = 2020  # mutate only observations after this year's Dec-31


def tree(tmp: Path):
    shutil.copytree(FX / "raw", tmp / "raw")
    shutil.copytree(R / "catalog", tmp / "catalog")
    shutil.copytree(R / "method", tmp / "method")
    for d in ("series", "runs", "out"):
        (tmp / d).mkdir()
    return tmp


def history(tmp: Path):
    env = dict(os.environ, WT_ROOT=str(tmp))
    env.pop("WT_CATALOG", None)
    as_of, now = (FX / "as_of").read_text().strip(), (FX / "now").read_text().strip()
    subprocess.run([sys.executable, "-m", "wt", "history", "--as-of", as_of, "--now", now],
                   cwd=R, env=env, check=True, capture_output=True, text=True)
    return tmp / "out" / "realms-history.json"


def rewrite(path: Path, text: str):
    """Replace a raw file and keep its sidecar honest (sha256/bytes), so integrity still holds."""
    path.write_text(text, encoding="utf-8")
    sc = Path(str(path) + ".prov.json")
    meta = json.loads(sc.read_text())
    meta["sha256"], meta["bytes"] = sha256_file(path), path.stat().st_size
    sc.write_text(dumps(meta))


def add_future(tmp: Path):
    """Change every observation dated after CUT_YEAR and append rows beyond today, across 4 source kinds."""
    noaa = next((tmp / "raw/noaa_gml/co2_mm_mlo").glob("*.csv"))
    lines = noaa.read_text().splitlines()
    out = []
    for ln in lines:
        p = ln.split(",")
        if not ln.startswith("#") and p[0].isdigit() and int(p[0]) > CUT_YEAR:
            p[3] = f"{float(p[3]) * 1.01:.2f}"
        out.append(",".join(p))
    out.append(out[-1].replace(out[-1].split(",")[0], "2030", 1))
    rewrite(noaa, "\n".join(out) + "\n")

    le = next((tmp / "raw/owid/life-expectancy").glob("*.csv"))
    rows = list(csv.DictReader(io.StringIO(le.read_text(encoding="utf-8"))))
    for r in rows:
        if r["entity"] == "World" and int(r["year"]) > CUT_YEAR:
            r["life_expectancy_0"] = str(float(r["life_expectancy_0"]) - 3)
    rows.append({"entity": "World", "code": "OWID_WRL", "year": "2031", "life_expectancy_0": "90"})
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0]), lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    rewrite(le, buf.getvalue())

    gdp = next(p for p in (tmp / "raw/worldbank/NY.GDP.PCAP.KD").glob("*.json") if not p.name.endswith(".prov.json"))
    data = json.loads(gdp.read_text())
    for r in data[1]:
        if int(r["date"]) > CUT_YEAR and r["value"] is not None:
            r["value"] = r["value"] * 0.9
    rewrite(gdp, json.dumps(data))

    ep = next((tmp / "raw/epoch/notable_ai_models").glob("*.csv"))
    rows = list(csv.DictReader(io.StringIO(ep.read_text(encoding="utf-8"))))
    fresh = [dict(rows[0], **{"Publication date": f"2026-0{m}-15", "Model accessibility": "Open weights (unrestricted)",
                              "Organization": f"Future Lab {m}", "Training compute (FLOP)": "1e30"}) for m in range(1, 9)]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0]), lineterminator="\n")
    w.writeheader()
    w.writerows(rows + fresh)
    rewrite(ep, buf.getvalue())


def strip_snap(blob):
    """A year's numbers minus raw-file identity: the raw file legitimately changed, and every series row carries
    its raw sha256 (so series_sha256 moves too) — the pre-cut values are asserted separately (pre_cut_values)."""
    b = json.loads(json.dumps(blob))
    for k in b["realms"].values():
        for i in k["indicators"]:
            i.pop("snapshot_sha256")
            i.pop("series_sha256")
    return b


def pre_cut_values(tmp: Path, sid: str):
    rows = csv.DictReader(io.StringIO((tmp / "series" / f"{sid}.csv").read_text()))
    return [(r["period"], r["date"], r["value"]) for r in rows if r["date"] <= f"{CUT_YEAR}-12-31"]


class TestHistory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.base = history(tree(Path(cls._tmp.name) / "a"))
        cls.doc = json.loads(cls.base.read_text())

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_matches_fixture_and_deterministic(self):
        self.assertEqual(self.base.read_bytes(), (FX / "realms-history.json").read_bytes())
        again = history(tree(Path(self._tmp.name) / "b"))
        self.assertEqual(self.base.read_bytes(), again.read_bytes())
        self.assertEqual(self.base.with_name("realms-history.provenance.json").read_bytes(),
                         again.with_name("realms-history.provenance.json").read_bytes())

    def test_sum_100_and_provisional(self):
        d = self.doc
        self.assertEqual(d["schema"], "worldtree.history/1")
        self.assertEqual([y["year"] for y in d["years"]], list(range(2015, 2027)))
        for y in d["years"]:
            self.assertEqual(list(y["weights"]), REALMS)
            self.assertEqual(sum(round(y["weights"][k] * 10) for k in REALMS), 1000, y["year"])
            for k in REALMS:
                self.assertEqual(y["provisional"][k], y["coverage"][k] < 0.5, (y["year"], k))
        self.assertTrue(any(d["years"][0]["provisional"].values()), "2015 should be thin")
        self.assertFalse(any(d["years"][-1]["provisional"].values()), "as-of year fully covered")

    def test_provenance_hashes(self):
        ptext = self.base.with_name("realms-history.provenance.json").read_text(encoding="utf-8")
        self.assertEqual(self.doc["provenance"]["sha256"], sha256_bytes(ptext.encode()))
        prov = json.loads(ptext)
        for y in self.doc["years"]:
            blob = prov["years"][str(y["year"])]
            self.assertEqual(y["provenance"]["sha256"], sha256_bytes(dumps(blob, sort_keys=False).encode()))
            for k in REALMS:
                self.assertEqual(blob["realms"][k]["weight"], y["weights"][k])

    def test_last_year_equals_run(self):
        last = self.doc["years"][-1]
        self.assertEqual(last["weights"], json.loads((FX / "realms.json").read_text())["weights"])

    def test_no_lookahead(self):
        tmp = tree(Path(self._tmp.name) / "c")
        add_future(tmp)
        mut = json.loads(history(tmp).read_text())
        pa = json.loads(self.base.with_name("realms-history.provenance.json").read_text())
        pb = json.loads((tmp / "out" / "realms-history.provenance.json").read_text())
        for ya, yb in zip(self.doc["years"], mut["years"]):
            if ya["year"] <= CUT_YEAR:
                self.assertEqual(ya["weights"], yb["weights"], ya["year"])
                self.assertEqual(ya["coverage"], yb["coverage"], ya["year"])
                self.assertEqual(strip_snap(pa["years"][str(ya["year"])]), strip_snap(pb["years"][str(yb["year"])]),
                                 ya["year"])
        for sid in ("noaa.co2", "owid.life_expectancy", "wb.gdp_per_capita", "epoch.frontier_compute"):
            self.assertEqual(pre_cut_values(self.base.parent.parent, sid), pre_cut_values(tmp, sid), sid)
        later = [y for y in zip(self.doc["years"], mut["years"]) if y[0]["year"] > CUT_YEAR]
        self.assertTrue(any(a["weights"] != b["weights"] for a, b in later), "mutation had no effect — test is vacuous")


if __name__ == "__main__":
    unittest.main()
