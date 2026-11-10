#!/usr/bin/env bash
# deploy-root-when-quiet — the human-approved runbook (provider-wave §5, option B),
# executed autonomously in the first safe window. Fails CLOSED: any verification
# miss => instant rollback to yggdrasil-412a9c4 + restart + report.
set -u
LOG=/tmp/deploy-root.log
FROZEN=~/.config/systemd/user/lk-yggdrasil.service.d/frozen.conf
OLD=yggdrasil-412a9c4; NEW=yggdrasil-885122c
say(){ echo "$(date -Iseconds) $*" >> "$LOG"; }

wait_quiet(){
  for i in $(seq 1 90); do   # up to ~45 min
    st=$(curl -s --max-time 4 http://127.0.0.1:4100/session/status || echo x)
    rooms=$(journalctl --user -u lk-agent --since '-4 min' --no-pager 2>/dev/null | grep -c 'room' || true)
    if ! grep -q '"busy"' <<<"$st" && [ "${rooms:-1}" -eq 0 ]; then say "quiet window (iter $i)"; return 0; fi
    sleep 30
  done
  say "no quiet window in 45min — aborting, nothing deployed"; exit 1
}

rollback(){ say "ROLLBACK: $1"; sed -i "s|brain/$NEW|brain/$OLD|" "$FROZEN"; systemctl --user daemon-reload; systemctl --user restart lk-yggdrasil; sleep 4; systemctl --user is-active lk-yggdrasil >> "$LOG"; echo "deploy-root done ROLLED-BACK($1) $(date -Iseconds)" >> /tmp/sub-status.tsv; exit 2; }

wait_quiet
say "flipping ExecStart to $NEW"
sed -i "s|brain/$OLD|brain/$NEW|" "$FROZEN" || rollback "frozen.conf edit failed"
systemctl --user daemon-reload && systemctl --user restart lk-yggdrasil
sleep 5
systemctl --user is-active lk-yggdrasil | grep -q active || rollback "service not active"
curl -s --max-time 6 http://127.0.0.1:4100/session?limit=1 -o /dev/null || rollback "store API dead"
grep -qiE 'provider|fallback' <(journalctl --user -u lk-yggdrasil -n 8 --no-pager) || rollback "no provider line in boot log"
sleep 10
python3 ~/Work/bifrost/scripts/gate.py >> "$LOG" 2>&1
tail -25 "$LOG" | grep -q "GATE GREEN" || rollback "gate not green"
say "VERIFIED: provider+profiles root live, gate green"
echo "deploy-root done LIVE(885122c, provider+profiles) $(date -Iseconds)" >> /tmp/sub-status.tsv
# post: one real generation probe on a scratch session (not MAIN)
SID=$(curl -s -X POST http://127.0.0.1:4100/session -H 'content-type: application/json' -d '{"title":"[RUN] deploy-probe"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])' 2>/dev/null)
[ -n "$SID" ] && curl -s -X POST http://127.0.0.1:4100/session/$SID/message -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"one word: up"}]}' --max-time 30 -o /dev/null && curl -s -X DELETE http://127.0.0.1:4100/session/$SID -o /dev/null && say "generation probe passed"
