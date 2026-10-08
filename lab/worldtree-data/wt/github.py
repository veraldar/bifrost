"""GitHub as a source (method 0.4.1): AI-ecosystem evolution speed — releases/year, commits/month, star snapshots.

Keyless only (60 core req/h + 10 search req/min per IP): no token, ever ([account-required] honest limit).
- releases: GET /repos/{r}/releases?per_page=100&page=N — page 1 nightly, deeper pages once until a short page
  (< 100 items) proves the history complete. Releases are the union by release id over every stored page.
- commits:  GET /search/commits?q=repo:{r}+committer-date:{month}&per_page=1 — `total_count` in the body
  (search bucket, not the 60/h core bucket). Cross-checked against the commits-list Link-header method
  (per_page=1 → rel="last" page = count): vllm-project/vllm 2025-01 = 413 both (10-04 probe).
- stars:    GET /repos/{r} — stargazers_count, one snapshot per night (growth observed since 2026-10 only).
Method 0.5.0 (M10, the tool ecosystem co-evolving with the models) — same buckets, same guard:
- tool_repos: GET /search/repositories?q=topic:{t}+created:{month}&per_page=1 — new repos per month per AI-tool topic.
- lean_repos: GET /search/repositories?q=language:Lean+created:{month}&per_page=1 — new formal-math (Lean) repos per month.
- mathlib:    GET /search/commits?q=repo:leanprover-community/mathlib4+committer-date:{month} — formal-math library velocity.
- tool_stars: GET /repos/{r} — nightly stargazers_count of the tool layer (MCP, agent frameworks, tool-use benchmarks).
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
# --- method 0.5.0 (M10): the tools evolve with the models — "anyone is building new tools for AI" -------------------
# topics: one search request per topic-month (keyless search has no OR across topics → the value is the SUM, a repo
# carrying two tracked topics counts twice — probe 2025-06: 175 repos carry both mcp and llm vs 1,082 mcp, 1,931 llm)
TOOL_TOPICS = {
    "llm": "repos built on or around large language models — the broadest 'building with models' tag",
    "ai-agents": "agents: models given tools, memory and a loop",
    "mcp": "Model Context Protocol servers/clients — the open plug between any model and any tool (since 2024-11; "
           "before that the tag means other things, Minecraft Coder Pack, microcontrollers — a small baseline)",
    "ai-tools": "tools made for AI use or with AI, self-described",
}
LEAN = "language:Lean"  # formal mathematics + proof engineering: the medium AI provers work in (AlphaProof-era signal)
MATHLIB = "leanprover-community/mathlib4"  # the formal-math library every Lean prover is checked against
# tool layer, nightly stars only (no history: growth observed since 2026-10, never world-mapped) — one reason line each
TOOL_REPOS = {
    "modelcontextprotocol/servers": "MCP reference servers — the protocol that lets any model use any tool",
    "modelcontextprotocol/python-sdk": "MCP Python SDK — what tool builders import",
    "modelcontextprotocol/typescript-sdk": "MCP TypeScript SDK — what tool builders import",
    "modelcontextprotocol/registry": "the official MCP server registry",
    "langchain-ai/langgraph": "agent orchestration as graphs",
    "run-llama/llama_index": "data/retrieval tooling for LLM apps",
    "crewAIInc/crewAI": "multi-agent framework",
    "microsoft/autogen": "multi-agent conversation framework (Microsoft Research)",
    "openai/openai-agents-python": "OpenAI's agent SDK (successor of swarm)",
    "huggingface/smolagents": "agents that act by writing code",
    "browser-use/browser-use": "the web browser as a tool for models",
    "ShishirPatil/gorilla": "Berkeley Function-Calling Leaderboard (BFCL) — the tool-use benchmark",
    "sierra-research/tau2-bench": "τ²-bench — agents using tools with a user in the loop",
    "SWE-bench/SWE-bench": "SWE-bench — agents using a developer's tools on real issues",
    MATHLIB: "mathlib4 — formal mathematics as a tool AI provers stand on",
}
_SEARCH_RE = re.compile(r"repo:([^ +&]+)\+committer-date:(\d{4})-(\d{2})-01\.\.")
_CREATED_RE = re.compile(r"[?&]q=([^&]+?)\+created:(\d{4})-(\d{2})-01\.\.")
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


def repos_url(qual, y, m):
    """New public repos created in month (y, m) matching one search qualifier (topic:…, language:…); forks excluded."""
    last = calendar.monthrange(y, m)[1]
    return f"{API}/search/repositories?q={qual}+created:{y:04d}-{m:02d}-01..{y:04d}-{m:02d}-{last:02d}&per_page=1"


# per-month search counts, one request per key-month (the commits machinery): kind → (keys, url(key, y, m))
COUNTS = {
    "tool_repos": ([f"topic:{t}" for t in TOOL_TOPICS], repos_url),
    "lean_repos": ([LEAN], repos_url),
    "mathlib": ([MATHLIB], commits_url),
}


def count_key(url):
    """(key, (y, m)) of a per-month search-count url (repos created / commits), else None."""
    u = urllib.parse.unquote(url)
    m = _CREATED_RE.search(u) or _SEARCH_RE.search(u)
    return (m.group(1), (int(m.group(2)), int(m.group(3)))) if m else None


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
    if kind == "tool_stars":
        return [("json", stars_url(r)) for r in TOOL_REPOS]
    if kind in COUNTS:  # the commits rule, any key set: missing months newest first, then the last complete month re-checked
        keys, url = COUNTS[kind]
        stored = defaultdict(set)
        for u in have:
            k = count_key(u)
            if k:
                stored[k[0]].add(k[1])
        missing = [("json", url(k, y, m)) for y, m in reversed(list(_months(end))) for k in keys if (y, m) not in stored[k]]
        recheck = [("json", url(k, end.year, end.month)) for k in keys if (end.year, end.month) in stored[k]]
        return missing + recheck
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


def x_stars(metas, read, as_of, repos=REPOS):
    """One row per retrieval night on which every repo was snapshotted: value = Σ stars, meta = per-repo stars."""
    nights = defaultdict(dict)
    for m in sorted(metas, key=lambda m: (m["retrieved_at"], m["path"])):
        r = repo_of(m["url"])
        if r not in repos or m["retrieved_at"][:10] > as_of:
            continue
        try:
            v = json.loads(read(m))["stargazers_count"]
        except (ValueError, KeyError, TypeError):
            continue
        nights[m["retrieved_at"][:10]][r] = (v, m)
    out = []
    for d, by in sorted(nights.items()):
        if set(by) != set(repos):
            continue
        sha = max((x[1] for x in by.values()), key=lambda x: (x["retrieved_at"], x["path"]))["sha256"]
        out.append((d, d, sum(v for v, _ in by.values()), sha, [by[r][0] for r in repos]))
    return out


def month_counts(metas, read, keys):
    """{(key, (y, m)): (count, sidecar)} — newest parseable snapshot per (key, month)."""
    out = {}
    for m in sorted(metas, key=lambda m: (m["retrieved_at"], m["path"])):
        k = count_key(m["url"])
        if not k or k[0] not in keys:
            continue
        v = search_count(read(m))
        if v is not None:
            out[k] = (v, m)
    return out


def x_month_counts(metas, read, as_of, month_end, keys, per_key=False):
    """One row per month in which EVERY key has a count (no hole summed as zero): value = Σ counts over the keys;
    meta = the per-key counts (per_key) in key order."""
    c = month_counts(metas, read, keys)
    out = []
    for y, m in sorted({ym for _, ym in c}):
        if not all((k, (y, m)) in c for k in keys):
            continue
        me = month_end(y, m).isoformat()
        if me > as_of:
            continue
        ms = [c[(k, (y, m))][1] for k in keys]
        sha = max(ms, key=lambda x: (x["retrieved_at"], x["path"]))["sha256"]
        vals = [c[(k, (y, m))][0] for k in keys]
        out.append((f"{y:04d}-{m:02d}", me, sum(vals), sha, vals if per_key else []))
    return out


STARS_META = [f"stars_{slug(r)}" for r in REPOS]
RELEASES_META = ["n_repos", "n_prerelease", "median_gap_days"]
COMMITS_META = ["n_repos"]
TOOL_STARS_META = [f"stars_{slug(r)}" for r in TOOL_REPOS]
TOOL_REPOS_META = [f"topic_{t.replace('-', '_')}" for t in TOOL_TOPICS]
META = {"releases": RELEASES_META, "commits": COMMITS_META, "stars": STARS_META, "tool_stars": TOOL_STARS_META,
        "tool_repos": TOOL_REPOS_META, "lean_repos": [], "mathlib": []}


def rows_of(what, metas, read, as_of, month_end):
    """github:<what> → rows (period, date, value, sha256, [meta…]); every raw file passed in was retrieved ≤ as_of."""
    if what == "releases":
        return x_releases(metas, read, as_of)
    if what == "commits":
        return x_commits(metas, read, as_of, month_end)
    if what == "stars":
        return x_stars(metas, read, as_of)
    if what == "tool_stars":
        return x_stars(metas, read, as_of, TOOL_REPOS)
    if what in COUNTS:
        return x_month_counts(metas, read, as_of, month_end, COUNTS[what][0], per_key=what == "tool_repos")
    raise ValueError(f"unknown github extract {what}")


FILE = "github-trends.json"
PROV_FILE = "github-trends.provenance.json"


TOOLS_SERIES = ["series/github.tool_repos_month.csv", "series/github.lean_repos_month.csv",
                "series/github.mathlib_commits_month.csv", "series/github.tool_stars_snapshot.csv"]


def tools_block(as_of, metas_of, read, month_end):
    """github-trends.json `tools` (method 0.5.0, M10): the tool ecosystem beside the model-side curves → (block, used
    sidecars). Months appear only once every key of the month has a count; years are summed from those months
    (`months` < 12 = the year in progress or a backfill still filling)."""
    def upto(kind):
        return [m for m in metas_of(kind) if m["retrieved_at"][:10] <= as_of]
    tr, lr, mr, ts = upto("tool_repos"), upto("lean_repos"), upto("mathlib"), upto("tool_stars")
    keys = COUNTS["tool_repos"][0]
    trow = x_month_counts(tr, read, as_of, month_end, keys, per_key=True)
    lrow = x_month_counts(lr, read, as_of, month_end, COUNTS["lean_repos"][0])
    mrow = x_month_counts(mr, read, as_of, month_end, COUNTS["mathlib"][0])
    srow = x_stars(ts, read, as_of, TOOL_REPOS)
    used = ([v[1] for v in month_counts(tr, read, keys).values()]
            + [v[1] for v in month_counts(lr, read, COUNTS["lean_repos"][0]).values()]
            + [v[1] for v in month_counts(mr, read, COUNTS["mathlib"][0]).values()] + ts)
    topics = list(TOOL_TOPICS)
    by_month = [{"month": p, "repos": int(v), "by_topic": dict(zip(topics, map(int, meta)))} for p, _, v, _, meta in trow]
    years = {}
    for r in by_month:
        y = years.setdefault(int(r["month"][:4]), {"year": int(r["month"][:4]), "repos": 0, "months": 0,
                                                    "by_topic": {t: 0 for t in topics}})
        y["repos"] += r["repos"]
        y["months"] += 1
        for t in topics:
            y["by_topic"][t] += r["by_topic"][t]
    return {
        "topics": [{"topic": t, "why": TOOL_TOPICS[t], "query": f"topic:{t} created:<month>"} for t in topics],
        "tool_repos_by_month": by_month,
        "tool_repos_by_year": [years[y] for y in sorted(years)],
        "lean_repos_by_month": [{"month": p, "repos": int(v)} for p, _, v, _, _ in lrow],
        "mathlib_commits_by_month": [{"month": p, "commits": int(v)} for p, _, v, _, _ in mrow],
        "repos": [{"repo": r, "why": TOOL_REPOS[r]} for r in TOOL_REPOS],
        "stars": dict(zip(TOOL_REPOS, srow[-1][4])) if srow else {},
        "stars_by_night": [{"date": p, "total": int(v)} for p, _, v, _, _ in srow],
        "notes": [
            "Tool repos a month: new public repositories (forks excluded) created that month carrying the topic — "
            "keyless search total_count, one request per topic-month since 2019-01. The value sums four topics (llm, "
            "ai-agents, mcp, ai-tools); search has no OR across topics, so a repo tagged with two of them counts twice "
            "(probe 2025-06: 175 repos carry both mcp and llm, against 1,082 mcp and 1,931 llm).",
            "Bias B16 (self-tagged topics): owners add topics when they like, so the counts are what GitHub returns at "
            "retrieval — each month is fetched once and the last complete month re-checked nightly; older months have "
            "had longer to be tagged (this understates growth), deleted repos drop out of every month. topic:mcp means "
            "Model Context Protocol from 2024-11; before that it is other things (a small baseline, 14 repos in 2023-06).",
            "Lean repos a month: repositories whose primary language GitHub detects as Lean, created that month — "
            "formal mathematics and proof engineering, the medium AI provers work in.",
            "mathlib commits a month: leanprover-community/mathlib4 default-branch commits by committer date (search "
            "total_count). Its 2023 peak is the mathlib3 → mathlib4 port, so it is drawn as velocity and not mapped.",
            "Tool stars: nightly stargazers_count of the tool layer (MCP servers + SDKs + registry, agent frameworks, "
            "tool-use benchmarks, mathlib4) — growth observed since 2026-10 only, so not mapped.",
        ],
    }, used


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
    tools, tools_used = tools_block(as_of, metas_of, read, month_end)
    used = (rel_used + [v[1] for v in cc.values()] + [m for m in sm if m["retrieved_at"][:10] <= as_of]
            + tools_used)
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
        "tools": tools,
        "provenance": {
            "source": "api.github.com (keyless: 60 core req/h + 10 search req/min)",
            "license": "GitHub ToS — counts are facts; metadata via public API",
            "series": ["series/github.releases_year.csv", "series/github.commits_month.csv",
                       "series/github.stars_snapshot.csv"] + TOOLS_SERIES,
            "raw_files": len(used),
            "file": PROV_FILE,  # every raw file read (path, sha256, url, retrieved_at); sha256 filled by the writer
        },
    }, {"schema": "worldtree.github.provenance/1", "as_of": as_of,
        "files": sorted(({"path": m["path"], "sha256": m["sha256"], "url": m["url"], "retrieved_at": m["retrieved_at"]}
                         for m in used), key=lambda x: x["path"])}
