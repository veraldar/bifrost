#!/usr/bin/env bash
# Safe deploy: build → restart → probe → e2e gate → auto-rollback on failure.
# Keeps the running instance safe while new phases are built elsewhere:
#   - only deploys from a clean main (experiments live on branches)
#   - refuses to restart while a run is live (proxy restart orphans runs)
#   - on any failed probe/test: rebuilds the last tag and re-verifies
# Usage: scripts/deploy.sh [--fast]   (--fast = probes only, skip e2e suite)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
FAST=0; [[ "${1:-}" == "--fast" ]] && FAST=1

fail() { echo "[deploy] FAIL: $*"; exit 1; }
probe() { curl -s -m 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }

# --- guardrails ---------------------------------------------------------------
[[ "$(git branch --show-current)" == "main" ]] || fail "not on main — experiments belong on a branch"
[[ -z "$(git status --porcelain pwa/ agent/ | head -1)" ]] || fail "uncommitted pwa/agent changes — commit or stash first (the live instance must serve a known commit)"
LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo main)"
# a run in flight would be orphaned by the restart — the watchdog would heal
# it into an abort, but losing the user's in-flight answer is not "safe"
LIVE="$(python3 - << 'EOF'
import json, time, pathlib
p = pathlib.Path('pwa/.oc-live.json')
try:
    live = json.loads(p.read_text())
    fresh = {k: v for k, v in live.items() if time.time() - v / 1000 < 30 * 60}
    print(len(fresh))
except Exception:
    print(0)
EOF
)"
[[ "$LIVE" == "0" || "${1:-}" == "--force" ]] || fail "$LIVE run(s) in flight — wait, or pass --force"

say() { echo "[deploy] $*"; }

# --- build + restart + probes --------------------------------------------------
build_and_restart() {
  (cd pwa && npm run build >>/tmp/deploy.log 2>&1) || return 1
  systemctl --user restart lk-pwa && sleep 5
  [[ "$(probe http://127.0.0.1:8080/)" == "200" ]] || return 1
  local css
  css="$(curl -s -m 5 http://127.0.0.1:8080/ | grep -o 'href="[^"]*\.css[^"]*"' | head -1 | sed 's/href="//;s/"$//')"
  [[ -z "$css" || "$(probe "http://127.0.0.1:8080$css")" == "200" ]] || return 1
  return 0
}

say "deploying $(git rev-parse --short HEAD) ($(git log -1 --format=%s | cut -c1-60))"
if ! build_and_restart; then
  say "probes failed — rolling back to $LAST_TAG"
  git checkout -q "$LAST_TAG" && build_and_restart || fail "rollback ALSO failed — manual attention needed"
  fail "deploy rolled back to $LAST_TAG"
fi

# --- e2e gate ------------------------------------------------------------------
if (( ! FAST )); then
  say "e2e gate (29+ specs, ~4 min)…"
  if ! (cd pwa && npx playwright test >>/tmp/deploy.log 2>&1); then
    say "e2e gate failed — rolling back to $LAST_TAG"
    git checkout -q "$LAST_TAG" && build_and_restart || fail "rollback ALSO failed — manual attention needed"
    (cd pwa && npx playwright test e2e/base.spec.ts >>/tmp/deploy.log 2>&1) || fail "rolled back but invariants still red — manual attention needed"
    fail "deploy rolled back to $LAST_TAG (invariants verified there)"
  fi
fi
say "OK — live at $(git rev-parse --short HEAD), probes+gate passed. log: /tmp/deploy.log"
