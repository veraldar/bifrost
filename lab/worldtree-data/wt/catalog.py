"""Catalog gate (prediction.md §5.1)."""
from collections import defaultdict

from .common import REALMS, load_mapping, load_series, load_sources, parse_params

TRANSFORMS = {"rank_delta", "rank_level", "logistic_delta"}
DIMENSIONS = {"tech", "geopolitics", "economy", "environment", "society"}
CADENCES = {"annual", "monthly", "weekly", "daily"}
STAGES = {"core", "m3", "candidate"}


def check():
    """Return (errors, n_series, n_rows)."""
    errs = []
    try:
        series, mapping, sources = load_series(), load_mapping(), load_sources()
    except Exception as e:  # unreadable catalog is a failure, not a crash
        return [f"catalog unreadable: {e}"], 0, 0
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
            parse_params(r["params"])
        except ValueError:
            errs.append(f"{where}: bad params {r['params']!r}")
        if r["realm"] in realms_of[r["series_id"]]:
            errs.append(f"{where}: duplicate {r['realm']}/{r['series_id']}")
        realms_of[r["series_id"]].add(r["realm"])
    for sid, rs in realms_of.items():
        if len(rs) > 2:
            errs.append(f"series {sid}: mapped to {len(rs)} realms (max 2)")
    return errs, len(series), len(mapping)
