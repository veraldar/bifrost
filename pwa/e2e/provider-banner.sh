#!/usr/bin/env bash
# PROVIDER-WAVE e2e runner (10-28): the 429 → banner, on a scratch stack only.
#   mock :4145 (key mock-1310 = z.ai's weekly/monthly limit, reset = now + 1 h, UTC+8)
#   NEW root :4146 = the provider-wave yggdrasil (YGG_BIN, default the trunk's debug build)
#   OLD root :4147 = the frozen live binary (read-only copy of ~/.local/share/bifrost/brain/yggdrasil-412a9c4)
#   PWA :4148 → NEW root, PWA :4149 → OLD root (this worktree's `next build`, `next start`)
# Never touches :4100 / :8080 / :8090 / :443 / :8443. Usage: e2e/provider-banner.sh [new|old|both|smoke [specs…]]
#   smoke = a HEALTHY key on the NEW root: the general specs given (default base/history/states) on
#   this build — the regression check that error-turn plumbing left normal turns alone.
set -euo pipefail
cd "$(dirname "$0")/.."
WHICH=${1:-both}
YGG_SRC=${YGG_SRC:-$HOME/Work/bifrost/lab/yggdrasil}
NEW_BIN=${YGG_BIN:-$YGG_SRC/target/debug/yggdrasil}
OLD_BIN=${OLD_BIN:-$HOME/.local/share/bifrost/brain/yggdrasil-412a9c4}
for p in 4145 4146 4147 4148 4149; do
  ss -ltn "sport = :$p" | grep -q LISTEN && { echo "FAIL: port $p is held"; exit 1; }
done
[ -d .next ] || { echo "FAIL: no .next build — npm run build first"; exit 1; }
TMP=$(mktemp -d)
PIDS=()
trap 'kill ${PIDS[@]} 2>/dev/null; wait 2>/dev/null; rm -rf $TMP' EXIT
python3 "$YGG_SRC/mock/mock_upstream.py" 4145 2>$TMP/mock.log & PIDS+=($!)
KEY=mock-1310
[ "$WHICH" = smoke ] && KEY=good-key
root() { # PORT BIN
  mkdir -p $TMP/$1/data $TMP/$1/proj
  env -i HOME=$HOME PATH=$PATH YGG_UPSTREAM_BASE_URL=http://127.0.0.1:4145 YGG_UPSTREAM_STYLE=anthropic \
    YGG_UPSTREAM_API_KEY=$KEY YGG_UPSTREAM_MODEL=glm-mock YGG_UPSTREAM_RESET_TZ=+08:00 \
    YGG_PROVIDERS=$TMP/none.json YGG_LISTEN=127.0.0.1:$1 YGG_DATA_DIR=$TMP/$1/data \
    YGG_PROJECT_DIR=$TMP/$1/proj YGG_CONTEXT_FILES=$TMP/none.md "$2" 2>$TMP/root-$1.log & PIDS+=($!)
}
pwa() { # PORT BRAIN
  OPENCODE_URL=http://127.0.0.1:$2 PORT=$1 npx next start -p $1 -H 127.0.0.1 >$TMP/pwa-$1.log 2>&1 & PIDS+=($!)
}
wait_up() { for _ in $(seq 100); do curl -sf -o /dev/null "$1" && return; sleep 0.2; done; echo "FAIL: $1 never came up"; exit 1; }
RC=0
run() { # ROOTNAME PWAPORT
  echo "=== ROOT=$1 (PWA :$2)"
  ROOT=$1 PW_BASE_URL=http://127.0.0.1:$2 npx playwright test e2e/provider-banner.spec.ts --reporter=list || RC=1
}
if [ "$WHICH" = smoke ]; then
  shift || true
  SPECS=${*:-e2e/base.spec.ts e2e/history.spec.ts e2e/states.spec.ts}
  root 4146 "$NEW_BIN"; pwa 4148 4146
  wait_up http://127.0.0.1:4146/session; wait_up http://127.0.0.1:4148/
  PW_BASE_URL=http://127.0.0.1:4148 npx playwright test $SPECS --reporter=list || RC=1
  [ $RC = 0 ] && echo "smoke: GREEN" || echo "smoke: RED"
  exit $RC
fi
if [ "$WHICH" != old ]; then root 4146 "$NEW_BIN"; pwa 4148 4146; fi
if [ "$WHICH" != new ]; then cp "$OLD_BIN" $TMP/ygg-frozen; root 4147 $TMP/ygg-frozen; pwa 4149 4147; fi
[ "$WHICH" != old ] && { wait_up http://127.0.0.1:4146/session; wait_up http://127.0.0.1:4148/; run new 4148; }
[ "$WHICH" != new ] && { wait_up http://127.0.0.1:4147/session; wait_up http://127.0.0.1:4149/; run old 4149; }
[ $RC = 0 ] && echo "provider-banner e2e: GREEN ($WHICH)" || { echo "provider-banner e2e: RED"; tail -n 5 $TMP/root-*.log; }
exit $RC
