"""raw → series/<series_id>.csv (prediction.md §1.1, schema.md §3.3). Deterministic."""
import calendar
import csv
import datetime as dt
import io
import json
import math
import re
import xml.etree.ElementTree as ET
from collections import defaultdict

from . import github as GH
from .common import catalog_dir, csv_text, load_series, month_of_url, root, sha256_file, write_text

OPENSEARCH = "{http://a9.com/-/spec/opensearch/1.1/}"

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


def snapshots(source_id, slug, ext, as_of):
    """Every stored raw file of this kind retrieved on/before as_of → [sidecar dict], oldest first."""
    d = root() / "raw" / source_id / slug
    out = []
    for sc in sorted(d.glob("*.prov.json")):
        if sc.name.split(".", 1)[1] != f"{ext}.prov.json":
            continue
        meta = json.loads(sc.read_text())
        if meta["retrieved_at"][:10] <= as_of:
            out.append(meta)
    return sorted(out, key=lambda m: (m["retrieved_at"], m["path"]))


def month_snapshots(source_id, slug, ext, as_of):
    """Per-month count sources: {(y, m): [sidecars, oldest first]}; month from the sidecar url, never the filename."""
    best = {}
    for meta in snapshots(source_id, slug, ext, as_of):
        ym = month_of_url(source_id, meta["url"])
        if ym:
            best.setdefault(ym, []).append(meta)
    return best


def snapshot(source_id, slug, ext, as_of):
    """Newest stored raw file of this kind retrieved on/before as_of → (path, sidecar dict)."""
    metas = snapshots(source_id, slug, ext, as_of)
    best = metas[-1] if metas else None
    if best is None:
        raise FileNotFoundError(f"no {ext} snapshot for {source_id}/{slug} on/before {as_of}")
    return root() / best["path"], best


def read_rows(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def ext_of(s):
    return {"owid": "csv", "worldbank": "json", "epoch": "csv", "wikimedia": "json",
            "arxiv": "xml", "pubmed": "json", "fedreg": "json", "noaa_gml": "csv", "ari": "html",
            "unsdg": "json", "who_gho": "json", "ne": "geojson", "github": "json"}[s["source_id"]]


GEO_KINDS = ("wb_geo", "owid_geo", "unsdg_geo", "who_geo")

# OWID entity names that differ from Natural Earth NAME -> iso3 (checked against catalog/iso_map.csv)
ISO_OVERRIDES = {
    "United States": "USA", "Democratic Republic of Congo": "COD", "Ivory Coast": "CIV",
    "Cote d'Ivoire": "CIV", "Cape Verde": "CPV", "Czechia": "CZE", "Swaziland": "SWZ",
    "North Macedonia": "MKD", "Burma": "MMR", "East Timor": "TLS", "Laos": "LAO",
    "Vietnam": "VNM", "Syria": "SYR", "Moldova": "MDA", "Tanzania": "TZA", "Gambia": "GMB",
    "Bahamas": "BHS", "South Korea": "KOR", "North Korea": "PRK", "Russia": "RUS",
    "Iran": "IRN", "Bolivia": "BOL", "Venezuela": "VEN", "Brunei": "BRN", "Egypt": "EGY",
    "Palestine": "PSE", "Western Sahara": "ESH", "Micronesia (country)": "FSM",
    "Curaçao": "CUW", "Hong Kong": "HKG", "Macao": "MAC",
}

# UN geoAreaName style -> iso3 (UNSDG uses full UN names; NE/OWID use short names)
UN_NAME_OVERRIDES = {
    "Bolivia (Plurinational State of)": "BOL",
    "Democratic Republic of the Congo": "COD",
    "Congo": "COG",
    "Côte d'Ivoire": "CIV",
    "Cabo Verde": "CPV",
    "Czechia": "CZE",
    "Eswatini": "SWZ",
    "Iran (Islamic Republic of)": "IRN",
    "Lao People's Democratic Republic": "LAO",
    "Micronesia (Federated States of)": "FSM",
    "Democratic People's Republic of Korea": "PRK",
    "Republic of Korea": "KOR",
    "Republic of Moldova": "MDA",
    "Russian Federation": "RUS",
    "Syrian Arab Republic": "SYR",
    "United Republic of Tanzania": "TZA",
    "United States of America": "USA",
    "United Kingdom of Great Britain and Northern Ireland": "GBR",
    "Venezuela (Bolivarian Republic of)": "VEN",
    "Viet Nam": "VNM",
    "Brunei Darussalam": "BRN",
    "Central African Republic": "CAF",
    "Equatorial Guinea": "GNQ",
    "Gambia": "GMB",
    "The Gambia": "GMB",
    "Holy See": "VAT",
    "State of Palestine": "PSE",
    "Türkiye": "TUR",
    "United Arab Emirates": "ARE",
    "United States Virgin Islands": "VIR",
    "Myanmar": "MMR",
}


def load_iso_map():
    """catalog/iso_map.csv (built by `wt mapdata` from the Natural Earth snapshot) -> rows."""
    p = catalog_dir() / "iso_map.csv"
    return read_rows(p) if p.exists() else []


def _iso_by_name():
    return {r["name"]: r["iso3"] for r in load_iso_map()}


def x_wb_geo(s, path, opts):
    """World Bank country=all JSON -> (iso3, year, date, value); aggregates drop out via iso_map membership."""
    data = json.loads(path.read_text(encoding="utf-8"))
    valid = {r["iso3"] for r in load_iso_map()}
    out = []
    for r in data[1] or []:
        v = num(r.get("value"))
        iso = (r.get("countryiso3code") or "").strip()
        y = num(r.get("date"))
        if v is None or not y or iso not in valid:
            continue
        out.append((iso, str(int(y)), f"{int(y):04d}-12-31", v))
    return out


def x_owid_geo(s, path, opts):
    col = opts["col"]
    names = _iso_by_name()
    out = []
    for r in read_rows(path):
        v = num(r.get(col))
        iso = ISO_OVERRIDES.get(r["entity"]) or names.get(r["entity"])
        if v is None or not iso:
            continue
        if s["cadence"] == "annual":
            out.append((iso, r["year"], f"{int(r['year']):04d}-12-31", v))
        else:
            out.append((iso, r["day"], r["day"], v))
    return out


def x_unsdg_geo(s, path, opts):
    """UN SDG values JSON (all areas, one request) -> geoAreaName -> iso3 (NE name map + UN-style-name overrides)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    names = _iso_by_name()
    out = []
    for r in data.get("data", []):
        v = num(r.get("value"))
        name = r.get("geoAreaName") or ""
        iso = names.get(name) or UN_NAME_OVERRIDES.get(name)
        y = num(r.get("timePeriodStart"))
        if v is None or not iso or not y:
            continue
        out.append((iso, str(int(y)), f"{int(y):04d}-12-31", v))
    return out


def x_who_geo(s, path, opts):
    data = json.loads(path.read_text(encoding="utf-8"))
    valid = {r["iso3"] for r in load_iso_map()}
    out = []
    for r in data.get("value", []):
        if r.get("SpatialDimType") not in (None, "COUNTRY"):
            continue
        v = num(r.get("NumericValue"))
        iso = (r.get("SpatialDim") or "").strip()
        t = str(r.get("TimeDim") or "")
        if v is None or not iso or iso not in valid or not t[:4].isdigit():
            continue
        out.append((iso, t[:4], f"{int(t[:4]):04d}-12-31", v))
    return out


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


def x_noaa(s, path, opts):
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    out = []
    for r in csv.DictReader(lines):
        v = num((r.get("average") or "").strip())
        if v is None or v < 0:  # −99.99 = missing
            continue
        y, m = int(r["year"]), int(r["month"])
        out.append((f"{y:04d}-{m:02d}", month_end(y, m).isoformat(), v))
    return out


ARI_BLOCK = re.compile(rb'<script id="ari-data" type="application/json">(.*?)</script>', re.S)
ARI_CATS = ("os_restriction", "platform_ban", "datacenter_backlash", "safety_exit", "legal_wall")
ARI_META = ["s", "n", "p"] + [f"pts_{c}" for c in ARI_CATS] + [f"n_{c}" for c in ARI_CATS]


def ari_block(body: bytes):
    """The report's embedded machine contract → dict, or None if the block is missing/unparseable."""
    m = ARI_BLOCK.search(body)
    if not m:
        return None
    try:
        d = json.loads(m.group(1))
    except ValueError:
        return None
    return d if isinstance(d, dict) and isinstance(d.get("weeks"), list) else None


def ari_methodology(body: bytes, url):
    """Sidecar provenance from the report itself: §method anchor, component weights (embedded `cats`), K + freeze date."""
    d = ari_block(body) or {}
    text = re.sub(r"<[^>]+>", " ", body.decode("utf-8", "replace"))
    text = re.sub(r"\s+", " ", text)
    k = re.search(r"K = ([0-9.]+) frozen on (\d{4}-\d\d-\d\d)", text)
    gen = re.search(r"generated (\d{4}-\d\d-\d\dT[0-9:]+(?:\+00:00|Z))", text)
    return {
        "methodology_url": f"{url}#method",
        "methodology": {
            "components": [{"id": c.get("k"), "label": c.get("label"), "weight": c.get("w")} for c in d.get("cats", [])],
            "score": "ARI = 100 × (1 − e^(−S/K)), S = Σ category weight over deduplicated events dated that week (Mon–Sun UTC)",
            "K": float(k.group(1)) if k else None,
            "K_frozen_on": k.group(2) if k else None,
            "calibration": "K fixed so the median week of the calibration window scores 50",
            "trend_test": "Mann-Kendall on complete weeks + OLS slope",
        },
        "report_generated": gen.group(1) if gen else None,
    }


def x_ari(s, path, opts):
    """One row per week: date = week end `we`, value = ari, meta = s, n, p + weighted points (`by`) and event
    counts (`nb`) per component. Rows flagged p (partial week) are left out of the series."""
    d = ari_block(path.read_bytes())
    if d is None:
        raise ValueError(f"{path}: no ari-data block")
    out = []
    for w in d["weeks"]:
        v = num(w.get("ari"))
        if v is None or w.get("p"):
            continue
        by, nb = w.get("by") or {}, w.get("nb") or {}
        meta = [w.get("s"), w.get("n"), int(bool(w.get("p")))] + [by.get(c, 0) for c in ARI_CATS] + [nb.get(c, 0) for c in ARI_CATS]
        out.append((w["we"], w["we"], v, [fmt(x) for x in meta]))
    return out


def parse_count(kind, body: bytes):
    """Count from one per-month response (arxiv Atom XML / pubmed / fedreg JSON); None if unparseable."""
    try:
        if kind == "arxiv":
            el = ET.fromstring(body).find(f"{OPENSEARCH}totalResults")
            v = num(el.text.strip()) if el is not None and el.text else None
        elif kind == "pubmed":
            v = num(json.loads(body)["esearchresult"]["count"])
        elif kind == "fedreg":
            v = num(json.loads(body)["count"])
        else:
            raise ValueError(f"unknown count kind {kind}")
    except (ET.ParseError, ValueError, KeyError, TypeError, AttributeError):
        return None
    return v if v is not None and v >= 0 else None


def x_counts(s, metas_by_month, kind):
    """Newest parseable snapshot per month wins → [(period, date, value, sha256)]."""
    out = []
    for (y, m), metas in sorted(metas_by_month.items()):
        for meta in reversed(metas):  # newest retrieved_at first
            v = parse_count(kind, (root() / meta["path"]).read_bytes())
            if v is not None:
                out.append((f"{y:04d}-{m:02d}", month_end(y, m).isoformat(), v, meta["sha256"]))
                break
    return out


EXTRACTORS = {"owid": x_owid, "wb": x_wb, "wiki": x_wiki, "epoch": x_epoch, "noaa": x_noaa, "ari": x_ari,
              "wb_geo": x_wb_geo, "owid_geo": x_owid_geo, "unsdg_geo": x_unsdg_geo, "who_geo": x_who_geo}
COUNT_KINDS = ("arxiv", "pubmed", "fedreg")


def dedupe_geo(rows):
    """(iso3, period, date, value): same geo+date reported twice (revisions) -> max value; deterministic."""
    best = {}
    for r in rows:
        k = (r[0], r[2])
        if k not in best or r[3] > best[k][3]:
            best[k] = r
    return [best[k] for k in sorted(best)]


def read_raw(meta):
    return (root() / meta["path"]).read_bytes()


def build_github(s, as_of):
    """github:releases|commits|stars (0.4.1) | tool_repos|lean_repos|mathlib|tool_stars (0.5.0) → rows with meta columns
    (wt/github.py); every raw file ≤ as_of is read."""
    what = next(iter(parse_extract(s["extract"])[1]))
    rows = GH.rows_of(what, snapshots("github", s["slug"], "json", as_of), read_raw, as_of, month_end)
    return [(p, d, fmt(v), sha, *[x if x == "" else fmt(x) for x in meta]) for p, d, v, sha, meta in rows]


def build(s, as_of):
    kind, opts = parse_extract(s["extract"])
    if kind == "github":
        return build_github(s, as_of)
    if kind in COUNT_KINDS:
        rows = [r for r in x_counts(s, month_snapshots(s["source_id"], s["slug"], ext_of(s), as_of), kind) if r[1] <= as_of]
        rows.sort(key=lambda r: (r[1], r[0]))
        return [(p, d, fmt(v), sha) for p, d, v, sha in rows]
    if kind in GEO_KINDS:
        path, meta = snapshot(s["source_id"], s["slug"], ext_of(s), as_of)
        rows = [r for r in EXTRACTORS[kind](s, path, opts) if r[2] <= as_of]
        return [(r[0], r[1], r[2], fmt(r[3]), meta["sha256"]) for r in dedupe_geo(rows)]
    path, meta = snapshot(s["source_id"], s["slug"], ext_of(s), as_of)
    rows = [r for r in EXTRACTORS[kind](s, path, opts) if r[1] <= as_of]
    rows.sort(key=lambda r: (r[1], r[0]))
    return [(r[0], r[1], fmt(r[2]), meta["sha256"], *(r[3] if len(r) > 3 else ())) for r in rows]


def header(s):
    kind = parse_extract(s["extract"])[0]
    if kind == "ari":
        return HEADER + ARI_META
    if kind == "github":
        return HEADER + GH.META[next(iter(parse_extract(s["extract"])[1]))]
    if kind in GEO_KINDS:
        return ["geo"] + HEADER
    return HEADER


def build_all(as_of):
    dt.date.fromisoformat(as_of)
    n = 0
    for sid, s in sorted(load_series().items()):
        if s["stage"] != "core":
            continue
        rows = build(s, as_of)
        write_text(root() / "series" / f"{sid}.csv", csv_text(header(s), rows))
        n += 1
    print(f"series OK {n} files as of {as_of}")
    return n
