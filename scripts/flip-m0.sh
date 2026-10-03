#!/usr/bin/env bash
# M0 (flip-automation): reproduce the manual-re-entry pain in one command.
# Boots the WORKTREE build on the scratch port :3312 (never the live :8080),
# runs pwa/e2e/flip.spec.ts — which restarts that server mid-test (the flip
# window) — and leaves the scratch server UP on the good env afterwards.
# Evidence: /tmp/opencode/flip-pwa.log + artifacts/flip-m0-*.png (repo root).
# Usage: scripts/flip-m0.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
PWA=pwa PORT=3312 LOG=/tmp/opencode/flip-pwa.log

fail() { echo "[flip-m0] FAIL: $*"; exit 1; }
probe() { curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }

[[ -d "$PWA/.next" ]] || fail "no build — run: cd pwa && npm run build"

up() { [[ "$(probe http://127.0.0.1:$PORT/api/session)" == "200" ]]; }
# the scratch server shares the LIVE LiveKit (same box): mint tokens with the
# live keys, read-only — secrets never land in the worktree tree
LIVE_ENV=~/Work/bifrost/pwa/.env.local
[[ -f "$LIVE_ENV" ]] || fail "live env missing: $LIVE_ENV (voice tokens need LIVEKIT_URL + keys)"
set -a; source "$LIVE_ENV"; set +a
start_srv() {
  mkdir -p /tmp/opencode
  (cd "$PWA" && nohup npx next start -p $PORT -H 127.0.0.1 >>"$LOG" 2>&1 &)
  for _ in $(seq 120); do up && return 0; sleep 0.5; done
  fail "scratch server did not come up (log: $LOG)"
}

if up; then
  echo "[flip-m0] scratch server already up on :$PORT"
else
  echo "[flip-m0] starting scratch server on :$PORT…"
  start_srv
fi

echo "[flip-m0] running the M0 repro spec…"
(cd "$PWA" && npx playwright test --config=playwright.flip.config.ts)
RC=$?

if up; then
  echo "[flip-m0] scratch server left UP on :$PORT (log: $LOG)"
else
  start_srv
fi
(( RC == 0 )) && echo "[flip-m0] OK — repro captured (artifacts/flip-m0-*.png)" \
               || fail "spec exited $RC — see $LOG and artifacts/"
exit $RC
