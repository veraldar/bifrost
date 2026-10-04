"""One pipeline run (plan.md `run`): fetch → series → compute → gates → runs/<id>/ → out/ → history."""
import csv
import datetime as dt
import fcntl
import io
import json
import shutil
import sys
from collections import OrderedDict

from . import method as M
from .catalog import check as catalog_check
from .common import (LOCK, MONTHLY_SOURCES, REALMS, append_csv, load_mapping, load_series, load_sources, mapping_path,
                     method_version, parse_params, read_csv, root, series_path, sha256_bytes, sha256_file, write_json)
from .contract import check as contract_check
from .extract import build_all, ext_of, month_snapshots, snapshot
from . import history as H
from .history import geography_block, refresh_block

HISTORY_HEADER = ["run_id", "updated", "method_version", "published"] + REALMS + ["first_gate_failure"]
RUN_GATES = ["catalog", "integrity", "realm_coverage", "global_coverage", "contract"]
SNAPSHOT_MAX_AGE = 30
JUMP = 10.0


def bias_ids(sid, s, transform):
    b = []
    if sid.startswith("wiki."):
        b += ["B1", "B2"]
    if sid.startswith("epoch."):
        b += ["B3"]
    if sid == "owid.extreme_poverty":
        b += ["B4"]
    if sid == "owid.conflict_deaths":
        b += ["B5"]
    if s["cadence"] == "annual":
        b += ["B6"]
    if transform == "logistic_delta":
        b += ["B7"]
    if sid == "owid.frontiermath_best":
        b += ["B8"]
    if sid.startswith("owid.ai_"):
        b += ["B9"]
    if sid.startswith(("arxiv.", "pubmed.", "fedreg.")):
        b += ["B12"]
    if sid.startswith("noaa."):
        b += ["B13"]
    if sid.startswith("ari."):
        b += ["B14"]
    if transform.startswith("rank_"):
        b += ["B11"]
    return b


def num_out(v):
    v = float(v)
    return int(v) if v == int(v) and abs(v) < 1e15 else v


def human(v, unit):
    v = float(v)
    t = f"{v:,.0f}" if abs(v) >= 1000 else f"{v:.4g}"
    return f"{t}%" if unit == "%" else f"{t} {unit}"


def load_rows(sid):
    rows = read_csv(root() / "series" / f"{sid}.csv")
    return [(r["period"], r["date"], float(r["value"])) for r in rows]


def snap_ref(meta):
    return {"path": meta["path"], "sha256": meta["sha256"], "retrieved_at": meta["retrieved_at"]}


def cut_rows(sid, cut):
    """Series rows (and the sha256 of that series text) with observation date ≤ cut; cut None ⇒ the whole file."""
    p = root() / "series" / f"{sid}.csv"
    if cut is None:
        return load_rows(sid), sha256_file(p)
    lines = p.read_text(encoding="utf-8").splitlines(keepends=True)
    keep = [ln for ln in lines[1:] if ln.split(",", 2)[1] <= cut]
    rows = [(r["period"], r["date"], float(r["value"])) for r in csv.DictReader(io.StringIO(lines[0] + "".join(keep)))]
    return rows, sha256_bytes((lines[0] + "".join(keep)).encode("utf-8"))


def compute(as_of, run_id, updated, cut=None):
    """Pure-ish core: reads catalog + series + sidecars, returns (realms_json, provenance, gates, first_fail).
    cut (method 0.3.0 history): only observations dated ≤ cut are seen; staleness is judged at cut, snapshot
    selection/age at as_of (raw files carry full history; later rows are dropped, never read)."""
    gates = []

    def gate(name, scope, ok, reason=""):
        gates.append({"gate": name, "scope": scope, "pass": bool(ok), "reason": reason})
        return ok

    errs, _, _ = catalog_check()
    gate("catalog", "run", not errs, "; ".join(errs[:3]) if errs else "mapping.csv valid")
    series = load_series()
    sources = load_sources()
    static = json.loads((root() / "catalog" / "realms.static.json").read_text(encoding="utf-8"))
    mapping = [r for r in load_mapping() if r["realm"] in REALMS and r["series_id"] in series]
    asof_d = dt.date.fromisoformat(as_of)
    cut_d = dt.date.fromisoformat(cut) if cut else asof_d
    # method 0.3.1: `unborn=drop` rows (an index that did not exist before its first week) are not in the mapping at
    # all for a cut before their first observation — not counted in W_map, no exclusion; earlier years stay as they were
    unborn = {}
    for r in mapping:
        if parse_params(r["params"]).get("unborn") == "drop" and not cut_rows(r["series_id"], cut)[0]:
            first = load_rows(r["series_id"])
            unborn[r["series_id"]] = first[0][1] if first else None
    feed_ids = list(OrderedDict((r["series_id"], 1) for r in mapping))
    mapping = [r for r in mapping if r["series_id"] not in unborn]
    w_map = {k: sum(int(r["weight"]) for r in mapping if r["realm"] == k) for k in REALMS}
    total_rows = cut_rows("wiki.en_total", cut)[0]
    total_meta = snapshot("wikimedia", series["wiki.en_total"]["slug"], "json", as_of)[1]

    per_realm = {k: {"used": [], "excluded": []} for k in REALMS}
    snaps_used = {}
    for r in mapping:
        sid, realm = r["series_id"], r["realm"]
        s = series[sid]
        scope = f"{sid}@{realm}"
        params = parse_params(r["params"])
        direction = 1 if r["direction"] == "+1" else -1
        rows, series_sha = cut_rows(sid, cut)
        _, meta = snapshot(s["source_id"], s["slug"], ext_of(s), as_of)
        last_date = rows[-1][1] if rows else None
        age = (cut_d - dt.date.fromisoformat(last_date)).days if last_date else None
        ex = None
        if not rows:
            ex = ("no_data", f"no observation on/before {cut_d.isoformat()}")
        elif age > int(s["max_age_days"]):
            ex = ("stale", f"latest {last_date}, age {age} d > {s['max_age_days']} d")
        if not gate("stale", scope, ex is None, ex[1] if ex else f"latest {last_date}, age {age} d ≤ {s['max_age_days']} d"):
            per_realm[realm]["excluded"].append({"series_id": sid, "reason": ex[0], "detail": ex[1], "last_date": last_date})
            continue
        snap_age = (asof_d - dt.date.fromisoformat(meta["retrieved_at"][:10])).days
        if not gate("snapshot_age", scope, snap_age <= SNAPSHOT_MAX_AGE, f"snapshot {meta['retrieved_at']} ({snap_age} d)"):
            per_realm[realm]["excluded"].append({"series_id": sid, "reason": "snapshot_age",
                                                 "detail": f"snapshot {snap_age} d old > {SNAPSHOT_MAX_AGE} d"})
            continue
        norm = params.get("norm") == "total"
        try:
            res = M.score(r["transform"], rows, s["cadence"], params, direction, total_rows if norm else None)
        except M.Excluded as e:
            gate(e.reason, scope, False, e.detail)
            per_realm[realm]["excluded"].append({"series_id": sid, "reason": e.reason, "detail": e.detail})
            continue
        gate("short_history", scope, True, f"ref_n {res['ref_n']}")
        gate("no_value", scope, True, f"y {res['y_latest']}")
        cite = meta
        if s["source_id"] in MONTHLY_SOURCES:
            # one raw file per month: cite the latest period's snapshot, verify every month's file the series used
            shas = {x["snapshot_sha256"] for x in read_csv(root() / "series" / f"{sid}.csv")}
            by_month = month_snapshots(s["source_id"], s["slug"], ext_of(s), as_of)
            for ym, ms in by_month.items():
                if ym > (cut_d.year, cut_d.month):  # months after the cut were never read
                    continue
                for m in ms:
                    if m["sha256"] in shas:
                        snaps_used[m["path"]] = m
            y, mo = map(int, rows[-1][0].split("-"))
            cite = next(m for m in reversed(by_month[(y, mo)]) if m["sha256"] in shas)
        snaps_used[cite["path"]] = cite
        if norm:
            snaps_used[total_meta["path"]] = total_meta
        per_realm[realm]["used"].append({
            "series_id": sid, "source_id": s["source_id"], "label": s["label"],
            "direction": direction, "weight": int(r["weight"]), "transform": r["transform"], "params": r["params"],
            "dimension": r["dimension"],
            "score": res["score"], "pct": res["pct"], "y_latest": res["y_latest"], "ref_n": res["ref_n"],
            "latest_period": rows[-1][0], "latest_date": rows[-1][1], "latest_value": num_out(rows[-1][2]),
            "unit": s["unit"],
            "series_path": f"series/{sid}.csv", "series_sha256": series_sha,
            "snapshot": snap_ref(cite), "norm_snapshot": snap_ref(total_meta) if norm else None,
            "source_url": cite["url"], "license": cite["license"], "attribution": cite["attribution"],
            "bias": bias_ids(sid, s, r["transform"]),
        })

    # integrity of every snapshot used
    bad = [p for p, m in sorted(snaps_used.items()) if sha256_file(root() / p) != m["sha256"]]
    gate("integrity", "run", not bad, f"{len(snaps_used)} snapshots verified" if not bad else f"mismatch: {bad[0]}")

    # aggregation
    agg, e = {}, {}
    for k in REALMS:
        used = per_realm[k]["used"]
        a = M.aggregate([(i["weight"], i["score"]) for i in used], w_map[k])
        for i in used:
            i["contribution"] = round(M.contribution(i["weight"], i["score"], a["mass"], a["w_used"]), 4)
        agg[k], e[k] = a, round(a["evidence"], 4)
    weights = M.largest_remainder(e)
    low = [k for k in REALMS if agg[k]["coverage"] < 0.5]
    gate("realm_coverage", "run", not low,
         "all realms ≥ 0.5" if not low else ", ".join(f"{k} {agg[k]['coverage']:.2f}" for k in low) + " < 0.5")
    all_used = [i for k in REALMS for i in per_realm[k]["used"]]
    n_src = len({i["source_id"] for i in all_used})
    gate("global_coverage", "run", len(all_used) >= 12 and n_src >= 2,
         f"{len(all_used)} indicators from {n_src} sources (need ≥ 12 from ≥ 2)")

    # realms.json
    used_series = OrderedDict()
    for i in all_used:
        used_series.setdefault(i["series_id"], i)
    dates = sorted(i["latest_date"] for i in used_series.values())
    window = (f"structured indicators · method {method_version()} · {len(used_series)} series · "
              f"data {dates[0]} → {dates[-1]}" if dates else f"structured indicators · method {method_version()} · 0 series")
    dim = {}
    for i in all_used:
        dim[i["dimension"]] = dim.get(i["dimension"], 0.0) + i["weight"] * abs(i["score"] - 0.5)
    dtot = sum(dim.values())
    dimensions = {d: round(100.0 * v / dtot, 1) for d, v in sorted(dim.items())} if dtot > 0 else {}
    top = {}
    for k in REALMS:
        cand = [i for i in per_realm[k]["used"] if i["score"] > 0.5]
        cand.sort(key=lambda i: -i["weight"] * abs(i["score"] - 0.5))  # stable: mapping order breaks ties
        top[k] = [f"{i['label']}: {human(i['latest_value'], i['unit'])} ({i['latest_period']}) · score {i['score']:.2f}"
                  for i in cand[:2]]
    src_count = {}
    for i in used_series.values():
        t = sources[i["source_id"]]["title"]
        src_count[t] = src_count.get(t, 0) + 1
    feeds = []
    for sid in feed_ids:
        if sid in unborn:
            feeds.append({"name": series[sid]["label"], "state": f"not yet started (first week {unborn[sid]})"})
            continue
        uses = [(k, i) for k in REALMS for i in per_realm[k]["used"] if i["series_id"] == sid]
        exs = [x for k in REALMS for x in per_realm[k]["excluded"] if x["series_id"] == sid]
        if uses:
            p = uses[0][1]["latest_period"]
            if len(uses) == 1:
                state = f"{p} · score {uses[0][1]['score']:.2f}"
            else:
                state = f"{p} · " + " · ".join(f"{k} {i['score']:.2f}" for k, i in uses)
        else:
            x = exs[0]
            if x["reason"] == "stale":
                state = f"excluded: stale ({x['last_date']})"
            elif x["reason"] == "short_history" and x["detail"].startswith("ref_n "):
                n, need = x["detail"][6:].split(" < ")
                state = f"excluded: short_history ({n}/{need})"
            else:
                state = f"excluded: {x['reason']}"
        feeds.append({"name": series[sid]["label"], "state": state})
    realms = {
        "updated": updated, "window": window,
        "colors": {k: static["colors"][k] for k in REALMS}, "definitions": {k: static["definitions"][k] for k in REALMS},
        "weights": weights, "world_weights": dict(weights),
        "dimensions": dimensions, "top": top, "sources": src_count, "feeds": feeds,
        "method_version": method_version(), "provenance": "realms.provenance.json",
        "refresh": refresh_block(), "geography": geography_block(),
    }
    v = contract_check(realms, now=dt.datetime.strptime(updated, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc))
    gate("contract", "run", v is None, v or "CONTRACT OK")

    # jump warning (never blocks)
    prev = root() / "out" / "realms.json"
    if prev.exists() and cut is None:
        try:
            pw = json.loads(prev.read_text())["weights"]
            jumps = [f"{k} {pw[k]}→{weights[k]}" for k in REALMS if abs(weights[k] - pw[k]) > JUMP]
        except Exception:
            jumps = []
        gate("jump", "run", True, ("WARNING: " + ", ".join(jumps)) if jumps else "no realm moved > 10 points")

    failed = [g for g in gates if g["scope"] == "run" and not g["pass"]]
    first_fail = failed[0]["gate"] if failed else None
    prov = {
        "schema": "worldtree.provenance/1", "run_id": run_id, "as_of": as_of, "updated": updated,
        "method_version": method_version(),
        "mapping_sha256": sha256_file(mapping_path()), "series_registry_sha256": sha256_file(series_path()),
        "published": first_fail is None, "sum_e": round(sum(e.values()), 4),
        "realms": {k: {
            "weight": weights[k], "world_weight": weights[k],
            "evidence": e[k], "mean_score": round(agg[k]["mean_score"], 4), "coverage": round(agg[k]["coverage"], 4),
            "mass": round(agg[k]["mass"], 4), "w_used": agg[k]["w_used"], "w_map": w_map[k],
            "indicators": [{x: i[x] for x in sorted(i) if x != "dimension"} for i in per_realm[k]["used"]],
            "excluded": [{x: ex[x] for x in sorted(ex) if x != "last_date"} for ex in per_realm[k]["excluded"]],
        } for k in REALMS},
    }
    return realms, prov, gates, first_fail


def main(as_of, now=None, no_fetch=False, commit=False):
    dt.date.fromisoformat(as_of)
    t = (dt.datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ") if now
         else dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, microsecond=0))
    run_id, updated = t.strftime("%Y%m%dT%H%M%SZ"), t.strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(LOCK, "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        head = None
        if commit:
            from .gitops import head_commit
            head = head_commit()
        if not no_fetch:
            from .fetch import fetch
            if fetch():
                print("fetch: some sources failed (snapshot_age gate decides)", file=sys.stderr)
        build_all(as_of)
        realms, prov, gates, first_fail = compute(as_of, run_id, updated)
        published = first_fail is None
        rd = root() / "runs" / run_id
        hdoc, hptext = H.build(as_of, run_id, updated)
        realms["history"] = {"file": H.FILE, "sha256": H.write(hdoc, hptext, rd / H.FILE)}
        write_json(rd / "gates.json", gates)
        write_json(rd / "provenance.json", prov, sort_keys=False)
        write_json(rd / "realms.json", realms, sort_keys=False)
        if published:
            # history first: once realms.json is replaced, the history file its sha256 points at is already in place
            pairs = [(H.PROV_FILE, H.PROV_FILE), (H.FILE, H.FILE),
                     ("provenance.json", "realms.provenance.json"), ("realms.json", "realms.json")]
            for src, dst in pairs:
                shutil.copyfile(rd / src, root() / "out" / (dst + ".tmp"))
            for _, dst in pairs:
                (root() / "out" / (dst + ".tmp")).replace(root() / "out" / dst)
        append_csv(root() / "out" / "history.csv", HISTORY_HEADER,
                   [run_id, updated, method_version(), int(published)] + [realms["weights"][k] for k in REALMS]
                   + [first_fail or ""])
        from .manifest import write_manifest
        write_manifest(run_id, published, first_fail, as_of, head)
        if commit:
            from .gitops import commit_run
            commit_run(run_id, published, first_fail)
    status = "published" if published else f"held — {first_fail}"
    print(f"run {run_id}: {status} · " + " ".join(f"{k} {realms['weights'][k]}" for k in REALMS))
    return 0 if published else 3
