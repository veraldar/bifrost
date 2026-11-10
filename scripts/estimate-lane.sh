#!/bin/bash
# estimate-lane.sh "<brief>" — predicted duration from closest log.tsv class history
# usage: scripts/estimate-lane.sh "<brief text>"; prints class, median, p90, n
B="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
case "$B" in
  *SIM*|*SEAM*|*DOOM*) C=sim-run ;;
  *DEPLOY*|*SWAP*|*BRAIN*) C=deploy ;;
  *AUDIT*|*ACCOUNT*|*VERIFY*|*REVIEW*|*GAP*) C=dispatch-audit ;;
  *STATION*|*WATCH*|*DEDUPE*|*LANE*|*QUIET*) C=station-fix ;;
  *CSS*|*STYLE*|*PROFILE*|*THEME*|*CARD*) C=css-fix ;;
  *) C=other ;;
esac
python3 - "$C" <<'EPY'
import sys, re, statistics
cls = sys.argv[1]
from datetime import datetime
v = []
for ln in open('/home/dweeb_xyz/Work/bifrost/.agi-log/log.tsv'):
    p = ln.rstrip('\n').split('\t')
    if len(p) < 10 or p[8] not in ('OK','FAIL','STALLED') or p[5] == '-':
        continue
    try:
        d = (datetime.fromisoformat(p[5]) - datetime.fromisoformat(p[4])).total_seconds() / 60
    except Exception:
        continue
    s = p[2].upper()
    c = ('sim-run' if re.search(r'SIM|SEAM|DOOM', s) else
         'deploy' if re.search(r'DEPLOY|SWAP|BRAIN', s) else
         'dispatch-audit' if re.search(r'AUDIT|ACCOUNT|VERIFY|GAP|REVIEW|GO', s) else
         'station-fix' if re.search(r'STATION|WATCH|DEDUPE|LANE|QUIET', s) else
         'css-fix' if re.search(r'CSS|STYLE|PROFILE|THEME|CARD', s) else 'other')
    if c == cls and 0 < d <= 600:
        v.append(d)
if v:
    v.sort()
    print(f"class={cls} est_median={statistics.median(v):.0f}min p90={v[int(len(v)*0.9)]:.0f}min n={len(v)}  -> attach as ESTIMATE at dispatch; over 1.5x median = early warning")
else:
    print(f"class={cls} no history — default band: sonnet build 5-30min, opus review 2-10min, sim 10-40min")
EPY
