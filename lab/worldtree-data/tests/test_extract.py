"""M3 extract kinds on hand-built bytes (no network): arxiv/pubmed/fedreg counts, noaa sentinel, month merge, as-of drop."""
import json
import os
import tempfile
import unittest
from pathlib import Path

from wt import extract as X
from wt.common import sha256_bytes
from wt.fetch import month_url

ARXIV = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <title>arXiv Query</title>
  <opensearch:totalResults>4262</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
</feed>
"""
NOAA = b"""# --------------------------------------------------------------
# USE OF NOAA GML DATA
#
year,month,decimal date,average,deseasonalized,ndays,sdev,unc
1958,3,1958.2027,315.71,314.44,-1,-9.99,-0.99
1958,6,1958.4548,-99.99,317.10,-1,-9.99,-0.99
1958,7,1958.5370,315.86,315.06,-1,-9.99,-0.99
1958,8,1958.6219,n/a,314.85,-1,-9.99,-0.99
"""


class TestParse(unittest.TestCase):
    def test_arxiv_xml(self):
        self.assertEqual(X.parse_count("arxiv", ARXIV), 4262)
        self.assertIsNone(X.parse_count("arxiv", b"<feed xmlns='http://www.w3.org/2005/Atom'/>"))
        self.assertIsNone(X.parse_count("arxiv", b"not xml"))

    def test_pubmed_json(self):
        self.assertEqual(X.parse_count("pubmed", b'{"header":{"type":"esearch"},"esearchresult":{"count":"536"}}'), 536)
        self.assertIsNone(X.parse_count("pubmed", b'{"esearchresult":{"ERROR":"bad"}}'))
        self.assertIsNone(X.parse_count("pubmed", b'{"esearchresult":{"count":""}}'))

    def test_fedreg_json(self):
        self.assertEqual(X.parse_count("fedreg", b'{"description":"x","count":29,"total_pages":2}'), 29)
        self.assertIsNone(X.parse_count("fedreg", b'{"errors":{}}'))
        self.assertIsNone(X.parse_count("fedreg", b""))


class TestFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("WT_ROOT")
        os.environ["WT_ROOT"] = self.tmp.name

    def tearDown(self):
        if self.old is None:
            os.environ.pop("WT_ROOT", None)
        else:
            os.environ["WT_ROOT"] = self.old
        self.tmp.cleanup()

    def put(self, src, slug, name, body, url, retrieved_at):
        d = Path(self.tmp.name) / "raw" / src / slug
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(body)
        (d / (name + ".prov.json")).write_text(json.dumps({
            "path": f"raw/{src}/{slug}/{name}", "url": url, "retrieved_at": retrieved_at, "sha256": sha256_bytes(body)}))

    def test_noaa_sentinel_and_nonnumeric_dropped(self):
        self.put("noaa_gml", "co2_mm_mlo", "20261004T000000Z.csv", NOAA, "https://gml.noaa.gov/x.csv", "2026-10-04T00:00:00Z")
        s = {"source_id": "noaa_gml", "slug": "co2_mm_mlo", "extract": "noaa:monthly", "cadence": "monthly"}
        rows = X.build(s, "2026-10-04")
        self.assertEqual([(p, d, v) for p, d, v, _ in rows],
                         [("1958-03", "1958-03-31", "315.71"), ("1958-07", "1958-07-31", "315.86")])

    def test_newest_snapshot_wins_per_month_and_month_from_url(self):
        s = {"source_id": "pubmed", "slug": "ai_biomed", "extract": "pubmed:monthly", "cadence": "monthly"}
        aug, sep = month_url("pubmed", 2026, 8)[1], month_url("pubmed", 2026, 9)[1]
        # filenames deliberately say nothing about the month: the sidecar url decides
        self.put("pubmed", "ai_biomed", "a.json", b'{"esearchresult":{"count":"100"}}', aug, "2026-09-02T06:00:00Z")
        self.put("pubmed", "ai_biomed", "b.json", b'{"esearchresult":{"count":"120"}}', aug, "2026-10-02T06:00:00Z")
        self.put("pubmed", "ai_biomed", "c.json", b'{"esearchresult":{"count":"50"}}', sep, "2026-10-02T06:00:01Z")
        self.put("pubmed", "ai_biomed", "d.json", b'{"esearchresult":{"ERROR":"x"}}', sep, "2026-10-03T06:00:00Z")
        rows = X.build(s, "2026-10-04")
        self.assertEqual([(p, v) for p, _, v, _ in rows], [("2026-08", "120"), ("2026-09", "50")])
        self.assertEqual(rows[0][3], sha256_bytes(b'{"esearchresult":{"count":"120"}}'))
        # as-of before the re-fetch: the older August snapshot is the newest one visible
        rows = X.build(s, "2026-09-30")
        self.assertEqual([(p, v) for p, _, v, _ in rows], [("2026-08", "100")])

    def test_asof_drops_snapshots_and_future_months(self):
        s = {"source_id": "arxiv", "slug": "cs.AI", "extract": "arxiv:monthly", "cadence": "monthly"}
        self.put("arxiv", "cs.AI", "a.xml", ARXIV, month_url("arxiv", 2026, 9)[1], "2026-10-04T06:00:00Z")
        self.assertEqual(X.build(s, "2026-10-03"), [])  # retrieved after as_of
        self.assertEqual(X.build(s, "2026-09-15"), [])
        rows = X.build(s, "2026-10-04")
        self.assertEqual([(p, d, v) for p, d, v, _ in rows], [("2026-09", "2026-09-30", "4262")])
        s = {"source_id": "fedreg", "slug": "ai_documents", "extract": "fedreg:monthly", "cadence": "monthly"}
        self.put("fedreg", "ai_documents", "a.json", b'{"count":29}', month_url("fedreg", 2026, 10)[1], "2026-10-04T06:00:00Z")
        self.assertEqual(X.build(s, "2026-10-04"), [])  # month end 2026-10-31 > as_of


if __name__ == "__main__":
    unittest.main()
