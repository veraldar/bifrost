#!/usr/bin/env bash
# Spec for scripts/where.sh (S5): each of the four questions is answered from ONE call.
# Usage: scripts/test-where.sh      (exit 0 = all four answered)
cd "$(dirname "$0")/.." || exit 1
out="$(WHERE_NOGATE=1 scripts/where.sh 2>&1)"; fails=0
chk() { # name, section, regex that must appear inside that section
  local sec; sec="$(echo "$out" | awk -v s="== $2 ==" '$0==s{f=1;next} /^== /{f=0} f')"
  if echo "$sec" | grep -Eq "$3"; then echo "PASS  $1"; else echo "FAIL  $1  (section $2 lacks /$3/)"; fails=$((fails+1)); fi
}
chk "what version: live release label"      VERSION '^stable .*LIVE +v[0-9]'
chk "what version: served build id"         VERSION ':8080 serves build [A-Za-z0-9_-]{15,}'
chk "what version: sandbox commit"          VERSION '^sandbox .*@[0-9a-f]{7}'
chk "what URL: stable + next, https"        URL     '^stable +https://'
chk "what URL: next on :8443"               URL     '^next +https://[^ ]+:8443'
chk "what runs: units with state"           RUNS    'lk-pwa +(active|inactive|failed)'
chk "what runs: listening ports"            RUNS    'listening:'
chk "what runs: lanes"                      RUNS    'lanes:'
chk "what to test next: last URD row"       NEXT    'last URD row'
chk "what to test next: owed rows"          NEXT    'open URD rows'
chk "what to test next: sandbox command"    NEXT    'PW_BASE_URL=http://127.0.0.1:8090'
chk "which labs run: worldtree timer"      LABS    '^  worldtree +'
chk "which labs run: ygg-sim, no driver"    LABS    'ygg-sim +container up=[01] · driver: none'
chk "which labs run: registry owner+wake"   LABS    'wake: .*\| S13'
chk "labs: all 16 registry rows"            LABS    'the Mac'
for m in version url runs next labs; do [ -n "$(WHERE_NOGATE=1 scripts/where.sh $m)" ] && echo "PASS  subcommand $m" || { echo "FAIL  subcommand $m"; fails=$((fails+1)); }; done
[ "$fails" = 0 ] && echo "where.sh spec GREEN" || { echo "where.sh spec RED ($fails)"; exit 1; }
