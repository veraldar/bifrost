"""GitHub as a source (method 0.4.1): AI-ecosystem evolution speed — releases/year, commits/month, star snapshots.

Keyless only (60 core req/h + 10 search req/min per IP): no token, ever ([account-required] honest limit).
- releases: GET /repos/{r}/releases?per_page=100&page=N — page 1 nightly, deeper pages once until a short page
  (< 100 items) proves the history complete. Releases are the union by release id over every stored page.
- commits:  GET /search/commits?q=repo:{r}+committer-date:{month}&per_page=1 — `total_count` in the body
  (search bucket, not the 60/h core bucket). Cross-checked against the commits-list Link-header method
  (per_page=1 → rel="last" page = count): vllm-project/vllm 2025-01 = 413 both (10-04 probe).
- stars:    GET /repos/{r} — stargazers_count, one snapshot per night (growth observed since 2026-10 only).
"""
import calendar
import datetime as dt
import json
import re
import statistics
import urllib.parse
from collections import defaultdict

API = "https://api.github.com"
# ~12 repos, one reason line each (survivorship bias B15: these are 2026's winners, picked in 2026)
REPOS = {
    "tensorflow/tensorflow": "first-wave deep-learning framework — carries the 2015-2019 depth",
    "pytorch/pytorch": "the training substrate of nearly every frontier and open model since 2017",
    "jax-ml/jax": "Google DeepMind's research/training stack (Gemini, AlphaFold lineage)",
    "huggingface/transformers": "every new open architecture lands here — the model-zoo pulse",
    "vllm-project/vllm": "open-weights inference serving (2023+)",
    "ollama/ollama": "local model runtime — open weights reaching end users (2023+)",
    "ggml-org/llama.cpp": "CPU/edge inference of open weights (2023+)",
    "openai/openai-python": "OpenAI's API SDK — frontier-lab shipping cadence",
    "anthropics/anthropic-sdk-python": "Anthropic's API SDK — frontier-lab shipping cadence",
    "meta-llama/llama-models": "Meta's open-weights model releases",
    "QwenLM/Qwen3": "Alibaba Qwen open-weights line — the non-US frontier",
    "langchain-ai/langchain": "agent/application layer on top of the models",
}
# releases that are not a release cadence: excluded from releases/year (commits + stars kept)
RELEASES_SKIP = {
    "ggml-org/llama.cpp": "one GitHub release per CI build (tag b####, thousands) — not a release cadence",
    "langchain-ai/langchain": "monorepo: one release per package version (langchain-core, -openai, …) — thousands",
}
PAGE = 100
RELEASES_REFRESH_DAYS = 28  # page 1 re-fetched monthly: pages are 0.3-3.4 MB (asset download counts change nightly),
# and releases/year only ever emits complete years — monthly freshness is plenty
MAX_PAGES = 5  # deeper history not fetched: a repo with > 500 releases never proves complete → excluded, disclosed
CORE_BUDGET = 45  # core requests per nightly fetch (60/h keyless, shared by everything on this IP)
SEARCH_BUDGET = 150  # search requests per nightly fetch (10/min keyless → SLEEP 6.5 s)
COMMITS_FROM = (2019, 1)  # same backfill start as arxiv/pubmed/fedreg
FIRST_YEAR = 2015
_SEARCH_RE = re.compile(r"repo:([^ +&]+)\+committer-date:(\d{4})-(\d{2})-01\.\.")
_REPO_RE = re.compile(r"/repos/([^/]+/[^/?]+)")
_PAGE_RE = re.compile(r"[?&]page=(\d+)")
_LAST_RE = re.compile(r'<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"')


def slug(repo):
    return repo.replace("/", "__")


def stars_url(repo):
    return f"{API}/repos/{repo}"


def releases_url(repo, page):
    return f"{API}/repos/{repo}/releases?per_page={PAGE}&page={page}"


def commits_url(repo, y, m):
    last = calendar.monthrange(y, m)[1]
    return f"{API}/search/commits?q=repo:{repo}+committer-date:{y:04d}-{m:02d}-01..{y:04d}-{m:02d}-{last:02d}&per_page=1"


def repo_of(url):
    u = urllib.parse.unquote(url)
    m = _SEARCH_RE.search(u)
    if m:
        return m.group(1)
    m = _REPO_RE.search(u)
    return m.group(1) if m else None


def month_of(url):
    m = _SEARCH_RE.search(urllib.parse.unquote(url))
    return (int(m.group(2)), int(m.group(3))) if m else None


def page_of(url):
    m = _PAGE_RE.search(url)
    return int(m.group(1)) if m else 1


def link_count(link):
    """Commits-list Link header with per_page=1 → count = rel="last" page number; no Link → None (0 or 1 items)."""
    m = _LAST_RE.search(link or "")
    return int(m.group(1)) if m else None


def search_count(body: bytes):
    """Search response → total_count; None if unparseable or GitHub flags incomplete_results."""
    try:
        d = json.loads(body)
        v = d["total_count"]
    except (ValueError, KeyError, TypeError):
        return None
    if d.get("incomplete_results") or not isinstance(v, int) or v < 0:
        return None
    return v


def parse_releases(body: bytes):
    """Release-list page → [(id, published_at date, prerelease)] (drafts are never public); None if unparseable."""
    try:
        d = json.loads(body)
    except ValueError:
        return None
    if not isinstance(d, list):
        return None
    out = []
    for r in d:
        p = r.get("published_at") or r.get("created_at")
        if r.get("draft") or not p:
            continue
        out.append((r["id"], p[:10], bool(r.get("prerelease"))))
    return out


def page_len(body: bytes):
    try:
        d = json.loads(body)
    except ValueError:
        return None
    return len(d) if isinstance(d, list) else None


# --- fetch side ---------------------------------------------------------------------------------

def _have(slug_dir):
    """Sidecar urls already stored (any vintage) → {url: [sidecar]}."""
    out = defaultdict(list)
    if slug_dir.exists():
        for sc in slug_dir.glob("*.prov.json"):
            m = json.loads(sc.read_text())
            out[m["url"]].append(m)
    return out


def _months(end):
    y, m = COMMITS_FROM
    while (y, m) <= (end.year, end.month):
        yield y, m
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)


def unit_files(kind, d, end):
    """Files for one github unit, in priority order (the nightly budget guard stops at the tail; the rest is retried
    next night). commits: every month since COMMITS_FROM with no stored file, newest first so whole months complete
    across repos, then the last complete month re-checked (late pushes) with whatever budget is left. releases: page 1 when its newest copy is ≥ 28 days old; deeper
    pages only while no stored page proved the end (< 100 items)."""
    have = _have(d)
    if kind == "stars":
        return [("json", stars_url(r)) for r in REPOS]
    if kind == "releases":
        out = []
        for r in REPOS:
            if r in RELEASES_SKIP:
                continue
            p1 = have.get(releases_url(r, 1))
            today = dt.datetime.now(dt.timezone.utc).date()
            if not p1 or (today - dt.date.fromisoformat(max(m["retrieved_at"] for m in p1)[:10])).days >= RELEASES_REFRESH_DAYS:
                out.append(("json", releases_url(r, 1)))
            done = False
            for p in range(1, MAX_PAGES + 1):
                metas = have.get(releases_url(r, p))
                if not metas:
                    break
                newest = max(metas, key=lambda x: (x["retrieved_at"], x["path"]))
                n = page_len((d / newest["path"].rsplit("/", 1)[1]).read_bytes())
                if n is not None and n < PAGE:
                    done = True
                    break
            if not done and releases_url(r, 1) in have:  # page 1 unseen → its length unknown, no blind deep page
                for p in range(2, MAX_PAGES + 1):
                    u = releases_url(r, p)
                    if u not in have:
                        out.append(("json", u))
                        break  # one new deep page per repo per night: pages shift as releases arrive
        return out
    if kind == "commits":
        stored = {}
        for url in have:
            r, ym = repo_of(url), month_of(url)
            if r and ym:
                stored.setdefault(r, set()).add(ym)
        missing = [("json", commits_url(r, y, m)) for y, m in reversed(list(_months(end))) for r in REPOS
                   if (y, m) not in stored.get(r, set())]
        recheck = [("json", commits_url(r, end.year, end.month)) for r in REPOS
                   if (end.year, end.month) in stored.get(r, set())]  # late pushes; last, so it never starves a backfill
        return missing + recheck
    raise SystemExit(f"no github unit {kind}")


def bucket(url):
    return "search" if "/search/" in url else "core"


# --- extract side -------------------------------------------------------------------------------

def _newest_by_url(metas):
    best = {}
    for m in metas:
        if m["url"] not in best or (m["retrieved_at"], m["path"]) > (best[m["url"]]["retrieved_at"], best[m["url"]]["path"]):
            best[m["url"]] = m
    return best


def release_history(metas, read):
    """→ ({repo: {id: (date, pre)}}, {repo: complete?}, used sidecars). Union by id over every stored page;
    a repo counts only if some stored page had < 100 items (history reaches its first release)."""
    rel, complete, used = defaultdict(dict), defaultdict(bool), []
    for m in sorted(metas, key=lambda m: (m["retrieved_at"], m["path"])):  # newer snapshot overwrites
        r = repo_of(m["url"])
        if r not in REPOS or r in RELEASES_SKIP:
            continue
        body = read(m)
        items = parse_releases(body)
        if items is None:
            continue
        used.append(m)
        if len(json.loads(body)) < PAGE:
            complete[r] = True
        for i, d, pre in items:
            rel[r][i] = (d, pre)
    return rel, complete, used


def x_releases(metas, read, as_of):
    """Per complete year: (period, date, value, sha, [n_repos, n_prerelease, median_gap_days]) — summed over the
    repos whose history is proven complete; the in-progress year is never emitted (its Dec-31 is after as_of)."""
    rel, complete, used = release_history(metas, read)
    if not used:
        return []
    sha = max(used, key=lambda m: (m["retrieved_at"], m["path"]))["sha256"]
    years = defaultdict(list)
    for r, items in rel.items():
        if not complete[r]:
            continue
        ds = sorted(d for d, _ in items.values())
        pre = {d: 0 for d in ds}
        for d, p in items.values():
            pre[d] += p
        for d in ds:
            years[int(d[:4])].append((r, d, pre[d]))
    out = []
    last = max(years) if years else FIRST_YEAR
    for y in range(FIRST_YEAR, last + 1):
        date = f"{y}-12-31"
        if date > as_of:
            break
        rows = years.get(y, [])
        by = defaultdict(list)
        for r, d, _ in rows:
            by[r].append(dt.date.fromisoformat(d))
        gaps = [(b - a).days for ds in by.values() for a, b in zip(sorted(ds), sorted(ds)[1:])]
        n_pre = sum(1 for r in rel if complete[r] for d, p in rel[r].values() if p and d[:4] == str(y))
        med = statistics.median(gaps) if gaps else ""
        out.append((str(y), date, len(rows), sha, [len(by), n_pre, med]))
    return out


def commit_counts(metas, read):
    """{(repo, (y, m)): (count, sidecar)} — newest parseable snapshot per (repo, month)."""
    out = {}
    for m in sorted(metas, key=lambda m: (m["retrieved_at"], m["path"])):
        r, ym = repo_of(m["url"]), month_of(m["url"])
        if r not in REPOS or not ym:
            continue
        v = search_count(read(m))
        if v is not None:
            out[(r, ym)] = (v, m)
    return out


def x_commits(metas, read, as_of, month_end):
    """One row per month in which EVERY tracked repo has a count (no holes summed as zero): value = Σ commits."""
    c = commit_counts(metas, read)
    months = sorted({ym for _, ym in c})
    out = []
    for y, m in months:
        if not all((r, (y, m)) in c for r in REPOS):
            continue
        me = month_end(y, m).isoformat()
        if me > as_of:
            continue
        ms = [c[(r, (y, m))][1] for r in REPOS]
        sha = max(ms, key=lambda x: (x["retrieved_at"], x["path"]))["sha256"]
        out.append((f"{y:04d}-{m:02d}", me, sum(c[(r, (y, m))][0] for r in REPOS), sha, [len(REPOS)]))
    return out


def x_stars(metas, read, as_of):
    """One row per retrieval night on which every repo was snapshotted: value = Σ stars, meta = per-repo stars."""
    nights = defaultdict(dict)
    for m in sorted(metas, key=lambda m: (m["retrieved_at"], m["path"])):
        r = repo_of(m["url"])
        if r not in REPOS or m["retrieved_at"][:10] > as_of:
            continue
        try:
            v = json.loads(read(m))["stargazers_count"]
        except (ValueError, KeyError, TypeError):
            continue
        nights[m["retrieved_at"][:10]][r] = (v, m)
    out = []
    for d, by in sorted(nights.items()):
        if set(by) != set(REPOS):
            continue
        sha = max((x[1] for x in by.values()), key=lambda x: (x["retrieved_at"], x["path"]))["sha256"]
        out.append((d, d, sum(v for v, _ in by.values()), sha, [by[r][0] for r in REPOS]))
    return out


STARS_META = [f"stars_{slug(r)}" for r in REPOS]
RELEASES_META = ["n_repos", "n_prerelease", "median_gap_days"]
COMMITS_META = ["n_repos"]


FILE = "github-trends.json"
PROV_FILE = "github-trends.provenance.json"


def trends(as_of, metas_of, read, month_end, method_version):
    """→ (github-trends.json doc (schema worldtree.github/1): the dashed context lines on the rings chart, provenance doc)."""
    rm, cm, sm = metas_of("releases"), metas_of("commits"), metas_of("stars")
    rel, complete, rel_used = release_history([m for m in rm if m["retrieved_at"][:10] <= as_of], read)
    rows = x_releases([m for m in rm if m["retrieved_at"][:10] <= as_of], read, as_of)
    per_repo = {r: {} for r in rel if complete[r]}
    for r in per_repo:
        for d, _ in rel[r].values():
            if f"{d[:4]}-12-31" <= as_of:
                per_repo[r][d[:4]] = per_repo[r].get(d[:4], 0) + 1
    cc = commit_counts([m for m in cm if m["retrieved_at"][:10] <= as_of], read)
    crow = x_commits([m for m in cm if m["retrieved_at"][:10] <= as_of], read, as_of, month_end)
    srow = x_stars(sm, read, as_of)
    used = rel_used + [v[1] for v in cc.values()] + [m for m in sm if m["retrieved_at"][:10] <= as_of]
    stars = {}
    if srow:
        stars = dict(zip(REPOS, srow[-1][4]))
    months_have = defaultdict(int)
    for r, ym in cc:
        months_have[r] += 1
    return {
        "schema": "worldtree.github/1",
        "as_of": as_of,
        "method_version": method_version,
        "repos": [{"repo": r, "why": REPOS[r],
                   "releases": ("excluded: " + RELEASES_SKIP[r]) if r in RELEASES_SKIP else
                               ("counted" if complete.get(r) else "pending: history not yet proven complete"),
                   "commit_months": months_have.get(r, 0)} for r in REPOS],
        "releases_by_year": [{"year": int(p), "releases": int(v), "repos_releasing": meta[0],
                              "prereleases": meta[1], "median_gap_days": meta[2]} for p, _, v, _, meta in rows],
        "releases_by_repo_year": per_repo,
        "commits_by_month": [{"month": p, "commits": int(v)} for p, _, v, _, _ in crow],
        "stars": stars,
        "stars_by_night": [{"date": p, "total": int(v)} for p, _, v, _, _ in srow],
        "notes": [
            "Releases/year: published (non-draft) GitHub releases of the tracked repos whose full release history "
            "is stored, summed per calendar year; the in-progress year is not shown.",
            "Commits/month: default-branch commits by committer date via the keyless search API (total_count); a month "
            "appears only once every tracked repo has a count.",
            "Stars: nightly stargazers_count snapshots — growth observed since 2026-10 only; star history before that "
            "is not reconstructed (pagination-prohibitive keyless).",
            "Bias B15 (survivorship): the repo set is today's winners, chosen in 2026; repos born after 2019 add to "
            "the totals from their first release — ecosystem growth includes repo births by design.",
        ],
        "provenance": {
            "source": "api.github.com (keyless: 60 core req/h + 10 search req/min)",
            "license": "GitHub ToS — counts are facts; metadata via public API",
            "series": ["series/github.releases_year.csv", "series/github.commits_month.csv",
                       "series/github.stars_snapshot.csv"],
            "raw_files": len(used),
            "file": PROV_FILE,  # every raw file read (path, sha256, url, retrieved_at); sha256 filled by the writer
        },
    }, {"schema": "worldtree.github.provenance/1", "as_of": as_of,
        "files": sorted(({"path": m["path"], "sha256": m["sha256"], "url": m["url"], "retrieved_at": m["retrieved_at"]}
                         for m in used), key=lambda x: x["path"])}
