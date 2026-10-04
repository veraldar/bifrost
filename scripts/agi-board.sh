#!/usr/bin/env bash
# AGI work board — PIDs, lanes, states, deliverables. One command = the truth.
echo "════ AGI PIDs (live delegations) ════"
pgrep -af "claude -p" 2>/dev/null | grep -v pgrep | sed 's/ --dangerously.*//' | cut -c1-160 | head -6
echo "════ fleet sessions ════"
for pair in "ses_f03a724f2ffeyFB06o8QEPjo5t:ygg-orchestrator" "ses_efd433c93ffe9CKvwt4Ncaqtn8:bifrost-net" "ses_efe8e0d2fffeSwH0TVeMFuFXWC:worldtree" "ses_efeb3e31dffeVOMJ3ppI4DV0VH:flip" "ses_efeb8e7e5ffeJaHee6if1E8d2h:telemetry" "ses_efdc57a18ffe7PCNLgWt1vaouy:fixvoice" "ses_f0346393fffeFGSsna4ZQWZIpD:review" "ses_f03928ad5ffe4A1MmYFo0eND3u:planner" "ses_efca0aedaffesonQDSfSxWJlrj:ask-agi" "ses_efe8324f2ffeQsGBQ2qteWVSu1:diag" "ses_f0684fdc4ffeti8FFEhn1ozDiP:backup" "ses_f033cf761ffeiQJOHZia9qmg6d:japan" "ses_f037860bbffeJ66UHVm11eBpBp:fix1" "ses_efa0b27e6ffeXmcnOFQwpXDAUg:wt-worker"; do
  n="${pair#*:}"; s="${pair%%:*}"
  timeout 8 curl -s --max-time 6 "http://127.0.0.1:4096/session/$s/message" 2>/dev/null | python3 -c "
import json,sys
try:
    m=json.load(sys.stdin)
    last=''; state='?'
    for x in reversed(m):
        if (x.get('info') or {}).get('role')=='assistant':
            parts=x.get('parts') or []
            state='RUNNING' if not any(p.get('type')=='step-finish' for p in parts) else 'idle'
            t=' '.join(p.get('text','') for p in parts if p.get('type')=='text').strip()
            if t: last=t[:80]; break
    print(f'{state:8} | {len(m)}m | {last}')
except: print('-')"
done
echo "════ open claims ════"
grep -c "^\- \[ \]" docs/claims.md 2>/dev/null || echo "claims file moved — check docs/"
