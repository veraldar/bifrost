"""raw → series/<series_id>.csv (prediction.md §1.1, schema.md §3.3). Deterministic."""
import calendar
import csv
import datetime as dt
import io
import json
import math
from collections import defaultdict

from .common import csv_text, load_series, root, sha256_file, write_text

HEADER = ["period", "date", "value", "snapshot_sha256"]


def month_end(y, m):
    return dt.date(y, m, calendar.monthrange(y, m)[1])


def add_months(y, m, k):
    i = y * 12 + (m - 1) + k
    return i // 12, i % 12 + 1


def fmt(v):
    """Deterministic number text: integral → int, else shortest repr (6 dp max for derived)."""
    v = float(v)
    if v == int(v) and abs(v) < 1e15:
        return str(int(v))
    return repr(v)


def num(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def parse_extract(e):
    kind, _, rest = e.partition(":")
    opts = {}
    for kv in filter(None, rest.split(";")):
        if "=" in kv:
            k, v = kv.split("=", 1)
            opts[k] = v
        else:
            opts[kv] = True
    return kind, opts


def snapshot(source_id, slug, ext, as_of):
    """Newest stored raw file of this kind retrieved on/before as_of → (path, sidecar dict)."""
    d = root() / "raw" / source_id / slug
    best = None
    for sc in sorted(d.glob("*.prov.json")):
        if sc.name.split(".", 1)[1] != f"{ext}.prov.json":
            continue
        meta = json.loads(sc.read_text())
        if meta["retrieved_at"][:10] <= as_of:
            best = meta
    if best is None:
        raise FileNotFoundError(f"no {ext} snapshot for {source_id}/{slug} on/before {as_of}")
    return root() / best["path"], best


def read_rows(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def ext_of(s):
    return {"owid": "csv", "worldbank": "json", "epoch": "csv", "wikimedia": "json"}[s["source_id"]]


# --- extractors: return list of (period, date, value) -------------------------------------------

def x_owid(s, path, opts):
    rows = read_rows(path)
    col = opts["col"]
    out = []
    if "runmax" in opts:
        pts = sorted((r["day"], num(r.get(col))) for r in rows if num(r.get(col)) is not None)
        if not pts:
            return []
        first = dt.date.fromisoformat(pts[0][0])
        last = dt.date.fromisoformat(pts[-1][0])
        y, m = first.year, first.month
        while (y, m) <= (last.year, last.month):
            me = month_end(y, m).isoformat()
            vals = [v for d, v in pts if d <= me]
            out.append((f"{y:04d}-{m:02d}", me, max(vals)))
            y, m = add_months(y, m, 1)
        return out
    ent = opts["entity"]
    for r in rows:
        if r["entity"] != ent:
            continue
        v = num(r.get(col))
        if v is None:
            continue
        if s["cadence"] == "annual":
            out.append((r["year"], f"{int(r['year']):04d}-12-31", v))
        else:  # daily
            out.append((r["day"], r["day"], v))
    return out


def x_wb(s, path, opts):
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for r in data[1] or []:
        v = num(r.get("value"))
        if v is None:
            continue
        out.append((r["date"], f"{int(r['date']):04d}-12-31", v))
    return out


def x_wiki(s, path, opts):
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for it in data.get("items", []):
        ts = it["timestamp"]
        y, m = int(ts[0:4]), int(ts[4:6])
        out.append((f"{y:04d}-{m:02d}", month_end(y, m).isoformat(), float(it["views"])))
    return out


def _pubdate(s):
    try:
        return dt.date.fromisoformat((s or "").strip()[:10])
    except ValueError:
        return None


def _split(field):
    return [x.strip() for x in (field or "").split(",") if x.strip()]


def _diversity(models, col):
    share = defaultdict(float)
    for r in models:
        parts = _split(r[col])
        for p in parts:
            share[p] += 1.0 / len(parts)
    tot = sum(share.values())
    if not tot:
        return None
    return 1.0 - sum((v / tot) ** 2 for v in share.values())


def x_epoch(s, path, opts):
    deriv = next(iter(opts))
    models = []
    for r in read_rows(path):
        d = _pubdate(r.get("Publication date"))
        if d:
            models.append((d, r))
    models.sort(key=lambda x: x[0])
    last = models[-1][0]
    out = []
    y, m = 2015, 1
    while (y, m) <= (last.year, last.month):
        me = month_end(y, m)
        py, pm = add_months(y, m, -12)
        lo = month_end(py, pm)
        win = [r for d, r in models if lo < d <= me]
        v = None
        if deriv == "open_share":
            acc = [r["Model accessibility"].strip() for r in win if r["Model accessibility"].strip()]
            if len(acc) >= 20:
                v = 100.0 * sum(a.startswith("Open weights") for a in acc) / len(acc)
        elif deriv in ("org_diversity", "country_diversity"):
            if len(win) >= 20:
                v = _diversity(win, "Organization" if deriv == "org_diversity" else "Country (of organization)")
        elif deriv == "frontier_compute":
            c = [num(r["Training compute (FLOP)"]) for r in win]
            c = [x for x in c if x is not None and x > 0]
            if len(c) >= 5:
                v = math.log10(max(c))
        else:
            raise ValueError(f"unknown epoch derivation {deriv}")
        if v is not None:
            out.append((f"{y:04d}-{m:02d}", me.isoformat(), round(v, 6)))
        y, m = add_months(y, m, 1)
    return out


EXTRACTORS = {"owid": x_owid, "wb": x_wb, "wiki": x_wiki, "epoch": x_epoch}


def build(s, as_of):
    kind, opts = parse_extract(s["extract"])
    path, meta = snapshot(s["source_id"], s["slug"], ext_of(s), as_of)
    rows = [r for r in EXTRACTORS[kind](s, path, opts) if r[1] <= as_of]
    rows.sort(key=lambda r: (r[1], r[0]))
    return [(p, d, fmt(v), meta["sha256"]) for p, d, v in rows]


def build_all(as_of):
    dt.date.fromisoformat(as_of)
    n = 0
    for sid, s in sorted(load_series().items()):
        if s["stage"] != "core":
            continue
        rows = build(s, as_of)
        write_text(root() / "series" / f"{sid}.csv", csv_text(HEADER, rows))
        n += 1
    print(f"series OK {n} files as of {as_of}")
    return n
