"""Catalog gate (prediction.md §5.1)."""
from collections import defaultdict

from .common import REALMS, load_mapping, load_series, load_sources, parse_params

TRANSFORMS = {"rank_delta", "rank_level", "logistic_delta"}
GEO_TRANSFORMS = {"rank_geo"}
DIMENSIONS = {"tech", "geopolitics", "economy", "environment", "society"}
CADENCES = {"annual", "monthly", "weekly", "daily"}
STAGES = {"core", "m3", "candidate"}


def check():
    """Return (errors, n_series, n_rows, n_geo_rows)."""
    errs = []
    try:
        series, mapping, sources = load_series(), load_mapping(), load_sources()
    except Exception as e:  # unreadable catalog is a failure, not a crash
        return [f"catalog unreadable: {e}"], 0, 0, 0
    from .common import load_mapping_geo
    mapping_geo = load_mapping_geo()
    for sid, s in series.items():
        if s["source_id"] not in sources:
            errs.append(f"series {sid}: unknown source {s['source_id']}")
        if s["cadence"] not in CADENCES:
            errs.append(f"series {sid}: bad cadence {s['cadence']}")
        if s["stage"] not in STAGES:
            errs.append(f"series {sid}: bad stage {s['stage']}")
        if not s["max_age_days"].isdigit():
            errs.append(f"series {sid}: bad max_age_days")
    realms_of = defaultdict(set)
    for i, r in enumerate(mapping, 2):
        where = f"mapping.csv line {i}"
        if r["realm"] not in REALMS:
            errs.append(f"{where}: unknown realm {r['realm']!r}")
        if r["series_id"] not in series:
            errs.append(f"{where}: unknown series {r['series_id']!r}")
        if r["direction"] not in ("+1", "-1"):
            errs.append(f"{where}: direction must be +1|-1")
        if r["weight"] not in ("1", "2", "3"):
            errs.append(f"{where}: weight must be 1|2|3")
        if r["transform"] not in TRANSFORMS:
            errs.append(f"{where}: unknown transform {r['transform']!r}")
        if r["transform"] == "logistic_delta" and r["weight"] != "1":
            errs.append(f"{where}: logistic_delta requires weight 1")
        if r["dimension"] not in DIMENSIONS:
            errs.append(f"{where}: unknown dimension {r['dimension']!r}")
        try:
            params = parse_params(r["params"])
        except ValueError:
            errs.append(f"{where}: bad params {r['params']!r}")
            params = {}
        if params.get("unborn", "drop") != "drop":
            errs.append(f"{where}: unborn must be 'drop'")
        if r["realm"] in realms_of[r["series_id"]]:
            errs.append(f"{where}: duplicate {r['realm']}/{r['series_id']}")
        realms_of[r["series_id"]].add(r["realm"])
    for i, r in enumerate(mapping_geo, 2):
        where = f"mapping_geo.csv line {i}"
        if r["realm"] not in REALMS:
            errs.append(f"{where}: unknown realm {r['realm']!r}")
        if r["series_id"] not in series:
            errs.append(f"{where}: unknown series {r['series_id']!r}")
        if r["direction"] not in ("+1", "-1"):
            errs.append(f"{where}: direction must be +1|-1")
        if r["weight"] not in ("1", "2", "3"):
            errs.append(f"{where}: weight must be 1|2|3")
        if r["transform"] not in GEO_TRANSFORMS:
            errs.append(f"{where}: geo rows use transform rank_geo (got {r['transform']!r})")
        if r["dimension"] not in DIMENSIONS:
            errs.append(f"{where}: unknown dimension {r['dimension']!r}")
        realms_of[r["series_id"]].add(r["realm"])
    for sid, rs in realms_of.items():
        if len(rs) > 2:
            errs.append(f"series {sid}: mapped to {len(rs)} realms (max 2)")
    return errs, len(series), len(mapping), len(mapping_geo)
