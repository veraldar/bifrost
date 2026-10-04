"""manifest.json (schema.md §4): index of every raw/series/run/out file. Rewritten each run."""
import datetime as dt
import json

from .common import load_series, load_sources, method_version, read_csv, rel, root, sha256_file, write_json


def _raw():
    out = []
    for sc in sorted((root() / "raw").rglob("*.prov.json")):
        m = json.loads(sc.read_text())
        out.append({"path": m["path"], "sha256": m["sha256"], "bytes": m["bytes"], "source_id": m["source_id"],
                    "slug": m["slug"], "retrieved_at": m["retrieved_at"]})
    return out


def _sources(raw):
    srcmeta = load_sources()
    out = {}
    for src in sorted({r["source_id"] for r in raw}):
        mine = [r for r in raw if r["source_id"] == src]
        last_status, last_at = None, None
        for log in sorted((root() / "raw" / src).glob("*/fetch-log.csv")):
            for row in read_csv(log):
                if last_at is None or row["attempted_at"] >= last_at:
                    last_at, last_status = row["attempted_at"], int(row["http_status"])
        out[src] = {"license": srcmeta[src]["license"], "snapshots": len(mine),
                    "last_retrieved_at": max(r["retrieved_at"] for r in mine), "last_status": last_status}
    return out


def _series(as_of):
    out = []
    asof_d = dt.date.fromisoformat(as_of)
    for sid, s in sorted(load_series().items()):
        p = root() / "series" / f"{sid}.csv"
        if not p.exists():
            continue
        rows = read_csv(p)
        last = rows[-1] if rows else None
        out.append({
            "series_id": sid, "path": rel(p), "sha256": sha256_file(p), "rows": len(rows),
            "first_period": rows[0]["period"] if rows else None, "last_period": last["period"] if last else None,
            "last_date": last["date"] if last else None, "snapshot_sha256": last["snapshot_sha256"] if last else None,
            "stale": (last is None or (asof_d - dt.date.fromisoformat(last["date"])).days > int(s["max_age_days"])),
        })
    return out


def _runs():
    out = []
    for d in sorted(p for p in (root() / "runs").iterdir() if p.is_dir()):
        prov = json.loads((d / "provenance.json").read_text())
        gates = json.loads((d / "gates.json").read_text())
        fail = next((g["gate"] for g in gates if g["scope"] == "run" and not g["pass"]), None)
        out.append({"run_id": d.name, "path": f"runs/{d.name}/", "published": prov["published"],
                    "first_gate_failure": fail})
    return out


def write_manifest(run_id, published, first_fail, as_of, head):
    raw = _raw()
    hist = read_csv(root() / "out" / "history.csv")
    pub = [h for h in hist if h["published"] == "1"]
    o = root() / "out"
    out = {}
    if (o / "realms.json").exists():
        out["realms"] = {"path": "out/realms.json", "sha256": sha256_file(o / "realms.json"),
                         "run_id": json.loads((o / "realms.provenance.json").read_text())["run_id"]}
        out["provenance"] = {"path": "out/realms.provenance.json", "sha256": sha256_file(o / "realms.provenance.json")}
    out["history"] = {"path": "out/history.csv", "rows": len(hist)}
    write_json(root() / "manifest.json", {
        "schema": "worldtree.manifest/1",
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method_version": method_version(),
        "repo_commit": head,
        "last_run": {"run_id": run_id, "published": published, "first_gate_failure": first_fail},
        "last_published": {"run_id": pub[-1]["run_id"], "updated": pub[-1]["updated"]} if pub else None,
        "sources": _sources(raw),
        "raw": raw,
        "series": _series(as_of),
        "runs": _runs(),
        "out": out,
    })
