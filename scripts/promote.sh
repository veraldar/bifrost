#!/usr/bin/env bash
# promote — the ONLY way code reaches the live stack (lk-pwa :8080 + lk-agent).
#
# Builds a frozen release (~/.local/share/bifrost/releases/<id>) from a git ref,
# switches the `live` symlink, restarts the two live units, runs scripts/gate.py
# and switches back on RED. Sessions edit ~/Work/bifrost freely; nothing they
# build or restart there reaches :8080 until it goes through here.
# Born 10-06 (the multi-instance night) — contract in docs/STABLE.md.
#
# A release is code + build + deps + ENV (env/live-{pwa,agent}.env, copied from
# ~/.config/bifrost/env at build time — that dir is only the draft for the next
# release). The units read the env of whatever `live` points at, so switching or
# rolling back a release switches its env too (v0.7's brain flip is env-only).
#
#   scripts/promote.sh <ref> [--label L]     release a commit (the normal path)
#   scripts/promote.sh --env-only [--label L] new release = live's build + the current
#                                            draft env (seconds, no rebuild)
#   scripts/promote.sh --snapshot [--label L] release HEAD + the pwa/agent WIP as it is
#                                            now (overlay recorded; bootstrap/emergency)
#   scripts/promote.sh --list                every built release (live / previous marked)
#   scripts/promote.sh --switch <id|label>   live <- any built release, gated, no rebuild
#   scripts/promote.sh --rollback            live <-> previous (run it twice = back again)
#   scripts/promote.sh --install-units       point lk-pwa/lk-agent at the live release (once)
#   flags: --build-only (stage, don't switch)   --force (switch with runs in flight)
#          --next <label|off>  where the next slot (:8443) moves after the switch — REQUIRED when the
#                              release being promoted is what :8443 serves (the consent flow): the
#                              TWO-ROOTS LAW (10-28) keeps :443 and :8443 on different builds
#                              (scripts/two-roots.sh). A rollback is never blocked, only reported.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIF="${BIFROST_HOME:-$HOME/.local/share/bifrost}"
RELS="$BIF/releases"
ENV_DIR="$HOME/.config/bifrost/env"
UNITS="${BIFROST_UNITS:-$HOME/.config/systemd/user}"
SANDBOX_PWA="${BIFROST_SANDBOX_PWA:-$HOME/Work/bifrost-sandbox/pwa}"
NODE_BIN="${NODE_BIN:-$HOME/.local/share/mise/installs/node/26.8.1/bin}"
UV="${UV:-$HOME/.local/share/mise/installs/uv/latest/.mise-bins/uv}"
STATE_LINKS=(.diag .push-subs.json .oc-live.json .oc-queue.json .devices.json)

say() { echo "[promote] $*"; }
die() { echo "[promote] FAIL: $*" >&2; exit 1; }

REF="" SNAP=0 ENV_ONLY=0 LABEL="" BUILD_ONLY=0 FORCE=0 MODE=release TARGET="" NEXT_TARGET=""
while (($#)); do
  case "$1" in
    --snapshot) SNAP=1 ;;
    --env-only) ENV_ONLY=1 ;;
    --list) MODE=list ;;
    --switch) MODE=switch; TARGET="${2:-}"; shift ;;
    --label) LABEL="$2"; shift ;;
    --build-only) BUILD_ONLY=1 ;;
    --force) FORCE=1 ;;
    --rollback) MODE=rollback ;;
    --next) NEXT_TARGET="${2:-}"; [[ -n "$NEXT_TARGET" ]] || die "--next needs <label|off>"; shift ;;
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
EnvironmentFile=%h/.local/share/bifrost/live/env/live-pwa.env
# open SSE streams kept every restart hanging 90s until SIGKILL — clients reconnect anyway
TimeoutStopSec=15
EOF
  cat > "$UNITS/lk-agent.service.d/live.conf" <<'EOF'
# Served from the frozen live release, never a worktree (scripts/promote.sh, docs/STABLE.md).
[Service]
WorkingDirectory=%h/.local/share/bifrost/live/agent
EnvironmentFile=%h/.local/share/bifrost/live/env/live-agent.env
Environment=UV_FROZEN=1
EOF
  systemctl --user daemon-reload
  say "units point at $BIF/live (backup: $bk) — they take effect on the next switch"
}

# env/ of a release: the env it runs with. Releases built before v0.6.1 had none —
# they get the env live runs with right now (exactly what they were serving with).
freeze_env() {  # $1 = release dir
  [[ -f "$1/env/live-pwa.env" && -f "$1/env/live-agent.env" ]] && return 0
  mkdir -p "$1/env"
  cp "$ENV_DIR/live-pwa.env" "$ENV_DIR/live-agent.env" "$1/env/" || return 1
  chmod 400 "$1"/env/live-*.env
}
backfill_env() {
  local r
  for r in "$RELS"/*/; do
    [[ -d "$r/env" ]] || { freeze_env "${r%/}" && say "env backfilled into $(basename "$r") (from $ENV_DIR)"; }
    link_artifacts "${r%/}"
  done
}
# <release>/artifacts -> the served ARTIFACTS_DIR: the release's own e2e suite
# (gate.py --full) writes fixtures to ../artifacts relative to pwa/
# and pwa/.env.local -> ../env/live-pwa.env: specs read LiveKit creds from it
# (same values the unit gets via EnvironmentFile, which wins in Next anyway)
link_artifacts() {
  [[ -e "$1/pwa/.env.local" || -L "$1/pwa/.env.local" ]] || ln -s ../env/live-pwa.env "$1/pwa/.env.local"
  [[ -L "$1/artifacts" ]] && return 0
  [[ -d "$1/artifacts" ]] && find "$1/artifacts" -maxdepth 1 -type f -name 'e2e-*' -delete && rmdir "$1/artifacts" 2>/dev/null
  [[ -e "$1/artifacts" ]] || ln -s "$REPO/artifacts" "$1/artifacts"
}
env_hash() { cat "$1/env/live-pwa.env" "$1/env/live-agent.env" | sha256sum | cut -c1-8; }

# id | label | unique id prefix -> release dir name
resolve() {
  local q="$1" r hit=""
  [[ -d "$RELS/$q" ]] && { echo "$q"; return 0; }
  for r in "$RELS"/*/; do
    r="$(basename "$r")"
    if [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("label",""))' "$RELS/$r/RELEASE.json" 2>/dev/null)" == "$q" || "$r" == "$q"* ]]; then
      [[ -n "$hit" ]] && die "'$q' matches several releases ($hit, $r) — use the full id"
      hit="$r"
    fi
  done
  [[ -n "$hit" ]] && echo "$hit" || die "no release '$q' (scripts/promote.sh --list)"
}

list_releases() {
  local live prev r
  live="$(readlink "$BIF/live" 2>/dev/null)"; prev="$(readlink "$BIF/previous" 2>/dev/null)"
  for r in "$RELS"/*/; do
    r="$(basename "$r")"
    python3 - "$RELS/$r/RELEASE.json" "$([[ "releases/$r" == "$live" ]] && echo LIVE)$([[ "releases/$r" == "$prev" ]] && echo PREVIOUS)" "$([[ -d "$RELS/$r/env" ]] && env_hash "$RELS/$r" || echo none)" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
brain = ""
try:
    import pathlib
    for l in (pathlib.Path(sys.argv[1]).parent / "env/live-pwa.env").read_text().splitlines():
        if l.startswith("OPENCODE_URL="): brain = l.split("=", 1)[1].rsplit(":", 1)[-1]
except Exception: pass
print(f"{sys.argv[2]:9} {m.get('label',''):22} {m['id']:40} brain :{brain or '?':5} env {sys.argv[3]}  {m.get('created','')[:16]}")
EOF
  done
}

# live <- $1 (gated). previous <- the release it replaced. RED -> straight back.
switch_gated() {
  local to="$1" from
  from="$(readlink "$BIF/live" 2>/dev/null)"
  [[ "releases/$to" == "$from" ]] && { say "$to is already live"; gate; return $?; }
  freeze_env "$RELS/$to" || die "$to has no env and none to backfill"
  say "switching: live ${from#releases/} -> $to"
  if switch_to "$to" && gate; then
    [[ -n "$from" ]] && ln -sfn "$from" "$BIF/previous.new" && mv -Tf "$BIF/previous.new" "$BIF/previous"
    say "OK — live = $to (previous: ${from#releases/})"
    two_roots_post
    return 0
  fi
  say "gate RED on $to — back to ${from#releases/}"
  switch_to "${from#releases/}" && gate && say "back on ${from#releases/}, gate GREEN" \
    || die "back on ${from#releases/} but gate still RED — manual attention"
  return 1
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

# TWO-ROOTS LAW (the user's order, 10-28): :443 and :8443 always serve different builds — the next
# slot holds the next evolution for consent. It collapsed on 10-27: rc2 was the consent build on
# :8443 and this script switched :443 to it. Before a FORWARD switch: if the target is what :8443
# serves, --next must say where the next slot goes (a different release, or `off` = the sandbox
# worktree build), checked BEFORE anything moves. After every switch: the next slot moves (if asked)
# and the law is checked out loud. A rollback is the safety net: never refused here, only reported.
two_roots_pre() {  # $1 = target release id
  local why nb
  why="$("$REPO/scripts/two-roots.sh" guard live "$1")" && {
    [[ -z "${PROMOTE_PRECHECK_ONLY:-}" ]] || { say "precheck only: $1 is not what :8443 serves"; exit 0; }
    return 0
  }
  [[ -n "$NEXT_TARGET" ]] || die "$why — promote with --next <label> (the next candidate takes :8443) or --next off (the sandbox worktree build)"
  if [[ "$NEXT_TARGET" == off ]]; then
    nb="$(cat "$SANDBOX_PWA/.next/BUILD_ID" 2>/dev/null)"
    [[ -n "$nb" ]] || die "--next off: the sandbox worktree has no build ($SANDBOX_PWA/.next/BUILD_ID)"
    "$REPO/scripts/two-roots.sh" same "$nb" "$1" && die "--next off: the sandbox worktree build $nb is $1's build too — pick --next <label>"
  else
    resolve "$NEXT_TARGET" >/dev/null || exit 1
    "$REPO/scripts/two-roots.sh" same "$NEXT_TARGET" "$1" && die "--next $NEXT_TARGET is the release being promoted — the next slot needs a different build"
  fi
  say "two-roots: $1 leaves :8443 for :443 — the next slot moves to '$NEXT_TARGET' after a GREEN switch"
  # scripts/test-two-roots.sh: stop right after the law's verdict — nothing switches, nothing restarts
  [[ -z "${PROMOTE_PRECHECK_ONLY:-}" ]] || { say "precheck only: the two-roots law passes for $1"; exit 0; }
}
two_roots_post() {
  if [[ -n "$NEXT_TARGET" ]]; then
    if [[ "$NEXT_TARGET" == off ]]; then "$REPO/scripts/next-slot.sh" off; else "$REPO/scripts/next-slot.sh" on "$NEXT_TARGET"; fi \
      || say "WARNING: the next slot did not move to '$NEXT_TARGET' — scripts/next-slot.sh status"
  fi
  "$REPO/scripts/two-roots.sh" check || say "RED (TWO-ROOTS LAW): live is right, the next slot is not — move it: scripts/next-slot.sh on <newer> | off"
}

# fleet rule 10-28.4: drift-guard exit 0 blocks every FORWARD ship. Going back (--rollback, or a
# --switch to PREVIOUS) never waits on it: the safety net must not depend on the worktrees' state.
drift_gate() {
  "$REPO/scripts/drift-guard.sh" >/tmp/promote-drift.$$ 2>&1 && { rm -f /tmp/promote-drift.$$; return 0; }
  cat /tmp/promote-drift.$$ >&2; rm -f /tmp/promote-drift.$$
  die "drift-guard RED (rule 10-28.4) — port the fix or name the gap in scripts/drift-guard.sh, then promote"
}

# runs in flight on the brain(s) a switch touches: live's and, given $1, the target release's
release_brain() { grep -h '^OPENCODE_URL=' "$1/env/live-pwa.env" 2>/dev/null | cut -d= -f2-; }
in_flight() {
  local b
  for b in $( { release_brain "$BIF/live"; [[ -n "${1:-}" ]] && release_brain "$1"; } | sort -u); do
    curl -s -m 5 "$b/session/status" | python3 -c \
      'import json,sys; print(" ".join(k for k,v in json.load(sys.stdin).items() if (v or {}).get("type")=="busy"))' 2>/dev/null
  done | xargs
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

rollback() {  # live <-> previous: a second --rollback returns to where you were
  local prev
  prev="$(readlink "$BIF/previous" 2>/dev/null)" || die "no previous release to roll back to"
  say "rolling back"
  switch_gated "${prev#releases/}"
}

case "$MODE" in
  units) seed_env; backfill_env; install_units; exit 0 ;;
  list) backfill_env; list_releases; exit 0 ;;
  rollback) backfill_env; [[ -f "$UNITS/lk-pwa.service.d/live.conf" ]] && grep -q 'live/env' "$UNITS/lk-pwa.service.d/live.conf" || install_units; rollback; exit $? ;;
  switch)
    [[ -n "$TARGET" ]] || die "usage: promote.sh --switch <id|label>  (see --list)"
    backfill_env
    grep -q 'live/env' "$UNITS/lk-pwa.service.d/live.conf" 2>/dev/null || install_units
    to="$(resolve "$TARGET")" || exit 1
    # forward (not back to PREVIOUS): drift-guard + the two-roots law first
    [[ "releases/$to" == "$(readlink "$BIF/previous" 2>/dev/null)" ]] || { two_roots_pre "$to"; drift_gate; }
    busy="$(in_flight "$RELS/$to")"
    [[ -z "$busy" || $FORCE == 1 ]] || die "run(s) in flight ($busy) — wait, or --force"
    switch_gated "$to"; exit $? ;;
esac

# --- env-only release: live's frozen build + the current draft env ------------
if ((ENV_ONLY)); then
  seed_env; backfill_env
  src="$(readlink "$BIF/live")" || die "no live release to base an env-only release on"
  src="${src#releases/}"
  [[ -n "$(diff -q "$RELS/$src/env/live-pwa.env" "$ENV_DIR/live-pwa.env"; diff -q "$RELS/$src/env/live-agent.env" "$ENV_DIR/live-agent.env")" ]] \
    || die "draft env in $ENV_DIR equals live's env — nothing to release"
  ID="$(date +%Y%m%d-%H%M)-${src#*-*-}"; ID="${ID%-env*}-env$(cat "$ENV_DIR"/live-pwa.env "$ENV_DIR"/live-agent.env | sha256sum | cut -c1-6)"
  REL="$RELS/$ID"; [[ -e "$REL" ]] && die "$REL exists"
  cp -a --reflink=always "$RELS/$src" "$REL" 2>/dev/null || cp -a "$RELS/$src" "$REL" || die "clone failed"
  chmod -R u+w "$REL/env" && rm -rf "$REL/env" && freeze_env "$REL" || die "env copy failed"
  chmod u+w "$REL/RELEASE.json"
  python3 - "$REL/RELEASE.json" "$ID" "$src" "${LABEL}" <<'EOF'
import json, sys, time
p, rid, src, label = sys.argv[1:]
m = json.load(open(p))
m.update(id=rid, env_of=rid, cloned_from=src, created=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
         label=label or (m.get("label", "") + "+env"))
json.dump(m, open(p, "w"), indent=1)
EOF
  chmod a-w "$REL/RELEASE.json"
  say "built $ID (build of $src, new env $(env_hash "$REL"))"
  ((BUILD_ONLY)) && { say "--build-only: staged, live untouched"; exit 0; }
  drift_gate
  busy="$(in_flight "$REL")"
  [[ -z "$busy" || $FORCE == 1 ]] || die "run(s) in flight ($busy) — wait, or --force (staged at $REL)"
  switch_gated "$ID"; exit $?
fi

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
# env/ before the build: pwa/.env.local -> ../env/live-pwa.env must resolve (next build stats it)
freeze_env "$REL" || die "env copy failed"
link_artifacts "$REL"

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
) > "$LOG" 2>&1
# (never `( set -e … ) || die`: bash ignores set -e inside an || list — a failed next build was staged as built)
(($? == 0)) || die "build failed — see $LOG (live untouched)"
[[ -s "$REL/pwa/.next/BUILD_ID" ]] || die "no .next/BUILD_ID — see $LOG (live untouched)"

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
link_artifacts "$REL"
say "built $ID · build $BUILD_ID · manifest ${MANIFEST:0:12} · env $(env_hash "$REL")"
((BUILD_ONLY)) && { say "--build-only: staged, live untouched"; exit 0; }

# --- switch + gate -------------------------------------------------------------
two_roots_pre "$ID"
drift_gate
busy="$(in_flight "$REL")"
[[ -z "$busy" || $FORCE == 1 ]] || die "run(s) in flight ($busy) — wait, or --force (staged at $REL)"
PREV="$(readlink "$BIF/live" 2>/dev/null || true)"
backfill_env
grep -q 'live/env' "$UNITS/lk-pwa.service.d/live.conf" 2>/dev/null && grep -q 'live/env' "$UNITS/lk-agent.service.d/live.conf" 2>/dev/null || install_units first
if switch_to "$ID" && gate; then
  [[ -n "$PREV" && "$PREV" != "releases/$ID" ]] && ln -sfn "$PREV" "$BIF/previous.new" && mv -Tf "$BIF/previous.new" "$BIF/previous"
  say "OK — live = $ID (previous: ${PREV#releases/})"
  two_roots_post
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
