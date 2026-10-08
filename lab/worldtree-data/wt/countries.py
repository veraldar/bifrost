"""Country panel (method 0.4.0, expansion-ceiling.md §3): cross-sectional percentiles -> out/countries.json.

World tree percentages (wt run/history) are UNCHANGED — this file only adds per-country realm
scores. Discipline: every country number = weighted mean of cross-sectional percentile ranks of
mapping_geo.csv indicators; each indicator traces series/<id>.csv -> snapshot sha256 -> raw ->
source URL+license (provenance block). Deterministic; no lookahead (rows dated > as_of dropped).

Cadence rule: annual geo series; a country's indicator counts if its latest value at/before
as_of is at most STALE_YEARS old (older = missing, coverage reflects it — never interpolated).

Per-capita rule (method 0.6.0, M8): a mapping_geo row with `percap=<series>` ranks value ÷ that series (population)
for the same country and year — the nearest population year within STALE_YEARS if that exact year is missing (none ⇒
the country lacks the indicator). Absolute totals (patents, high-tech exports, solar/nuclear TWh, terrorism and
disaster deaths) otherwise rank countries by size: before 0.6.0 China, Germany and the US topped "transcendence" on
export volume alone.
"""
import datetime as dt
import hashlib
import json

from .common import REALMS, load_mapping_geo, load_series, method_version, parse_params, read_csv, root, sha256_file, write_json
from .gitops import commit_run

SCHEMA = "worldtree.countries/1"
STALE_YEARS = 7


def _iso_rows():
    import csv
    p = root() / "catalog" / "iso_map.csv"
    with open(p, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _mapping_sha():
    p = root() / "catalog" / "mapping_geo.csv"
    return sha256_file(p) if p.exists() else None


def load_panel(as_of, series_meta):
    """{series_id: {iso3: (year, value, snapshot_sha)}} — latest value within the staleness window."""
    panel = {}
    y_max = int(as_of[:4])
    for sid in {r["series_id"] for r in load_mapping_geo()}:
        p = root() / "series" / f"{sid}.csv"
        if not p.exists():
            continue
        import csv
        best = {}
        with open(p, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                y = int(r["date"][:4])
                if f"{y:04d}-12-31" > as_of or y_max - y > STALE_YEARS:
                    continue
                k = r["geo"]
                if k not in best or y > best[k][0] or (y == best[k][0] and float(r["value"]) > best[k][1]):
                    best[k] = (y, float(r["value"]), r["snapshot_sha256"])
        if best:
            panel[sid] = best
    return panel


def load_per(sid, as_of):
    """{iso3: {year: value}} of a per-capita denominator series, rows dated ≤ as_of (no lookahead)."""
    out = {}
    p = root() / "series" / f"{sid}.csv"
    for r in read_csv(p) if p.exists() else []:
        y = int(r["date"][:4])
        if f"{y:04d}-12-31" <= as_of and float(r["value"]) > 0:
            out.setdefault(r["geo"], {})[y] = float(r["value"])
    return out


def per_at(per, iso, y):
    """Denominator for (country, year): that year, else the nearest year within STALE_YEARS (ties → earlier)."""
    ys = per.get(iso) or {}
    if y in ys:
        return ys[y]
    near = sorted((abs(x - y), x) for x in ys if abs(x - y) <= STALE_YEARS)
    return ys[near[0][1]] if near else None


def percentile_ranks(values):
    """{key: rank/(n-1)} 0..1, average ranks for ties; single-value -> 1.0 (but coverage counts it)."""
    n = len(values)
    out = {}
    if n == 1:
        return {next(iter(values)): 1.0}
    order = sorted(values.values())
    for k, v in values.items():
        less = sum(1 for x in order if x < v)
        same = sum(1 for x in order if x == v)
        out[k] = (less + (same - 1) / 2) / (n - 1)
    return out


def score(as_of):
    series_meta = load_series()
    mrows = load_mapping_geo()
    panel = load_panel(as_of, series_meta)
    by_realm = {r: [] for r in REALMS}
    ind_meta = {}
    pers = {}
    for m in mrows:
        sid = m["series_id"]
        if sid not in panel:
            continue
        per_sid = parse_params(m["params"]).get("percap")
        if per_sid:
            per = pers.setdefault(per_sid, load_per(per_sid, as_of))
            vals = {}
            for iso, (y, v, sha) in panel[sid].items():
                d = per_at(per, iso, y)
                if d:
                    vals[iso] = v / d
        else:
            vals = {iso: v for iso, (y, v, sha) in panel[sid].items()}
        ranks = percentile_ranks(vals)
        direction = 1 if m["direction"] == "+1" else -1
        applied = {k: ranks[k] if direction > 0 else 1.0 - ranks[k] for k in ranks}
        by_realm[m["realm"]].append((sid, int(m["weight"]), applied))
        snaps = {sha for (_, _, sha) in panel[sid].values()}
        s = series_meta[sid]
        ind_meta.setdefault(sid, {
            "label": s["label"], "source_id": s["source_id"], "license": None, "n_countries": len(vals),
            "year_max": max(y for y, _, _ in panel[sid].values()), "snapshot_sha256": sorted(snaps)[-1],
            **({"per_capita": per_sid} if per_sid else {}),
        })
    realms_out, n_prov = {}, 0
    for realm in REALMS:
        rows = by_realm[realm]
        w_total = sum(w for _, w, _ in rows)
        countries = {}
        if w_total:
            isos = {k for _, _, a in rows for k in a}
            for iso in isos:
                w_have = p_sum = 0.0
                n_ind = 0
                for sid, w, applied in rows:
                    if iso in applied:
                        w_have += w
                        p_sum += w * applied[iso]
                        n_ind += 1
                cov = w_have / w_total
                score = 100.0 * p_sum / w_have if w_have else None
                prov = cov < 0.5
                n_prov += int(bool(prov))
                countries[iso] = {
                    "score": round(score, 1) if score is not None else None,
                    "coverage": round(cov, 3), "provisional": prov, "n_indicators": n_ind,
                }
        realms_out[realm] = {"w_map": w_total, "n_indicators": len(rows),
                             "n_countries": sum(1 for c in countries.values() if c["score"] is not None),
                             "countries": countries}
    return realms_out, ind_meta, n_prov


def main(as_of, now=None, no_commit=False):
    dt.date.fromisoformat(as_of)
    realms_out, ind_meta, n_prov = score(as_of)
    srcmap = json.loads((root() / "catalog" / "sources.json").read_text(encoding="utf-8"))
    for sid, m in ind_meta.items():
        src = srcmap.get(m["source_id"], {})
        m["license"] = src.get("license")
        m["source_url"] = (src.get("homepage", "").rstrip("/") + "/" + load_series()[sid]["slug"]) if src.get("homepage") else src.get("homepage")
    out = {
        "schema": SCHEMA,
        "method_version": method_version(),
        "as_of": as_of,
        "now": now,
        "stale_years": STALE_YEARS,
        "names": {r["iso3"]: r["name"] for r in _iso_rows()},
        "note": ("Per-country realm levels 0-100 = weighted cross-sectional percentile of mapping_geo.csv "
                 "indicators (country vs all reporting countries, latest value within stale_years; no lookahead; "
                 "provisional where indicator coverage < 0.5). Absolute totals are ranked per person (indicators[].per_capita, "
                 "method 0.6.0). None of these indicators measures AI: they are the conditions each future would land "
                 "in, country by country, as levels — not directions. World tree percentages are computed separately "
                 "(realms.json). Every indicator: series/<id>.csv -> snapshot_sha256 -> raw/<...> -> source URL."),
        "provenance": {
            "mapping_geo_sha256": _mapping_sha(),
            "series_dir": "series/ (published under /data/)",
            "sources_url": "https://veraldar.org/data/DATA.md",
        },
        "indicators": dict(sorted(ind_meta.items())),
        "n_provisional": n_prov,
        "realms": {r: realms_out[r] for r in REALMS},
    }
    p = root() / "out" / "countries.json"
    write_json(p, out)
    total = sum(len(r["countries"]) for r in realms_out.values())
    print(f"countries OK {p.name}: {len(ind_meta)} indicators, {total} country×realm scores, {n_prov} provisional")
    if not no_commit:
        commit_run(f"countries {as_of}", True, "")
    return 0
