#!/usr/bin/env bash
# next-slot — serve a FROZEN release in the next slot (:8090 → tailnet :8443), never live.
# The consent check of a release candidate happens here, on the exact build that promote.sh
# will switch live to (same .next, same BUILD_ID), with the NEXT slot's own state and env.
# Born 10-27 (RULER-V07) as the minimal `--slot next` of docs/STABLE.md.
#
#   scripts/next-slot.sh clone <id|label>   clone the release into ~/.local/share/bifrost/next/<id>
#                                           (pwa state + .env.local -> the sandbox tree's; agent venv
#                                           re-synced) — no unit touched
#   scripts/next-slot.sh serve <id|label> [--port P]
#                                           matrix serve: the clone on loopback :P (default 8097) under
#                                           transient units rc-pwa / rc-agent (agent name bifrost-rc),
#                                           brain :4100. Nothing the user uses is touched.
#   scripts/next-slot.sh stop               stop the matrix serve
#   scripts/next-slot.sh on <id|label>      bifrost-sandbox + lk-agent-ygg run the clone (drop-ins),
#                                           restart both, probe :8090 serves the release's BUILD_ID
#   scripts/next-slot.sh off                drop-ins removed, both units back on their worktrees
#   scripts/next-slot.sh status
set -euo pipefail
BIF="$HOME/.local/share/bifrost"; RELS="$BIF/releases"; NEXT="$BIF/next"
UNITS="$HOME/.config/systemd/user"
SANDBOX="$HOME/Work/bifrost-sandbox/pwa"
NODE_BIN="${NODE_BIN:-$HOME/.local/share/mise/installs/node/26.8.1/bin}"
UV="${UV:-$HOME/.local/share/mise/installs/uv/latest/.mise-bins/uv}"
STATE_LINKS=(.diag .push-subs.json .oc-live.json .oc-queue.json .devices.json)
say() { echo "[next-slot] $*"; }
die() { echo "[next-slot] FAIL: $*" >&2; exit 1; }

resolve() {  # id | label -> release dir name
  local q="$1" r
  [[ -d "$RELS/$q" ]] && { echo "$q"; return; }
  for r in "$RELS"/*/; do
    r="$(basename "$r")"
    [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("label",""))' "$RELS/$r/RELEASE.json" 2>/dev/null)" == "$q" ]] && { echo "$r"; return; }
  done
  die "no release '$q' (scripts/promote.sh --list)"
}
build_id() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["build_id"])' "$RELS/$1/RELEASE.json"; }

clone() {  # $1 = release id -> $NEXT/$1 (idempotent)
  local id="$1" c="$NEXT/$1" f
  [[ -s "$RELS/$id/pwa/.next/BUILD_ID" ]] || die "$id has no build"
  if [[ ! -d "$c" ]]; then
    mkdir -p "$NEXT"
    cp -a --reflink=auto "$RELS/$id" "$c.tmp" || die "clone failed"
    chmod -R u+w "$c.tmp"
    # the next slot's state, never live's (the release links them to the trunk repo = live's)
    for f in "${STATE_LINKS[@]}"; do ln -sfn "$SANDBOX/$f" "$c.tmp/pwa/$f"; done
    ln -sfn "$SANDBOX/.env.local" "$c.tmp/pwa/.env.local"
    rm -rf "$c.tmp/env"   # the live env never travels into the next slot
    (cd "$c.tmp/agent" && rm -rf .venv && "$UV" sync --frozen -q) || die "agent venv sync failed"
    mv "$c.tmp" "$c"
  fi
  [[ "$(cat "$c/pwa/.next/BUILD_ID")" == "$(build_id "$id")" ]] || die "clone BUILD_ID differs from the release"
  echo "$c"
}

served_build() {  # $1 = port -> the BUILD_ID the page references
  curl -s -m 5 "http://127.0.0.1:$1/" | grep -o '/_next/static/[A-Za-z0-9_-]\{21\}/' | head -1 | cut -d/ -f4
}
wait_build() {  # port want
  for _ in $(seq 60); do [[ "$(served_build "$1")" == "$2" ]] && return 0; sleep 1; done; return 1
}

cmd="${1:-status}"; shift || true
case "$cmd" in
  clone) id="$(resolve "${1:?release}")"; clone "$id"; say "cloned $id (build $(build_id "$id"))" ;;
  serve)
    id="$(resolve "${1:?release}")"; port=8097; [[ "${2:-}" == "--port" ]] && port="$3"
    [[ "$port" != 8080 && "$port" != 8090 ]] || die "port $port belongs to a real slot"
    c="$(clone "$id")"
    systemctl --user stop rc-pwa rc-agent 2>/dev/null || true
    systemctl --user reset-failed rc-pwa rc-agent 2>/dev/null || true
    # the agent: the clone's code, the next slot's env (lk-agent-ygg's), its own name + health port
    mapfile -t aenv < <(systemctl --user show lk-agent-ygg -p Environment --value | tr ' ' '\n' \
      | grep -E '^(LIVEKIT_URL|LIVEKIT_API_KEY|LIVEKIT_API_SECRET|SPEACHES_URL|STT_MODEL|TTS_MODEL|TTS_VOICE|VOICE_MODEL|AGENT_STREAM_TTS)=' | sed 's/^/--setenv=/')
    systemd-run --user --quiet --unit=rc-agent --collect --working-directory="$c/agent" \
      "${aenv[@]}" --setenv=OPENCODE_URL=http://127.0.0.1:4100 --setenv=AGENT_NAME=bifrost-rc \
      --setenv=AGENT_HTTP_PORT=$((port + 10000)) --setenv=UV_FROZEN=1 \
      "$UV" run agent.py start
    systemd-run --user --quiet --unit=rc-pwa --collect --working-directory="$c/pwa" \
      --setenv=OPENCODE_URL=http://127.0.0.1:4100 --setenv=AGENT_NAME=bifrost-rc --setenv=HOST=127.0.0.1 \
      --setenv=BIFROST_AUTH=tailnet --setenv=YGG_ENV_FILE="$HOME/Work/bifrost/lab/yggdrasil/yggdrasil.env" \
      "$NODE_BIN/node" node_modules/next/dist/bin/next start -p "$port" -H 127.0.0.1
    wait_build "$port" "$(build_id "$id")" || die "rc-pwa :$port does not serve build $(build_id "$id")"
    say "matrix serve: http://127.0.0.1:$port = $id (build $(build_id "$id")), agent bifrost-rc, brain :4100" ;;
  stop) systemctl --user stop rc-pwa rc-agent 2>/dev/null || true; say "matrix serve stopped" ;;
  on)
    id="$(resolve "${1:?release}")"; c="$(clone "$id")"
    ln -sfn "$id" "$NEXT/current.new" && mv -Tf "$NEXT/current.new" "$NEXT/current"
    mkdir -p "$UNITS/bifrost-sandbox.service.d" "$UNITS/lk-agent-ygg.service.d"
    cat > "$UNITS/bifrost-sandbox.service.d/next-slot.conf" <<'EOF'
# scripts/next-slot.sh on: the next slot serves a FROZEN release clone, not the worktree.
# Undo: scripts/next-slot.sh off
[Service]
WorkingDirectory=%h/.local/share/bifrost/next/current/pwa
EOF
    cat > "$UNITS/lk-agent-ygg.service.d/next-slot.conf" <<'EOF'
# scripts/next-slot.sh on: the next slot's agent runs the release clone's agent/ (live parity:
# load threshold = the code's inf, not the lab pin). Undo: scripts/next-slot.sh off
[Service]
WorkingDirectory=%h/.local/share/bifrost/next/current/agent
Environment=UV_FROZEN=1
Environment=AGENT_LOAD_THRESHOLD=
EOF
    systemctl --user daemon-reload
    systemctl --user restart lk-agent-ygg bifrost-sandbox
    wait_build 8090 "$(build_id "$id")" || die ":8090 does not serve $(build_id "$id") — scripts/next-slot.sh off"
    say "ON: :8443 serves $id (build $(build_id "$id")); agent bifrost-ygg from the clone" ;;
  off)
    rm -f "$UNITS/bifrost-sandbox.service.d/next-slot.conf" "$UNITS/lk-agent-ygg.service.d/next-slot.conf"
    systemctl --user daemon-reload
    systemctl --user restart lk-agent-ygg bifrost-sandbox
    say "OFF: bifrost-sandbox + lk-agent-ygg back on their worktrees (:8090 serves $(sleep 3; served_build 8090))" ;;
  status)
    echo "current: $(readlink "$NEXT/current" 2>/dev/null || echo none)"
    for u in bifrost-sandbox lk-agent-ygg rc-pwa rc-agent; do
      printf '  %-16s %-9s cwd %s\n' "$u" "$(systemctl --user is-active "$u" 2>/dev/null)" \
        "$(readlink "/proc/$(systemctl --user show "$u" -p MainPID --value)/cwd" 2>/dev/null || echo -)"
    done
    echo "  :8090 serves $(served_build 8090 || true)" ;;
  *) die "usage: next-slot.sh clone|serve|stop|on|off|status" ;;
esac
