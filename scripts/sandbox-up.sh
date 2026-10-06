#!/usr/bin/env bash
# THE SANDBOX STACK in one command: brain -> app -> voice agent -> bridge.
# Deterministic routing: sandbox rooms dispatch to AGENT_NAME (bifrost-ygg),
# whose brain is YGGDRASIL (4100) — one store for the phone and the agent.
set -u
FAIL=0
for u in yggdrasil bifrost-sandbox lk-agent-ygg bifrost-bridge; do
  systemctl --user enable --now "$u" 2>/dev/null
  st=$(systemctl --user is-active "$u")
  echo "$u: $st"
  [ "$st" = active ] || FAIL=1
done
sleep 2
curl -s -o /dev/null -w 'brain 4100: %{http_code}\n' -m 5 http://127.0.0.1:4100/session
curl -s -o /dev/null -w 'app 8090: %{http_code}\n' -m 8 http://127.0.0.1:8090/
curl -s -m 5 http://127.0.0.1:8090/api/session/main/messages?limit=1 | grep -q '"' && echo "store seam: the app reads the yggdrasil store" || { echo "store seam: BROKEN"; FAIL=1; }
D=$(grep '^AGENT_DISPATCH_NAME=' /home/dweeb_xyz/Work/bifrost-sandbox/pwa/.env.local 2>/dev/null | cut -d= -f2-)
[ -n "$D" ] && curl -s -m 10 -X POST http://127.0.0.1:8090/api/token -H 'content-type: application/json' -d '{"room":"stack-up-probe","meta":"{}"}' >/dev/null && echo "dispatched sandbox room → $D"
exit $FAIL
