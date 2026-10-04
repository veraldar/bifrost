"""Fetcher: core series → raw/<source>/<slug>/<ts>.<ext> + sidecar + fetch-log (schema.md §1–§3.4)."""
import datetime as dt
import json
import sys
import calendar
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import github as GH
from .common import FETCHER, MONTHLY_SOURCES, UA, append_csv, month_of_url, load_series, load_sources, rel, root, sha256_bytes, write_json

OWID_Q = "?v=1&csvType=full&useColumnShortNames=true"
TIMEOUT = 30
BACKOFF = [5, 15, 45]
TRIES = 3
BACKFILL_FROM = (2019, 1)
SLEEP = {"arxiv": 6.0, "pubmed": 0.4, "fedreg": 0.5}  # seconds between requests (arXiv: ≥ 6 s, M3-fix-1 — 3 s bursts tripped 429)
REPAIR_SWEEPS = 3  # per-month sources: re-try skipped months after the first pass
PUBMED_QUERY = ('(artificial intelligence[Title/Abstract]) AND (drug discovery[Title/Abstract] OR protein[Title/Abstract] '
                'OR molecular[Title/Abstract] OR battery[Title/Abstract] OR catalyst[Title/Abstract]) '
                'AND ("{y:04d}/{m:02d}/01"[PDAT]:"{y:04d}/{m:02d}/{last:02d}"[PDAT])')
ARI_URL = "https://dweeb-xzys-mac-studio.tail5435b1.ts.net/api/artifact/report-ari.html"  # tailnet; .jsonl is 415 there
LOG_HEADER = ["attempted_at", "url", "http_status", "bytes", "sha256", "stored", "error"]


def utcnow():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp(t):
    return t.strftime("%Y%m%dT%H%M%SZ")


def wiki_end(today=None):
    """Last day of the previous month (complete monthly buckets only)."""
    today = today or utcnow().date()
    return today.replace(day=1) - dt.timedelta(days=1)


def owid_value_col(extract):
    return dict(kv.split("=", 1) for kv in extract.split(":", 1)[1].split(";") if "=" in kv)["col"]


def month_url(src, y, m):
    last = calendar.monthrange(y, m)[1]
    if src == "arxiv":
        return ("xml", "https://export.arxiv.org/api/query?search_query=cat:cs.AI+AND+submittedDate:"
                f"[{y:04d}{m:02d}010000+TO+{y:04d}{m:02d}{last:02d}2359]&max_results=1")  # max_results=0 → HTTP 500, http → 301 (10-04); count = totalResults
    if src == "pubmed":
        q = urllib.parse.quote(PUBMED_QUERY.format(y=y, m=m, last=last))
        return ("json", f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&rettype=count&term={q}")
    if src == "fedreg":
        return ("json", "https://www.federalregister.gov/api/v1/documents.json?conditions[term]=%22artificial+intelligence%22"
                f"&conditions[publication_date][gte]={y:04d}-{m:02d}-01&conditions[publication_date][lte]={y:04d}-{m:02d}-{last:02d}"
                "&per_page=1&fields[]=publication_date")
    raise SystemExit(f"no monthly fetcher for source {src}")


def month_window(src, slug, today=None):
    """(newest stored month − 1) … last complete month; nothing stored → BACKFILL_FROM. Months from sidecar urls.
    Plus any month since BACKFILL_FROM with no stored file (a failed fetch is retried next run, never left a hole)."""
    end = wiki_end(today)
    d = root() / "raw" / src / slug
    have = [month_of_url(src, json.loads(sc.read_text())["url"]) for sc in d.glob("*.prov.json")] if d.exists() else []
    have = {x for x in have if x}
    lo = BACKFILL_FROM
    if have:
        y, m = max(have)
        lo = (y, m - 1) if m > 1 else (y - 1, 12)
    out = []
    y, m = BACKFILL_FROM
    while (y, m) <= (end.year, end.month):
        if (y, m) >= lo or (y, m) not in have:
            out.append((y, m))
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)
    return out


def units():
    """One fetch unit per (source, slug): the raw files it produces and its value column."""
    end = wiki_end().strftime("%Y%m%d")
    out = {}
    for sid, s in load_series().items():
        if s["stage"] == "m3":
            continue
        src, slug = s["source_id"], s["slug"]
        key = (src, slug)
        if key in out:
            continue
        if src == "owid":
            base = f"https://ourworldindata.org/grapher/{slug}"
            out[key] = {"files": [("csv", base + ".csv" + OWID_Q), ("metadata.json", base + ".metadata.json" + OWID_Q)],
                        "col": owid_value_col(s["extract"])}
        elif src == "worldbank" and s["extract"].startswith("wb_geo"):
            out[key] = {"files": [("json", f"https://api.worldbank.org/v2/country/all/indicator/{slug}?format=json&per_page=25000")]}
        elif src == "worldbank":
            out[key] = {"files": [("json", f"https://api.worldbank.org/v2/country/WLD/indicator/{slug}?format=json&per_page=100")]}
        elif src == "unsdg":
            out[key] = {"files": [("json", f"https://unstats.un.org/sdgapi/v1/sdg/Series/Data?seriesCode={slug}&pageSize=20000")]}
        elif src == "who_gho":
            out[key] = {"files": [("json", f"https://ghoapi.azureedge.net/api/{slug}")]}
        elif src == "ne":
            out[key] = {"files": [("geojson", "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson")]}
        elif src == "epoch":
            out[key] = {"files": [("csv", "https://epoch.ai/data/notable_ai_models.csv")]}
        elif src == "wikimedia":
            api = "https://wikimedia.org/api/rest_v1/metrics/pageviews"
            if slug == "_aggregate":
                url = f"{api}/aggregate/en.wikipedia/all-access/user/monthly/2015070100/{end}00"
            else:
                url = f"{api}/per-article/en.wikipedia/all-access/user/{slug}/monthly/20150701/{end}"
            out[key] = {"files": [("json", url)]}
        elif src in MONTHLY_SOURCES:
            out[key] = {"files": [month_url(src, y, m) for y, m in month_window(src, slug)], "per_url": True}
        elif src == "github":  # keyless budget: priority-ordered files, the nightly guard in fetch() stops at the tail
            out[key] = {"files": GH.unit_files(slug, root() / "raw" / src / slug, wiki_end()), "per_url": True, "github": True}
        elif src == "ari":  # rebuilt daily on the Mac Studio; the embedded <script id="ari-data"> block is the contract
            out[key] = {"files": [("html", ARI_URL)]}
        elif src == "noaa_gml":
            out[key] = {"files": [("csv", "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv")]}
        else:
            raise SystemExit(f"no fetcher for source {src}")
    return out


def get(url, log_path):
    """GET with UA, timeout, retries; every attempt is logged. Returns (status, body, final_url, ctype) or None."""
    for attempt in range(TRIES):
        t = utcnow()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                body = r.read()
                return {"t": t, "status": r.status, "body": body, "final_url": r.geturl(),
                        "ctype": (r.headers.get("Content-Type") or "").split(";")[0].strip()}
        except urllib.error.HTTPError as e:
            status, err = e.code, f"HTTP {e.code}"
        except Exception as e:  # network/timeout
            status, err = 0, f"{type(e).__name__}: {e}"[:200]
        append_csv(log_path, LOG_HEADER, [iso(t), url, status, 0, "", 0, err])
        if status in (403, 422, 429) and url.startswith("https://api.github.com/"):
            break  # keyless rate limit / bad query: retrying only burns the bucket
        if attempt < TRIES - 1:
            time.sleep(BACKOFF[attempt])
    return None


def newest_sha(slug_dir: Path, ext: str, url=None):
    """sha256 of the newest stored file of this kind (from its sidecar); per-month sources dedupe per url."""
    files = sorted(p for p in slug_dir.glob("*.prov.json") if p.name.split(".", 1)[1] == f"{ext}.prov.json")
    metas = [json.loads(p.read_text()) for p in files]
    if url is not None:
        metas = [x for x in metas if x["url"] == url]
    if not metas:
        return None
    return max(metas, key=lambda x: (x["retrieved_at"], x["path"]))["sha256"]


GH_ORDER = {"stars": 0, "releases": 1, "commits": 2}  # snapshot first: a missed night is a missing star point forever
GH_SLEEP = {"core": 1.0, "search": 6.5}  # keyless search: 10 req/min


def gh_budget():
    """Requests per nightly fetch per GitHub bucket (env override only for a supervised one-off backfill)."""
    return {"core": int(os.environ.get("WT_GH_CORE_BUDGET", GH.CORE_BUDGET)),
            "search": int(os.environ.get("WT_GH_SEARCH_BUDGET", GH.SEARCH_BUDGET))}


def fetch(sources=None, getter=None, sleep=time.sleep):
    getter = getter or get
    srcmeta = load_sources()
    failed = 0
    left = gh_budget()
    deferred = {"core": 0, "search": 0}
    order = lambda kv: (kv[0][0], GH_ORDER.get(kv[0][1], 0) if kv[0][0] == "github" else 0, kv[0][1])
    for (src, slug), u in sorted(units().items(), key=order):
        if sources and src not in sources:
            continue
        d = root() / "raw" / src / slug
        d.mkdir(parents=True, exist_ok=True)
        log = d / "fetch-log.csv"
        got, todo, n = [], list(u["files"]), 0
        for sweep in range(1 + (REPAIR_SWEEPS if u.get("per_url") else 0)):
            skipped = []
            for ext, url in todo:
                if u.get("github"):
                    b = GH.bucket(url)
                    if left[b] <= 0:  # budget guard: the rest is retried next night (never holed: window re-lists it)
                        deferred[b] += 1
                        continue
                    left[b] -= 1
                    if n:
                        sleep(GH_SLEEP[b])
                elif n and src in SLEEP:
                    sleep(SLEEP[src])
                n += 1
                r = getter(url, log)
                if r is None:
                    if u.get("github"):  # keyless 403/429 = bucket exhausted: stop it for tonight, no retry storm
                        left[GH.bucket(url)] = 0
                        deferred[GH.bucket(url)] += 1
                        print(f"fetch DEFER github/{slug} {url} (bucket {GH.bucket(url)} stopped)", file=sys.stderr)
                        continue
                    skipped.append((ext, url))
                    print(f"fetch {'SKIP' if u.get('per_url') else 'FAIL'} {src}/{slug} {url}", file=sys.stderr)
                    continue
                r["url"], r["ext"] = url, ext
                got.append(r)
                if u.get("per_url"):  # store as we go: a long backfill never loses finished months
                    store(src, slug, d, log, u, srcmeta, [r])
            todo = skipped
            if not todo:
                break
            if u.get("per_url"):
                print(f"fetch {src}/{slug}: {len(todo)} months skipped after sweep {sweep}", file=sys.stderr)
        failed += len(todo)
        if u.get("per_url") or not got:
            continue
        store(src, slug, d, log, u, srcmeta, got)
    if any(deferred.values()):
        print(f"fetch github: budget used core {gh_budget()['core'] - left['core']}, search {gh_budget()['search'] - left['search']};"
              f" deferred to next night: core {deferred['core']}, search {deferred['search']}", file=sys.stderr)
    return 1 if failed else 0


def store(src, slug, d, log, u, srcmeta, got):
    """Write each response not already stored (dedupe by sha256 vs newest of its kind / url) + sidecar + log line."""
    by_ext = {r["ext"]: r for r in got}
    # upstream dates + attribution
    upd = nxt = None
    attribution = srcmeta[src]["attribution"]
    if src == "owid" and "metadata.json" in by_ext:
        meta = json.loads(by_ext["metadata.json"]["body"])
        col = meta.get("columns", {}).get(u["col"], {})
        attribution = col.get("citationShort") or attribution
        upd, nxt = col.get("lastUpdated"), col.get("nextUpdate")
    if src == "worldbank" and "json" in by_ext:
        try:
            upd = json.loads(by_ext["json"]["body"])[0].get("lastupdated")
        except Exception:
            pass
    extra = {}
    if src == "ari" and "html" in by_ext:
        from .extract import ari_methodology
        extra = ari_methodology(by_ext["html"]["body"], ARI_URL)
        upd = extra.get("report_generated")
    for r in got:
        ext = r["ext"]
        body, sha = r["body"], sha256_bytes(r["body"])
        stored = sha != newest_sha(d, ext, r["url"] if u.get("per_url") else None)
        if stored:
            ts = stamp(r["t"])
            p = d / f"{ts}.{ext}"
            n = 1
            while p.exists():  # same-second collision: never overwrite raw
                p = d / f"{ts}-{n}.{ext}"; n += 1
            p.write_bytes(body)
            write_json(Path(str(p) + ".prov.json"), {
                "schema": "worldtree.prov/1",
                "path": rel(p),
                "source_id": src,
                "slug": slug,
                "url": r["url"],
                "final_url": r["final_url"],
                "request_headers": {"User-Agent": UA},
                "retrieved_at": iso(r["t"]),
                "http_status": r["status"],
                "content_type": r["ctype"],
                "bytes": len(body),
                "stored_bytes": True,
                "sha256": sha,
                "license": srcmeta[src]["license"],
                "license_url": srcmeta[src]["license_url"],
                "attribution": attribution,
                "upstream_updated": upd,
                "upstream_next_update": nxt,
                "fetcher": FETCHER,
                **extra,
            })
        append_csv(log, LOG_HEADER, [iso(r["t"]), r["url"], r["status"], len(body), sha, int(stored), ""])
        print(f"{'stored' if stored else 'same  '} {src}/{slug} .{ext} {len(body)} B")
