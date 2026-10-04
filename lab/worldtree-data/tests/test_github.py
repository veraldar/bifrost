"""GitHub source (method 0.4.1): parsers, extraction rules, nightly budget guard — no network."""
import datetime as dt
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from wt import github as GH  # noqa: E402

FX = Path(__file__).resolve().parent / "fixtures" / "github"


def month_end(y, m):
    import calendar
    return dt.date(y, m, calendar.monthrange(y, m)[1])


def meta(url, t, body, store):
    p = f"m{len(store)}"
    store[p] = body if isinstance(body, bytes) else json.dumps(body).encode()
    return {"url": url, "retrieved_at": t, "path": p, "sha256": f"{len(store):064x}"}


class TestParsers(unittest.TestCase):
    def test_frozen_release_page(self):
        fx = json.loads((FX / "pytorch-releases-trimmed.json").read_text())
        items = GH.parse_releases(json.dumps(fx["releases"]).encode())
        self.assertEqual(len(items), len(fx["releases"]) - 1)  # the draft is dropped
        self.assertTrue(all(len(d) == 10 and d[:2] == "20" for _, d, _ in items))
        self.assertEqual(items[0][1], fx["releases"][0]["published_at"][:10])
        self.assertIsNone(GH.parse_releases(b'{"message": "API rate limit exceeded"}'))

    def test_link_count(self):
        # commits list, per_page=1: count = rel="last" page (real header, vllm 2025-01, 10-04 probe: 413 = search total)
        link = ('<https://api.github.com/repositories/599547518/commits?since=2025-01-01T00%3A00%3A00Z&until=2025-01-31T23'
                '%3A59%3A59Z&per_page=1&page=2>; rel="next", <https://api.github.com/repositories/599547518/commits?since='
                '2025-01-01T00%3A00%3A00Z&until=2025-01-31T23%3A59%3A59Z&per_page=1&page=413>; rel="last"')
        self.assertEqual(GH.link_count(link), 413)
        self.assertIsNone(GH.link_count(""))

    def test_search_count(self):
        self.assertEqual(GH.search_count(b'{"total_count": 413, "incomplete_results": false, "items": []}'), 413)
        self.assertIsNone(GH.search_count(b'{"total_count": 413, "incomplete_results": true}'))
        self.assertIsNone(GH.search_count(b'{"message": "rate limit"}'))

    def test_url_roundtrip(self):
        u = GH.commits_url("vllm-project/vllm", 2025, 1)
        self.assertEqual((GH.repo_of(u), GH.month_of(u)), ("vllm-project/vllm", (2025, 1)))
        self.assertEqual(GH.repo_of(GH.releases_url("ollama/ollama", 3)), "ollama/ollama")
        self.assertEqual(GH.page_of(GH.releases_url("ollama/ollama", 3)), 3)
        self.assertEqual(GH.bucket(u), "search")
        self.assertEqual(GH.bucket(GH.stars_url("ollama/ollama")), "core")


class TestExtract(unittest.TestCase):
    def test_releases_complete_only_and_no_partial_year(self):
        store = {}
        rel = lambda i, d: {"id": i, "draft": False, "prerelease": False, "published_at": d + "T00:00:00Z"}
        full = [rel(i, "2024-06-01") for i in range(100)]  # a full page, never followed by a short one → incomplete
        metas = [meta(GH.releases_url("pytorch/pytorch", 1), "2026-10-04T00:00:00Z",
                      [rel(1, "2023-03-01"), rel(2, "2024-03-01"), rel(3, "2024-05-01"), rel(4, "2026-02-01")], store),
                 meta(GH.releases_url("ollama/ollama", 1), "2026-10-04T00:00:00Z", full, store)]
        rows = GH.x_releases(metas, lambda m: store[m["path"]], "2026-10-04")
        by = {p: (v, x) for p, _, v, _, x in rows}
        self.assertEqual(by["2024"], (2, [1, 0, 61]))  # ollama (incomplete) contributes nothing
        self.assertEqual(by["2023"][0], 1)
        self.assertNotIn("2026", by)  # in-progress year never emitted
        self.assertEqual(rows[0][0], "2015")

    def test_releases_union_across_vintages(self):
        store = {}
        rel = lambda i, d: {"id": i, "draft": False, "prerelease": i % 2 == 0, "published_at": d + "T00:00:00Z"}
        metas = [meta(GH.releases_url("pytorch/pytorch", 1), "2026-09-01T00:00:00Z", [rel(1, "2024-01-01")], store),
                 meta(GH.releases_url("pytorch/pytorch", 1), "2026-10-01T00:00:00Z", [rel(2, "2024-02-01"), rel(1, "2024-01-01")], store)]
        rows = GH.x_releases(metas, lambda m: store[m["path"]], "2026-10-04")
        self.assertEqual({p: (v, x[1]) for p, _, v, _, x in rows}["2024"], (2, 1))

    def test_commits_need_every_repo(self):
        store = {}
        metas = [meta(GH.commits_url(r, 2026, 8), "2026-10-04T00:00:00Z", {"total_count": 10, "incomplete_results": False}, store)
                 for r in GH.REPOS]
        metas += [meta(GH.commits_url(r, 2026, 9), "2026-10-04T00:00:00Z", {"total_count": 5, "incomplete_results": False}, store)
                  for r in list(GH.REPOS)[:-1]]  # one repo missing for 2026-09 → month not emitted (no hole summed as 0)
        rows = GH.x_commits(metas, lambda m: store[m["path"]], "2026-10-04", month_end)
        self.assertEqual([(p, v) for p, _, v, _, _ in rows], [("2026-08", 10 * len(GH.REPOS))])

    def test_stars_one_row_per_full_night(self):
        store = {}
        metas = [meta(GH.stars_url(r), "2026-10-04T12:30:00Z", {"stargazers_count": 7}, store) for r in GH.REPOS]
        metas += [meta(GH.stars_url("pytorch/pytorch"), "2026-10-05T12:30:00Z", {"stargazers_count": 9}, store)]
        rows = GH.x_stars(metas, lambda m: store[m["path"]], "2026-10-05")
        self.assertEqual([(p, v) for p, _, v, _, _ in rows], [("2026-10-04", 7 * len(GH.REPOS))])
        self.assertEqual(len(rows[0][4]), len(GH.REPOS))


class TestBudget(unittest.TestCase):
    def test_guard_stops_and_defers(self):
        import wt.fetch as F
        with tempfile.TemporaryDirectory() as tmp:
            for d in ("catalog", "method"):
                os.symlink(Path(__file__).resolve().parent.parent / d, Path(tmp) / d)
            old = {k: os.environ.get(k) for k in ("WT_ROOT", "WT_GH_CORE_BUDGET", "WT_GH_SEARCH_BUDGET")}
            os.environ.update(WT_ROOT=tmp, WT_GH_CORE_BUDGET="5", WT_GH_SEARCH_BUDGET="3")
            calls = []

            def getter(url, log):
                calls.append(url)
                body = b'{"total_count": 1, "incomplete_results": false}' if "/search/" in url else b"[]"
                return {"t": dt.datetime(2026, 10, 4, tzinfo=dt.timezone.utc), "status": 200, "body": body,
                        "final_url": url, "ctype": "application/json"}
            try:
                F.fetch(["github"], getter=getter, sleep=lambda s: None)
            finally:
                for k, v in old.items():
                    os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
            core = [u for u in calls if GH.bucket(u) == "core"]
            search = [u for u in calls if GH.bucket(u) == "search"]
            self.assertEqual((len(core), len(search)), (5, 3))
            self.assertTrue(all(u == GH.stars_url(r) for u, r in zip(core, GH.REPOS)))  # stars first (priority order)
            self.assertIn(F.wiki_end().strftime("%Y-%m-01"), search[0])  # newest complete month first
            calls2 = list(calls)
            calls.clear()
            os.environ.update(WT_ROOT=tmp, WT_GH_CORE_BUDGET="5", WT_GH_SEARCH_BUDGET="3")
            try:
                F.fetch(["github"], getter=getter, sleep=lambda s: None)
            finally:
                for k, v in old.items():
                    os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
            # next night: the deferred months are reached (stored ones are not re-listed beyond the newest-month re-check)
            self.assertTrue(any(u not in calls2 for u in calls if GH.bucket(u) == "search"))


if __name__ == "__main__":
    unittest.main()
