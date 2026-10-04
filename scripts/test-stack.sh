#!/usr/bin/env bash
# Sandbox test stack — the NEW bifrost app -> bifrost-net -> yggdrasil,
# running NEXT TO the live stack (8080/opencode), never touching it.
#   up     : yggdrasil :4100 + PWA :8090 (OPENCODE_URL=4100) + bifrost-net
#   down   : stop the sandbox (live 8080/4096 untouched)
#   status : probe both stacks
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD="${1:-status}"

up() {
  cd "$ROOT/lab/yggdrasil"
  [ -x target/release/yggdrasil ] || { echo "[test-stack] no yggdrasil binary — cargo build --release first"; return 1; }
  set -a; [ -f yggdrasil.env ] && source yggdrasil.env; set +a
  setsid nohup ./target/release/yggdrasil >/tmp/ygg-test.log 2>&1 </dev/null &
  cd "$ROOT/pwa"
  setsid nohup env OPENCODE_URL=http://127.0.0.1:4100 npx next start -p 8090 >/tmp/pwa-test.log 2>&1 </dev/null &
  [ -x lab/bifrost-net/target/release/bifrost-net ] && (cd lab/bifrost-net && setsid nohup ./target/release/bifrost-net serve -c config-test.toml >/tmp/bnet-test.log 2>&1 </dev/null &)
  sleep 3
  echo "[test-stack] up — rust PWA :8090 (brain: yggdrasil :4100) | live stack :8080/:4096 untouched"
}
down() {
  pkill -f "next start -p 8090" 2>/dev/null
  pkill -f "target/release/yggdrasil" 2>/dev/null
  echo "[test-stack] sandbox stopped (live :8080/:4096 untouched)"
}
status() {
  for p in "8080 live-opencode" "8090 test-PWA" "4100 yggdrasil"; do
    port="${p%% *}"; name="${p#* }"
    code=$(curl -s --max-time 4 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null)
    echo "  :$port $name → ${code:-down}"
  done
}
case "$CMD" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: scripts/test-stack.sh [up|down|status]";;
esac
