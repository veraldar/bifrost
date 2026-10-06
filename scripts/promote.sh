#!/usr/bin/env bash
# promote — the ONLY way code reaches the live stack (lk-pwa :8080 + lk-agent).
#
# Builds a frozen release (~/.local/share/bifrost/releases/<id>) from a git ref,
# switches the `live` symlink, restarts the two live units, runs scripts/gate.py
# and switches back on RED. Sessions edit ~/Work/bifrost freely; nothing they
# build or restart there reaches :8080 until it goes through here.
# Born 10-06 (the multi-instance night) — contract in docs/STABLE.md.
#
#   scripts/promote.sh <ref> [--label L]     release a commit (the normal path)
#   scripts/promote.sh --snapshot [--label L] release HEAD + the pwa/agent WIP as it is
#                                            now (overlay recorded; bootstrap/emergency)
#   scripts/promote.sh --rollback            live <- previous release, gated
#   scripts/promote.sh --install-units       point lk-pwa/lk-agent at the live release (once)
#   flags: --build-only (stage, don't switch)   --force (switch with runs in flight)
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIF="$HOME/.local/share/bifrost"
RELS="$BIF/releases"
ENV_DIR="$HOME/.config/bifrost/env"
UNITS="$HOME/.config/systemd/user"
NODE_BIN="${NODE_BIN:-$HOME/.local/share/mise/installs/node/26.8.1/bin}"
UV="${UV:-$HOME/.local/share/mise/installs/uv/latest/.mise-bins/uv}"
STATE_LINKS=(.diag .push-subs.json .oc-live.json .oc-queue.json .devices.json)

say() { echo "[promote] $*"; }
die() { echo "[promote] FAIL: $*" >&2; exit 1; }

REF="" SNAP=0 LABEL="" BUILD_ONLY=0 FORCE=0 MODE=release
while (($#)); do
  case "$1" in
    --snapshot) SNAP=1 ;;
    --label) LABEL="$2"; shift ;;
    --build-only) BUILD_ONLY=1 ;;
    --force) FORCE=1 ;;
    --rollback) MODE=rollback ;;
    --install-units) MODE=units ;;
    -*) die "unknown flag $1" ;;
    *) REF="$1" ;;
  esac
  shift
done

seed_env() {
  mkdir -p "$ENV_DIR"
  # one env per live service, outside every worktree (a session editing
  # pwa/.env.local can no longer move the live stack). Seeded once from the
  # files the stack ran with; process env beats any dotenv file.
  if [[ ! -f "$ENV_DIR/live-pwa.env" ]]; then
    { echo "# lk-pwa (live :8080) — the only env of the live PWA. Seeded $(date +%F) from pwa/.env.local."
      grep -v -E '^\s*(#|$)|^(OPENCODE_URL|ARTIFACTS_DIR)=' "$REPO/pwa/.env.local"
      echo "OPENCODE_URL=http://127.0.0.1:4096"
      echo "ARTIFACTS_DIR=$REPO/artifacts"
    } > "$ENV_DIR/live-pwa.env"
  fi
  if [[ ! -f "$ENV_DIR/live-agent.env" ]]; then
    { echo "# lk-agent (live voice worker) — the only env of the live agent. Seeded $(date +%F) from agent/.env."
      grep -v -E '^\s*(#|$)' "$REPO/agent/.env"
    } > "$ENV_DIR/live-agent.env"
  fi
  chmod 600 "$ENV_DIR"/live-*.env
  [[ "$(grep -h '^AGENT_NAME=' "$ENV_DIR/live-pwa.env")" == "$(grep -h '^AGENT_NAME=' "$ENV_DIR/live-agent.env")" ]] \
    || die "AGENT_NAME differs between live-pwa.env and live-agent.env — fix before promoting"
}

# Drop-ins go in seconds before a switch, never while `live` is missing: a unit
# that crash-restarts into an absent WorkingDirectory would loop dead.
install_units() {
  [[ -L "$BIF/live" || -n "${1:-}" ]] || die "no live release yet — run a promote first"
  local bk="$HOME/.local/state/bifrost-backup/units-$(date +%Y%m%dT%H%M%S)"
  mkdir -p "$bk" "$UNITS/lk-pwa.service.d" "$UNITS/lk-agent.service.d"
  cp -a "$UNITS/lk-pwa.service.d" "$UNITS/lk-agent.service.d" "$bk/" 2>/dev/null
  cp -a "$ENV_DIR" "$bk/env" 2>/dev/null
  echo "$bk" > "$BIF/.units-backup"
  rm -f "$UNITS/lk-pwa.service.d/env.conf"   # superseded (was OPENCODE_URL only); copy in $bk
  cat > "$UNITS/lk-pwa.service.d/live.conf" <<'EOF'
# Served from the frozen live release, never a worktree (scripts/promote.sh, docs/STABLE.md).
[Service]
WorkingDirectory=%h/.local/share/bifrost/live/pwa
EnvironmentFile=%h/.config/bifrost/env/live-pwa.env
# open SSE streams kept every restart hanging 90s until SIGKILL — clients reconnect anyway
TimeoutStopSec=15
EOF
  cat > "$UNITS/lk-agent.service.d/live.conf" <<'EOF'
# Served from the frozen live release, never a worktree (scripts/promote.sh, docs/STABLE.md).
[Service]
WorkingDirectory=%h/.local/share/bifrost/live/agent
EnvironmentFile=%h/.config/bifrost/env/live-agent.env
Environment=UV_FROZEN=1
EOF
  systemctl --user daemon-reload
  say "units point at $BIF/live (backup: $bk) — they take effect on the next switch"
}

wait_agent() {  # registered worker since $1
  for _ in $(seq 1 40); do
    journalctl --user -u lk-agent --since "$1" -o cat --no-pager 2>/dev/null | grep -q '"registered worker"' && return 0
    sleep 1
  done
  return 1
}

wait_pwa() {
  for _ in $(seq 1 40); do
    [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/)" == "200" ]] && return 0
    sleep 1
  done
  return 1
}

switch_to() {  # $1 = release dir name; restarts the live units onto it
  local t
  ln -sfn "releases/$1" "$BIF/live.new" && mv -Tf "$BIF/live.new" "$BIF/live" || return 1
  t="$(date '+%Y-%m-%d %H:%M:%S')"
  systemctl --user restart lk-agent && wait_agent "$t" || { say "agent did not register"; return 1; }
  systemctl --user restart lk-pwa && wait_pwa || { say "pwa did not come up"; return 1; }
  return 0
}

gate() { python3 "$REPO/scripts/gate.py"; }

in_flight() {
  curl -s -m 5 http://127.0.0.1:4096/session/status | python3 -c \
    'import json,sys; print(" ".join(k for k,v in json.load(sys.stdin).items() if (v or {}).get("type")=="busy"))' 2>/dev/null
}

unmigrate() {
  local bk; bk="$(cat "$BIF/.units-backup" 2>/dev/null)"
  say "first release failed its gate — units back to the worktree (pre-promote state)"
  rm -f "$UNITS/lk-pwa.service.d/live.conf" "$UNITS/lk-agent.service.d/live.conf"
  [[ -n "$bk" && -f "$bk/lk-pwa.service.d/env.conf" ]] && cp -a "$bk/lk-pwa.service.d/env.conf" "$UNITS/lk-pwa.service.d/"
  rm -f "$BIF/live"
  systemctl --user daemon-reload
  systemctl --user restart lk-agent lk-pwa
  wait_pwa && say "back on the worktree stack (:8080 200) — release kept for inspection" || die "unmigrate: pwa not up — manual attention"
}

rollback() {
  local prev
  prev="$(readlink "$BIF/previous" 2>/dev/null)" || die "no previous release to roll back to"
  say "rolling back: live -> ${prev#releases/}"
  switch_to "${prev#releases/}" || die "rollback switch failed — manual attention"
  gate && say "rolled back, gate GREEN" || die "rolled back but gate still RED — manual attention"
}

case "$MODE" in
  units) seed_env; install_units; exit 0 ;;
  rollback) rollback; exit $? ;;
esac

# --- build a release -----------------------------------------------------------
seed_env
cd "$REPO" || die "no repo"
if ((SNAP)); then
  BASE="$(git rev-parse HEAD)"
else
  [[ -n "$REF" ]] || die "usage: promote.sh <ref> | --snapshot | --rollback | --install-units"
  BASE="$(git rev-parse --verify "$REF^{commit}")" || die "unknown ref $REF"
fi
SHORT="${BASE:0:7}"
VERSION="$(git describe --tags --always "$BASE" | sed 's/^v//')"
OVERLAY=""
if ((SNAP)); then
  OVERLAY="$( { git diff "$BASE" -- pwa agent scripts; git ls-files -o --exclude-standard -- pwa agent scripts | sort; } | sha256sum | cut -c1-8)"
fi
ID="$(date +%Y%m%d-%H%M)-$SHORT${OVERLAY:+-wip$OVERLAY}"
REL="$RELS/$ID"
[[ -e "$REL" ]] && die "$REL exists"
mkdir -p "$REL"
say "building $ID (base $VERSION${OVERLAY:+ + WIP overlay $OVERLAY})"

if ((SNAP)); then
  git ls-files -co --exclude-standard -- pwa agent scripts \
    | grep -v -E '(^|/)(\.env|\.env\.local|\.diag/.*|\.push-subs\.json|\.oc-(live|queue)\.json|\.devices\.json)$' \
    | rsync -a --files-from=- ./ "$REL/" || die "snapshot copy failed"
  git diff "$BASE" -- pwa agent scripts > "$REL/OVERLAY.patch"
  git ls-files -o --exclude-standard -- pwa agent scripts > "$REL/OVERLAY.untracked"
else
  git archive --format=tar "$BASE" pwa agent scripts | tar -x -C "$REL" || die "archive failed"
fi
for f in "${STATE_LINKS[@]}"; do ln -sfn "$REPO/pwa/$f" "$REL/pwa/$f"; done

LOG="$REL/build.log"
(
  set -e
  cd "$REL/pwa"
  if ((SNAP)); then cp -a --reflink=auto "$REPO/pwa/node_modules" .; else "$NODE_BIN/npm" ci --prefer-offline --no-audit --no-fund; fi
  "$NODE_BIN/npm" version --no-git-tag-version --allow-same-version "$VERSION${OVERLAY:++wip.$OVERLAY}" >/dev/null
  set -a; . "$ENV_DIR/live-pwa.env"; set +a
  GIT_CEILING_DIRECTORIES="$BIF" PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" run build
  cd "$REL/agent"
  "$UV" sync --frozen
) > "$LOG" 2>&1 || die "build failed — see $LOG (live untouched)"

BUILD_ID="$(cat "$REL/pwa/.next/BUILD_ID")"
# freeze the source (manifest catches any later edit; read-only says "don't")
find "$REL/pwa" "$REL/agent" "$REL/scripts" \( -name node_modules -o -name .next -o -name .venv -o -name __pycache__ \) -prune \
  -o -type f -exec chmod a-w {} +
MANIFEST="$(python3 "$REPO/scripts/gate.py" --manifest "$REL")"
python3 - "$REL/RELEASE.json" <<EOF
import json, sys, time
json.dump({
  "id": "$ID", "label": "${LABEL:-$VERSION${OVERLAY:++wip.$OVERLAY}}", "version": "$VERSION${OVERLAY:++wip.$OVERLAY}",
  "base_sha": "$BASE", "source": "$SHORT${OVERLAY:++wip.$OVERLAY}", "overlay": "${OVERLAY}",
  "build_id": "$BUILD_ID", "manifest_sha256": "$MANIFEST",
  "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
}, open(sys.argv[1], "w"), indent=1)
EOF
chmod a-w "$REL/RELEASE.json"
say "built $ID · build $BUILD_ID · manifest ${MANIFEST:0:12}"
((BUILD_ONLY)) && { say "--build-only: staged, live untouched"; exit 0; }

# --- switch + gate -------------------------------------------------------------
busy="$(in_flight)"
[[ -z "$busy" || $FORCE == 1 ]] || die "run(s) in flight ($busy) — wait, or --force (staged at $REL)"
PREV="$(readlink "$BIF/live" 2>/dev/null || true)"
[[ -f "$UNITS/lk-pwa.service.d/live.conf" && -f "$UNITS/lk-agent.service.d/live.conf" ]] || install_units first
if switch_to "$ID" && gate; then
  [[ -n "$PREV" && "$PREV" != "releases/$ID" ]] && ln -sfn "$PREV" "$BIF/previous.new" && mv -Tf "$BIF/previous.new" "$BIF/previous"
  say "OK — live = $ID (previous: ${PREV#releases/})"
  exit 0
fi
say "gate RED on $ID"
if [[ -n "$PREV" ]]; then
  ln -sfn "$PREV" "$BIF/previous.new" && mv -Tf "$BIF/previous.new" "$BIF/previous"
  rollback
else
  unmigrate
fi
exit 1
