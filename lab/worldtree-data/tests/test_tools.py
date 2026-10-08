"""Tool ecosystem (method 0.5.0, M10): repo-created / commit search counts, tools block, budget order — no network."""
import datetime as dt
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from wt import github as GH  # noqa: E402
from wt.common import load_series  # noqa: E402
from wt.extract import header  # noqa: E402

FX = Path(__file__).resolve().parent / "fixtures" / "github"
TOPICS = GH.COUNTS["tool_repos"][0]


def month_end(y, m):
    import calendar
    return dt.date(y, m, calendar.monthrange(y, m)[1])


def meta(url, t, body, store):
    p = f"m{len(store)}"
    store[p] = body if isinstance(body, bytes) else json.dumps(body).encode()
    return {"url": url, "retrieved_at": t, "path": p, "sha256": f"{len(store):064x}"}


def cnt(n, inc=False):
    return {"total_count": n, "incomplete_results": inc, "items": []}


class TestParse(unittest.TestCase):
    def test_frozen_search_repos_page(self):
        # real response, 10-08 probe: topic:mcp created 2025-06 → 1,082 repos (one item body, per_page=1)
        body = (FX / "search-repos-mcp-2025-06.json").read_bytes()
        self.assertEqual(GH.search_count(body), 1082)
        self.assertEqual(len(json.loads(body)["items"]), 1)

    def test_url_roundtrip(self):
        u = GH.repos_url("topic:ai-agents", 2024, 2)
        self.assertTrue(u.endswith("q=topic:ai-agents+created:2024-02-01..2024-02-29&per_page=1"), u)  # leap year
        self.assertEqual(GH.count_key(u), ("topic:ai-agents", (2024, 2)))
        self.assertEqual(GH.count_key(GH.repos_url(GH.LEAN, 2019, 1)), ("language:Lean", (2019, 1)))
        self.assertEqual(GH.count_key(GH.commits_url(GH.MATHLIB, 2023, 6)), (GH.MATHLIB, (2023, 6)))
        self.assertIsNone(GH.count_key(GH.stars_url(GH.MATHLIB)))
        self.assertEqual(GH.bucket(u), "search")
        self.assertIsNone(GH.repo_of(u))  # never mistaken for a tracked repo by the 0.4.1 extractors

    def test_catalog_and_headers(self):
        s = load_series()
        self.assertEqual(header(s["github.tool_repos_month"])[4:], ["topic_llm", "topic_ai_agents", "topic_mcp",
                                                                    "topic_ai_tools"])
        self.assertEqual(header(s["github.lean_repos_month"]), ["period", "date", "value", "snapshot_sha256"])
        self.assertEqual(len(header(s["github.tool_stars_snapshot"])), 4 + len(GH.TOOL_REPOS))
        self.assertFalse(set(GH.TOOL_REPOS) & (set(GH.REPOS) - {GH.MATHLIB}))  # the tool layer is not the model stack


class TestExtract(unittest.TestCase):
    def test_every_topic_needed_and_sum_with_per_topic_meta(self):
        store = {}
        metas = [meta(GH.repos_url(k, 2026, 8), "2026-10-08T12:00:00Z", cnt(10 * (i + 1)), store)
                 for i, k in enumerate(TOPICS)]
        metas += [meta(GH.repos_url(k, 2026, 9), "2026-10-08T12:00:00Z", cnt(5), store) for k in TOPICS[:-1]]
        rows = GH.x_month_counts(metas, lambda m: store[m["path"]], "2026-10-08", month_end, TOPICS, per_key=True)
        self.assertEqual([(p, d, v, x) for p, d, v, _, x in rows], [("2026-08", "2026-08-31", 100, [10, 20, 30, 40])])

    def test_newest_parseable_wins_and_month_end_cut(self):
        store = {}
        u = GH.repos_url(GH.LEAN, 2026, 9)
        metas = [meta(u, "2026-10-01T12:00:00Z", cnt(800), store),
                 meta(u, "2026-10-02T12:00:00Z", cnt(846), store),
                 meta(u, "2026-10-03T12:00:00Z", cnt(900, inc=True), store),  # incomplete_results → never read
                 meta(u, "2026-10-04T12:00:00Z", b'{"message": "API rate limit exceeded"}', store)]
        keys = GH.COUNTS["lean_repos"][0]
        rows = GH.x_month_counts(metas, lambda m: store[m["path"]], "2026-10-08", month_end, keys)
        self.assertEqual([(p, v, x) for p, _, v, _, x in rows], [("2026-09", 846, [])])
        self.assertEqual(GH.x_month_counts(metas, lambda m: store[m["path"]], "2026-09-29", month_end, keys), [])

    def test_unit_files_newest_first_then_recheck(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            end = dt.date(2026, 9, 30)
            files = GH.unit_files("tool_repos", d, end)
            self.assertEqual(len(files), len(TOPICS) * len(list(GH._months(end))))
            self.assertEqual([GH.count_key(u) for _, u in files[:4]], [(k, (2026, 9)) for k in TOPICS])
            # store 2026-09 for every topic → it leaves the missing list and comes back last as the re-check
            for i, (_, u) in enumerate(files[:4]):
                (d / f"f{i}.json").write_text("{}")
                (d / f"f{i}.json.prov.json").write_text(json.dumps({"url": u}))
            again = GH.unit_files("tool_repos", d, end)
            self.assertEqual([GH.count_key(u) for _, u in again[:4]], [(k, (2026, 8)) for k in TOPICS])
            self.assertEqual([GH.count_key(u) for _, u in again[-4:]], [(k, (2026, 9)) for k in TOPICS])
            self.assertEqual(GH.unit_files("tool_stars", d, end), [("json", GH.stars_url(r)) for r in GH.TOOL_REPOS])

    def test_tools_block_years_and_provenance_files(self):
        store, metas = {}, {"tool_repos": [], "lean_repos": [], "mathlib": [], "tool_stars": []}
        for y, m, n in ((2025, 11, 1), (2025, 12, 2), (2026, 1, 3)):
            metas["tool_repos"] += [meta(GH.repos_url(k, y, m), "2026-10-08T12:00:00Z", cnt(n), store) for k in TOPICS]
        metas["lean_repos"].append(meta(GH.repos_url(GH.LEAN, 2026, 1), "2026-10-08T12:00:00Z", cnt(7), store))
        metas["mathlib"].append(meta(GH.commits_url(GH.MATHLIB, 2026, 1), "2026-10-08T12:00:00Z", cnt(889), store))
        metas["tool_stars"] += [meta(GH.stars_url(r), "2026-10-08T12:30:00Z", {"stargazers_count": 2}, store)
                                for r in GH.TOOL_REPOS]
        b, used = GH.tools_block("2026-10-08", lambda k: metas[k], lambda m: store[m["path"]], month_end)
        self.assertEqual([(y["year"], y["repos"], y["months"]) for y in b["tool_repos_by_year"]],
                         [(2025, 12, 2), (2026, 12, 1)])
        self.assertEqual(b["tool_repos_by_year"][0]["by_topic"], {t: 3 for t in GH.TOOL_TOPICS})
        self.assertEqual(b["lean_repos_by_month"], [{"month": "2026-01", "repos": 7}])
        self.assertEqual(b["mathlib_commits_by_month"], [{"month": "2026-01", "commits": 889}])
        self.assertEqual(sum(b["stars"].values()), 2 * len(GH.TOOL_REPOS))
        self.assertEqual(len(used), 3 * len(TOPICS) + 2 + len(GH.TOOL_REPOS))  # every raw file read is cited


class TestBudgetOrder(unittest.TestCase):
    def test_tool_stars_follow_stars_and_counts_follow_commits(self):
        import wt.fetch as F
        with tempfile.TemporaryDirectory() as tmp:
            for d in ("catalog", "method"):
                os.symlink(Path(__file__).resolve().parent.parent / d, Path(tmp) / d)
            core_n, search_n = len(GH.REPOS) + len(GH.TOOL_REPOS), len(GH.REPOS) + 6
            old = {k: os.environ.get(k) for k in ("WT_ROOT", "WT_GH_CORE_BUDGET", "WT_GH_SEARCH_BUDGET")}
            os.environ.update(WT_ROOT=tmp, WT_GH_CORE_BUDGET=str(core_n), WT_GH_SEARCH_BUDGET=str(search_n))
            calls = []

            def getter(url, log):
                calls.append(url)
                body = b'{"total_count": 1, "incomplete_results": false}' if "/search/" in url else b"[]"
                return {"t": dt.datetime(2026, 10, 8, tzinfo=dt.timezone.utc), "status": 200, "body": body,
                        "final_url": url, "ctype": "application/json"}
            try:
                F.fetch(["github"], getter=getter, sleep=lambda s: None)
            finally:
                for k, v in old.items():
                    os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
            core = [u for u in calls if GH.bucket(u) == "core"]
            search = [u for u in calls if GH.bucket(u) == "search"]
            self.assertEqual(core, [GH.stars_url(r) for r in GH.REPOS] + [GH.stars_url(r) for r in GH.TOOL_REPOS])
            self.assertEqual(len(search), search_n)
            self.assertTrue(all(GH.count_key(u)[0] in GH.REPOS for u in search))  # empty tree: the 0.4.1 backfill first
            # unit priority inside the shared buckets: snapshots, releases, commits, then the mapped tool counts first
            slugs = sorted((s for s in GH.META), key=lambda s: (F.GH_ORDER[s], s))
            self.assertEqual(slugs, ["stars", "tool_stars", "releases", "commits", "tool_repos", "lean_repos", "mathlib"])

    def test_search_wall_clock_cap(self):
        """10-08: two full search budgets in one nightly overran the unit's 1800 s — the search bucket stops at the cap."""
        import wt.fetch as F
        with tempfile.TemporaryDirectory() as tmp:
            for d in ("catalog", "method"):
                os.symlink(Path(__file__).resolve().parent.parent / d, Path(tmp) / d)
            keys = ("WT_ROOT", "WT_GH_CORE_BUDGET", "WT_GH_SEARCH_BUDGET", "WT_GH_SEARCH_WALL")
            old = {k: os.environ.get(k) for k in keys}
            os.environ.update(WT_ROOT=tmp, WT_GH_CORE_BUDGET="0", WT_GH_SEARCH_BUDGET="150", WT_GH_SEARCH_WALL="250")
            calls, t = [], iter(range(0, 10 ** 6, 100))  # every clock read is 100 s later

            def getter(url, log):
                calls.append(url)
                return {"t": dt.datetime(2026, 10, 8, tzinfo=dt.timezone.utc), "status": 200,
                        "body": b'{"total_count": 1, "incomplete_results": false}', "final_url": url,
                        "ctype": "application/json"}
            try:
                F.fetch(["github"], getter=getter, sleep=lambda s: None, clock=lambda: next(t))
            finally:
                for k, v in old.items():
                    os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
            self.assertEqual(len(calls), 3)  # t0 = 0, then 100 and 200 pass, 300 > 250 defers the rest
            self.assertEqual(F.GH_SEARCH_WALL, 480)


if __name__ == "__main__":
    unittest.main()
