"""Fetcher: core series → raw/<source>/<slug>/<ts>.<ext> + sidecar + fetch-log (schema.md §1–§3.4)."""
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from .common import FETCHER, UA, append_csv, load_series, load_sources, rel, root, sha256_bytes, write_json

OWID_Q = "?v=1&csvType=full&useColumnShortNames=true"
TIMEOUT = 30
BACKOFF = [5, 15, 45]
TRIES = 3
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
        elif src == "worldbank":
            out[key] = {"files": [("json", f"https://api.worldbank.org/v2/country/WLD/indicator/{slug}?format=json&per_page=100")]}
        elif src == "epoch":
            out[key] = {"files": [("csv", "https://epoch.ai/data/notable_ai_models.csv")]}
        elif src == "wikimedia":
            api = "https://wikimedia.org/api/rest_v1/metrics/pageviews"
            if slug == "_aggregate":
                url = f"{api}/aggregate/en.wikipedia/all-access/user/monthly/2015070100/{end}00"
            else:
                url = f"{api}/per-article/en.wikipedia/all-access/user/{slug}/monthly/20150701/{end}"
            out[key] = {"files": [("json", url)]}
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
        if attempt < TRIES - 1:
            time.sleep(BACKOFF[attempt])
    return None


def newest_sha(slug_dir: Path, ext: str):
    """sha256 of the newest stored file of this kind (from its sidecar)."""
    files = sorted(p for p in slug_dir.glob("*.prov.json") if p.name.split(".", 1)[1] == f"{ext}.prov.json")
    if not files:
        return None
    return json.loads(files[-1].read_text())["sha256"]


def fetch(sources=None):
    srcmeta = load_sources()
    failed = 0
    for (src, slug), u in sorted(units().items()):
        if sources and src not in sources:
            continue
        d = root() / "raw" / src / slug
        d.mkdir(parents=True, exist_ok=True)
        log = d / "fetch-log.csv"
        got = {}
        for ext, url in u["files"]:
            r = get(url, log)
            if r is None:
                failed += 1
                print(f"fetch FAIL {src}/{slug} {url}", file=sys.stderr)
                continue
            r["url"] = url
            got[ext] = r
        if not got:
            continue
        # upstream dates + attribution
        upd = nxt = None
        attribution = srcmeta[src]["attribution"]
        if src == "owid" and "metadata.json" in got:
            meta = json.loads(got["metadata.json"]["body"])
            col = meta.get("columns", {}).get(u["col"], {})
            attribution = col.get("citationShort") or attribution
            upd, nxt = col.get("lastUpdated"), col.get("nextUpdate")
        if src == "worldbank" and "json" in got:
            try:
                upd = json.loads(got["json"]["body"])[0].get("lastupdated")
            except Exception:
                pass
        for ext, r in got.items():
            body, sha = r["body"], sha256_bytes(r["body"])
            stored = sha != newest_sha(d, ext)
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
                })
            append_csv(log, LOG_HEADER, [iso(r["t"]), r["url"], r["status"], len(body), sha, int(stored), ""])
            print(f"{'stored' if stored else 'same  '} {src}/{slug} .{ext} {len(body)} B")
    return 1 if failed else 0
