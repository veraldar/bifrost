#!/usr/bin/env bash
# worldtree-data report: re-runs the pipeline end-to-end from stored raw
# (fetch excluded — run `python3 -m wt fetch` for that), publishes a fresh
# run, then prints the seven outcome percentages with the sources behind
# each number. Per-number provenance lives in out/realms.provenance.json.
set -e
cd "$(dirname "$0")/.."
python3 -m wt run --as-of "$(date -u +%F)" --no-fetch --commit
python3 - <<'PY'
import json
r = json.load(open('out/realms.json'))
p = json.load(open('out/realms.provenance.json'))
print()
print(f"worldtree-data — run {p['run_id']} · method {p['method_version']} · as-of {p['as_of']}")
print(f"window: {r['window']}")
print()
for k, v in r['weights'].items():
    R = p['realms'][k]
    srcs = sorted({i['source_id'] for i in R['indicators']})
    lic = sorted({i['license'] for i in R['indicators']})
    top = sorted(R['indicators'], key=lambda i: -abs(i['contribution']))[:2]
    tops = "; ".join(f"{i['label']} [{i['source_id']}, score {i['score']:.2f}]" for i in top)
    print(f"{k:14} {v:5.1f}%  coverage {R['coverage']:.0%}  sources: {', '.join(srcs)} ({', '.join(lic)})")
    print(f"{'':14} strongest: {tops}")
print()
print("every number above traces: realms.provenance.json -> series_sha256 -> raw/ snapshot -> source_url")
PY
