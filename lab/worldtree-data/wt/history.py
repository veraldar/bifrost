"""Method 0.3.0+ history (realms-history.json, schema worldtree.history/1): the same method, recomputed per year.

For each year Y in 2015 … as-of year the cut is Y-12-31 (the as-of date itself for the as-of year). compute() sees
only observations dated ≤ cut — rows after it are dropped before any transform, so adding future data to raw can
never move a past year. Raw snapshots are today's vintage (full history in one file): revisions are not undone.
"""
import datetime as dt
import json

from .common import REALMS, dumps, method_version, root, sha256_bytes

FIRST_YEAR = 2015
PROVISIONAL = 0.5
SCHEMA = "worldtree.history/1"
FILE = "realms-history.json"
PROV_FILE = "realms-history.provenance.json"
NOTES = [
    "Each year = the current method run with observations dated on/before that year's Dec-31 (the as-of date for "
    "the current year). No lookahead in observation dates; same transforms, gates and normalisation.",
    "Vintage: values come from today's source files, so later revisions of a past observation are included and "
    "publication lag is not modelled.",
    "provisional = a realm whose mapped-weight coverage that year is < 0.5; its weight is still normalised into "
    "the 100 (largest remainder). Pre-2018 years are thin on AI-specific series: arXiv/PubMed/Federal Register "
    "start 2019-01, Wikimedia 2015-07, Epoch 2015-01, and 12-month deltas need ≥ 24 reference points.",
    "Indices that did not exist before their first week (Agent Restriction Index, first week ending 2026-04-12; "
    "mapping param unborn=drop) are left out of the mapping for every earlier year — those years are unchanged.",
]


def method_block(name):
    return json.loads((root() / "method" / f"{name}.json").read_text(encoding="utf-8"))


def refresh_block():
    r = method_block("refresh")
    r["pipeline"] = f"worldtree-data method {method_version()}"
    return r


def geography_block():
    g = method_block("geography")
    return {"regions": g["regions"], **g["sources"]}


def cuts(as_of):
    d = dt.date.fromisoformat(as_of)
    return [(y, f"{y}-12-31" if y < d.year else as_of) for y in range(FIRST_YEAR, d.year + 1)]


def year_blob(cut, prov):
    keep = ("series_id", "series_path", "series_sha256", "latest_date", "source_url", "license", "score",
            "contribution", "weight", "direction", "transform", "ref_n")
    return {"as_of": cut, "realms": {k: {
        "weight": R["weight"], "coverage": R["coverage"], "evidence": R["evidence"], "w_used": R["w_used"],
        "w_map": R["w_map"],
        "indicators": [dict({x: i[x] for x in keep}, snapshot_sha256=i["snapshot"]["sha256"]) for i in R["indicators"]],
        "excluded": [{"series_id": e["series_id"], "reason": e["reason"]} for e in R["excluded"]],
    } for k, R in prov["realms"].items()}}


def build(as_of, run_id, updated):
    """→ (history doc, history provenance doc, provenance text). Pure function of catalog + series + raw."""
    from .run import compute
    years, blobs = [], {}
    for y, cut in cuts(as_of):
        realms, prov, gates, first_fail = compute(as_of, run_id, updated, cut=cut)
        blob = year_blob(cut, prov)
        blobs[str(y)] = blob
        R = prov["realms"]
        used = [i for k in REALMS for i in R[k]["indicators"]]
        ranks = [i["ref_n"] for i in used if i["transform"].startswith("rank_")]
        years.append({
            "year": y, "as_of": cut,
            "weights": realms["weights"],
            "coverage": {k: R[k]["coverage"] for k in REALMS},
            "provisional": {k: R[k]["coverage"] < PROVISIONAL for k in REALMS},
            "ref_n_min": min(ranks) if ranks else None,
            "indicators_used": len(used), "sources_used": len({i["source_id"] for i in used}),
            "gates": {g["gate"]: g["pass"] for g in gates if g["scope"] == "run"},
            "first_gate_failure": first_fail,
            "provenance": {"key": str(y), "sha256": sha256_bytes(dumps(blob, sort_keys=False).encode("utf-8"))},
        })
    hprov = {"schema": SCHEMA.replace("history", "history.provenance"), "run_id": run_id, "as_of": as_of,
             "updated": updated, "method_version": method_version(), "years": blobs}
    ptext = dumps(hprov, sort_keys=False)
    doc = {
        "schema": SCHEMA, "method_version": method_version(), "as_of": as_of, "updated": updated, "run_id": run_id,
        "notes": NOTES,
        "provenance": {"file": PROV_FILE, "sha256": sha256_bytes(ptext.encode("utf-8")),
                       "year_sha256": "sha256 of json.dumps(years[<year>], indent=1, ensure_ascii=False) + newline"},
        "years": years,
        "refresh": refresh_block(),
        "geography": geography_block(),
    }
    return doc, ptext


def write(doc, ptext, path):
    """Write realms-history.json + its provenance next to it; return the history file's sha256."""
    from .common import write_text
    text = dumps(doc, sort_keys=False)
    write_text(path.with_name(PROV_FILE), ptext)
    write_text(path, text)
    return sha256_bytes(text.encode("utf-8"))


def main(as_of, now=None, out=None):
    from pathlib import Path

    from .extract import build_all
    dt.date.fromisoformat(as_of)
    t = (dt.datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ") if now
         else dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, microsecond=0))
    build_all(as_of)
    doc, ptext = build(as_of, t.strftime("%Y%m%dT%H%M%SZ"), t.strftime("%Y-%m-%dT%H:%M:%SZ"))
    path = Path(out) if out else root() / "out" / FILE
    sha = write(doc, ptext, path)
    for y in doc["years"]:
        print(y["year"], " ".join(f"{k} {y['weights'][k]}" for k in REALMS),
              "provisional:", ",".join(k for k in REALMS if y["provisional"][k]) or "-")
    print(f"history {path} sha256 {sha}")
    return 0
