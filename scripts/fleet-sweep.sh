#!/usr/bin/env bash
# Fleet sweep — compact per-lane state + DELTA vs previous sweep (change detection)
PAIRS="ses_f03a724f2ffeyFB06o8QEPjo5t:ygg ses_efd433c93ffe9CKvwt4Ncaqtn8:bnet ses_efe8e0d2fffeSwH0TVeMFuFXWC:worldtree ses_efeb3e31dffeVOMJ3ppI4DV0VH:flip ses_efeb8e7e5ffeJaHee6if1E8d2h:telemetry ses_efdc57a18ffe7PCNLgWt1vaouy:fixvoice ses_f0346393fffeFGSsna4ZQWZIpD:review ses_f03928ad5ffe4A1MmYFo0eND3u:planner ses_efca0aedaffesonQDSfSxWJlrj:askagi ses_efe8324f2ffeQsGBQ2qteWVSu1:diag ses_f0684fdc4ffeti8FFEhn1ozDiP:backup ses_f033cf761ffeiQJOHZia9qmg6d:japan ses_f037860bbffeJ66UHVm11eBpBp:fix1 ses_efa0b27e6ffeXmcnOFQwpXDAUg:wt-worker ses_f28e2fdf4ffeWng5LZZnYbCpnm:main"
STATE=/tmp/fleet-sweep-last.txt
> "$STATE.new"
for pair in $PAIRS; do
  n="${pair#*:}"; s="${pair%%:*}"
  r=$(timeout 8 curl -s --max-time 6 "http://127.0.0.1:4096/session/$s/message" 2>/dev/null | python3 -c "
import json,sys
try:
    m=json.load(sys.stdin)
    last=''; fin='idle'
    for x in reversed(m):
        if (x.get('info') or {}).get('role')=='assistant':
            parts=x.get('parts') or []
            fin='RUNNING' if not any(p.get('type')=='step-finish' for p in parts) else 'idle'
            t=' '.join(p.get('text','') for p in parts if p.get('type')=='text').strip()
            if t: last=t[:60]; break
    print(f'{len(m)}|{fin}|{last}')
except: print('-|-|-')" 2>/dev/null)
  cnt="${r%%|*}"; rest="${r#*|}"
  prev=$(grep "^$n " "$STATE" 2>/dev/null | cut -d' ' -f2)
  delta=""
  [ -n "$prev" ] && [ "$prev" != "$cnt" ] && delta="  ← +$((cnt-prev))"
  echo "$n $cnt" >> "$STATE.new"
  printf "%-12s %s msgs %s%s | %s\n" "$n" "$cnt" "$fin" "$delta" "$(echo "$rest" | cut -d'|' -f2- | cut -c1-70)"
done
mv "$STATE.new" "$STATE"
