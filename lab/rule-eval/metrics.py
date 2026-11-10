#!/usr/bin/env python3
"""rule-eval metric probes — READ-ONLY against live stores.

Every probe measures, never mutates: opencode stores (:4096 legacy global,
:4100 yggdrasil root) are only GET; drift-guard is its own read-only script.
Results print as JSON and append to the rule-eval ledger.

Subcommands:
  discover-cost  timed store query + title match + message read (p50 of reps)
  noise-ratio    [LAB]-titled sessions not matching the standing registry
  main-bloat     bytes MAIN absorbed per coordination task (nous-sim runs)
  drift          drift-guard KNOWN-GAP count (runs scripts/drift-guard.sh)
  all            run every probe, append to ledger
"""
import argparse, json, re, statistics, subprocess, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

LEDGER = Path.home() / ".local/share/bifrost/bench/rule-eval.jsonl"
STORES = {"legacy-global": 4096, "yggdrasil": 4100}
SELF_FILE = Path(__file__).parent / ".self-session"  # session ids of this lab itself
# standing labs = the registry table in docs/LABS.md (source of truth)
STANDING = ["harness-bench", "tool-policy", "voice", "nous-sim", "ygg-sim"]
DISCOVERY_TARGET = "[LAB] harness-bench"  # present on both stores; same probe both sides
BIFROST = Path.home() / "Work/bifrost"


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def get_json(port: int, path: str, timeout: float = 10.0):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
        return json.loads(r.read().decode())


def list_sessions(port: int) -> list:
    return get_json(port, "/session?limit=1000")


def ledger_append(row: dict):
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")


def record(candidate: str, metric: str, value, unit: str, ok: bool, notes: str = ""):
    row = {"ts": now(), "kind": "measurement", "candidate": candidate,
           "metric": metric, "value": value, "unit": unit, "ok": ok, "notes": notes}
    ledger_append(row)
    return row


# ---------------------------------------------------------------- probes

def probe_discover_cost(port: int, reps: int, target: str = DISCOVERY_TARGET) -> dict:
    """Seconds for MAIN-equivalent discovery: full store query -> title match ->
    read the last message (home/artifact pointer). p50 over `reps` runs."""
    times, msgs = [], []
    sessions = list_sessions(port)
    hits = [s for s in sessions if (s.get("title") or "").strip() == target]
    if not hits:
        raise SystemExit(f"probe target {target!r} not found on :{port}")
    sid = sorted(hits, key=lambda s: s["time"]["updated"])[-1]["id"]
    for _ in range(reps):
        t0 = time.perf_counter()
        ss = list_sessions(port)
        h = [s for s in ss if (s.get("title") or "").strip() == target]
        get_json(port, f"/session/{h[-1]['id']}/message?limit=5")
        times.append((time.perf_counter() - t0) * 1000)
    val = round(statistics.median(times) / 1000, 3)
    return {"metric": "discovery_cost_s", "value": val, "unit": "s", "ok": True,
            "notes": f"store=:{port} sessions={len(sessions)} title_matches={len(hits)} "
                     f"reps={reps} p50_ms={round(statistics.median(times))}"}


def probe_noise_ratio(port: int) -> dict:
    """Share of [LAB]-titled sessions that are NOT standing labs.

    This lab's own session(s) (.self-session) never count — the validator
    must not grade itself as noise it created.
    """
    sessions = list_sessions(port)
    self_ids = set(SELF_FILE.read_text().split()) if SELF_FILE.exists() else set()
    sessions = [s for s in sessions if s["id"] not in self_ids]
    labs = [(s.get("title") or "").strip() for s in sessions
            if (s.get("title") or "").strip().startswith("[LAB]")]
    runs = [(s.get("title") or "").strip() for s in sessions
            if (s.get("title") or "").strip().startswith("[RUN]")]
    noise = [t for t in labs if not any(k in t.lower() for k in STANDING)]
    ratio = round(len(noise) / len(labs), 3) if labs else 0.0
    return {"metric": "noise_ratio", "value": ratio, "unit": "ratio", "ok": True,
            "notes": f"store=:{port} lab_titled={len(labs)} standing={len(labs)-len(noise)} "
                     f"noise={len(noise)} run_titled={len(runs)} total_sessions={len(sessions)} "
                     f"noise_titles={sorted(set(noise))}"}


def probe_main_bloat() -> dict:
    """Bytes MAIN absorbed per coordination task across nous-sim runs."""
    total_bytes = n_tasks = 0
    runs = sorted((BIFROST / "lab/nous-sim").glob("run-*/results.tsv"))
    for tsv in runs:
        for line in tsv.read_text().splitlines():
            cols = line.split("\t")
            if len(cols) >= 8 and cols[5] == "done":
                try:
                    total_bytes += int(cols[6]) + int(cols[7]); n_tasks += 1
                except ValueError:
                    pass  # malformed row
    val = round(total_bytes / n_tasks) if n_tasks else None
    return {"metric": "main_bloat_b", "value": val, "unit": "B/task", "ok": bool(val),
            "notes": f"nous_runs={len(runs)} tasks={n_tasks} bytes_total={total_bytes}"}


def probe_drift() -> dict:
    """drift-guard KNOWN-GAP count; silent drift makes the probe FAIL (ok=False)."""
    p = subprocess.run([str(BIFROST / "scripts/drift-guard.sh")],
                       capture_output=True, text=True, timeout=60)
    row = re.compile(r"^[^\s#]+\s+\S+\s+\S+\s+(KNOWN-GAP|DRIFT)$", re.M)
    gaps = len(re.findall(r"\sKNOWN-GAP$", p.stdout, re.M))
    silent = len(row.findall(p.stdout) or []) - gaps  # non-KNOWN-GAP data rows
    return {"metric": "drift_known_gaps", "value": gaps, "unit": "count",
            "ok": p.returncode == 0 and silent == 0,
            "notes": f"exit={p.returncode} silent_drift={silent}"}


PROBES = {"discover-cost": lambda a: probe_discover_cost(a.port, a.reps),
          "noise-ratio":   lambda a: probe_noise_ratio(a.port),
          "main-bloat":    lambda a: probe_main_bloat(),
          "drift":         lambda a: probe_drift()}

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--candidate", default="naming-law",
                        help="candidate to attribute measurements to")
    common.add_argument("--no-ledger", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in list(PROBES) + ["all"]:
        sp = sub.add_parser(name, parents=[common])
        if name in ("discover-cost", "noise-ratio", "all"):
            sp.add_argument("--store", default="yggdrasil", choices=STORES)
            sp.add_argument("--port", type=int, help="override store port")
        if name == "discover-cost":
            sp.add_argument("--reps", type=int, default=5)
    a = ap.parse_args()
    if a.cmd in ("discover-cost", "noise-ratio", "all"):
        a.port = a.port or STORES[a.store]
    if a.cmd == "all":
        outs = [probe_discover_cost(a.port, 5), probe_noise_ratio(a.port),
                probe_main_bloat(), probe_drift()]
    else:
        outs = [PROBES[a.cmd](a)]
    for out in outs:
        if not a.no_ledger:
            record(a.candidate, out["metric"], out["value"], out["unit"],
                   out["ok"], out["notes"])
    print(json.dumps(outs, indent=2))
