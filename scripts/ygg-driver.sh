#!/usr/bin/env bash
# The self-driving loop driver — detached forever-loop, nudges the ygg-sim
# lab per cadence so the self-improving cycle runs continuously.
OC="http://127.0.0.1:4096"
SID="ses_f03a724f2ffeyFB06o8QEPjo5t"
while true; do
  sleep 900
  last=$(curl -s --max-time 10 "$OC/session/$SID/message" 2>/dev/null | python3 -c "
import json,sys,time
try:
    m=json.load(sys.stdin)
    t=0
    for x in m:
        ts=((x.get('info') or {}).get('time') or {})
        t=max(t, ts.get('created') or 0)
    print(int((time.time()-t/1000)/60) if t else 999)
except: print(999)")
  if [ "$last" -ge 30 ] 2>/dev/null; then
    curl -s --max-time 60 -o /dev/null -X POST "$OC/session/$SID/message" -H 'Content-Type: application/json' \
      -d '{"parts":[{"type":"text","text":"DRIVER CADENCE: '"$last"' min quiet. Continue the self-improving loop — run the cycle, mine, build the next slice, one line per milestone."}]}' 2>/dev/null
    echo "$(date +%F\ %T) nudged after ${last}m quiet"
  fi
done
