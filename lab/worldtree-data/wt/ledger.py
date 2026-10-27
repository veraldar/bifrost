"""The run ledger (S17): one JSON line per nightly in <lab>/ledger.jsonl (gitignored, backed up with the box).

Replaces the empty "run <id>: published" trunk commits. Shape follows the S14 metrics ledger (docs/metrics, JSONL):
ts / lab / metric / value plus tags, so its adapter reads this file as-is:
  lab=worldtree  metric=worldtree.run_health  value=1|0 (ok)  tags: run_id, published, first_gate_failure,
  sources_fresh (no failed stale/snapshot_age gate), published_sha_ok (veraldar.org serves our realms.json), trunk_commit.
"""
import datetime as dt
import hashlib
import json
import urllib.request

from .common import root, sha256_file

LEDGER = "ledger.jsonl"
URL = "https://veraldar.org/realms.json"


def append(line):
    with open(root() / LEDGER, "a") as f:
        f.write(json.dumps(line, sort_keys=True, ensure_ascii=False) + "\n")


def remote_sha(url=URL):
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return hashlib.sha256(r.read()).hexdigest()
    except Exception:
        return None


def build(verify=True):
    m = json.loads((root() / "manifest.json").read_text())
    last = m["last_run"]
    gates = json.loads((root() / "runs" / last["run_id"] / "gates.json").read_text())
    fresh = not any(not g["pass"] for g in gates if g["gate"] in ("stale", "snapshot_age"))
    sha_ok = None
    if verify and last["published"]:
        sha_ok = remote_sha() == sha256_file(root() / "out" / "realms.json")
    today = last["run_id"][:8] == dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")  # a stale manifest is a dead night
    ok = bool(last["published"]) and fresh and today and sha_ok is not False
    return {"ts": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "lab": "worldtree",
            "metric": "worldtree.run_health", "value": int(ok), "run_id": last["run_id"],
            "published": bool(last["published"]), "first_gate_failure": last["first_gate_failure"],
            "sources_fresh": fresh, "published_sha_ok": sha_ok, "method_version": m.get("method_version"),
            "fresh_run": today, "trunk_commit": False}


def main(verify=True):
    line = build(verify)
    append(line)
    print(f"ledger: {line['run_id']} run_health={line['value']} published={line['published']} "
          f"fresh={line['sources_fresh']} sha_ok={line['published_sha_ok']}")
    return 0
