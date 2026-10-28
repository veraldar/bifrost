#!/usr/bin/env bash
# where.sh — "where am I?" in ONE call (S5 MAIN-CONTEXT, v07-reflection-and-plan F2).
#   what version · what URL · what runs · what do I test next
# Read-only: never builds, restarts, switches or writes (agi-status runs with AGI_STATUS_RO=1).
# Usage: scripts/where.sh [version|url|runs|next|labs|all]     (default all)
#        WHERE_NOGATE=1 skips the gate.py probe (it spawns a LiveKit dispatch probe).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${BIFROST_SANDBOX:-$HOME/Work/bifrost-sandbox}"
cd "$ROOT" || exit 1
MODE="${1:-all}"

hr() { printf '\n== %s ==\n' "$1"; }
code() { curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }
# BUILD_ID a server is actually serving (Next writes it as an html comment on /)
served() { curl -s -m 3 "$1" 2>/dev/null | grep -o '<!--[A-Za-z0-9_-]\{15,25\}-->' | head -1 | sed 's/^<!--//;s/-->$//'; }
host() { grep -o 'tailnet host `[^`]*`' docs/local.md 2>/dev/null | head -1 | cut -d'`' -f2; }

do_version() {
  hr "VERSION"
  local l p
  l="$(scripts/promote.sh --list 2>/dev/null)"
  p="$(echo "$l" | grep '^LIVE')"; echo "stable (frozen)  ${p:-LIVE ?}"
  p="$(echo "$l" | grep '^NEXT')";  [ -n "$p" ] && echo "next slot        $p"
  p="$(echo "$l" | grep '^PREVIOUS')"; echo "rollback target  ${p:-none}"
  local lb sb
  lb="$(served http://127.0.0.1:8080/)"
  echo "  :8080 serves build ${lb:-?}  (release build $(cat ~/.local/share/bifrost/live/pwa/.next/BUILD_ID 2>/dev/null || echo ?))"
  if [ -d "$SANDBOX/.git" ] || [ -f "$SANDBOX/.git" ]; then
    sb="$(served http://127.0.0.1:8090/)"
    echo "sandbox (daily)  $(git -C "$SANDBOX" branch --show-current)@$(git -C "$SANDBOX" rev-parse --short HEAD) · app $(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$SANDBOX/pwa/package.json" | head -1) · $(git -C "$SANDBOX" log -1 --format=%cd --date=format:'%m-%d %H:%M')"
    local built; built="$(cat "$SANDBOX/pwa/.next/BUILD_ID" 2>/dev/null)"
    echo "  :8090 serves build ${sb:-?} · built tree ${built:-none}$([ -n "$sb" ] && [ "$sb" != "$built" ] && echo '  ← MISMATCH: restart bifrost-sandbox (or rebuild)')"
    local dirty; dirty="$(git -C "$SANDBOX" status --porcelain pwa agent 2>/dev/null | wc -l)"
    [ "$dirty" -gt 0 ] && echo "  sandbox tree has $dirty uncommitted pwa/agent path(s)"
  fi
  # the TWO-ROOTS LAW (10-28): :443 and :8443 always serve different builds
  [ -x "$(dirname "$0")/two-roots.sh" ] && echo "  $("$(dirname "$0")/two-roots.sh" check 2>&1)"
  echo "trunk            $(git branch --show-current)@$(git rev-parse --short HEAD) · $(git log -1 --format=%s | cut -c1-70)"
}

do_url() {
  hr "URL"
  local h; h="$(host)"; h="${h:-<tailnet-host>}"
  echo "stable  https://$h        → :8080  lk-pwa + lk-agent (bifrost-live)   $(code http://127.0.0.1:8080/)"
  echo "next    https://$h:8443   → :8090  bifrost-sandbox + lk-agent-ygg (bifrost-ygg)   $(code http://127.0.0.1:8090/)"
  echo "  the user's daily stack is next/:8443. :8443 and :443 are separate origins (own mic/notifications/storage)."
}

do_runs() {
  hr "RUNS"
  local u st pid
  for u in lk-pwa lk-agent opencode-legacy opencode-serve lk-yggdrasil bifrost-sandbox lk-agent-ygg bifrost-bridge; do
    st="$(systemctl --user is-active "$u" 2>/dev/null)"
    pid="$(systemctl --user show -p MainPID --value "$u" 2>/dev/null)"
    printf '  %-17s %-9s pid %s\n' "$u" "$st" "${pid:-0}"
  done
  echo "  ports: :8080 live pwa · :8090 sandbox pwa · :4096 live brain (opencode) · :4100 yggdrasil brain · :7880 LiveKit"
  local p up=""; for p in 8080 8090 4096 4100 7880; do ss -ltnH "sport = :$p" 2>/dev/null | grep -q . && up="$up $p"; done
  echo "  listening:${up:- none}"
  echo "  lanes:"
  AGI_STATUS_RO=1 scripts/agi-status.sh 2>/dev/null | grep -E '^(RUNS TODAY|RUNNING|DEAD)' | sed 's/^/    /' | cut -c1-200
  if [ -z "${WHERE_NOGATE:-}" ]; then
    local g; g="$(timeout 40 python3 scripts/gate.py 2>&1)"
    echo "  gate: $(echo "$g" | grep -E '^GATE ' | tail -1)"
    echo "$g" | grep -E '^\s+FAIL' | sed 's/^ */    /' | cut -c1-160
  fi
}

do_next() {
  hr "NEXT"
  local t=docs/urd/tests.md
  echo "last URD row (newest = bottom of docs/urd/tests.md):"
  grep -E '^\| [0-9]{2}-[0-9]{2} \|' "$t" | tail -1 | awk -F' \\| ' '{printf "  %s %s | %s => %s\n", $1,$2,substr($3,1,110),substr($4,1,60)}' | sed 's/^  | /  /'
  echo "open URD rows (the tests still owed):"
  awk '/^## Open tests/{f=1;next} f&&/^\| [0-9]{2}-[0-9]{2} /' "$t" | awk -F' \\| ' '{printf "  %s %s %s\n", $1,$2,substr($3,1,120)}' | sed 's/^  | /  /'
  echo "claims in flight (docs/claims.md '- [ ]', $(grep -cE '^- \[ \]' docs/claims.md) total; first 6):"
  grep -E '^- \[ \]' docs/claims.md | sed -E 's/^- \[ \] ([^:]*):.*/  \1/' | head -6
  echo "run it against the sandbox (never plain 'npx playwright test' — that targets live :8080):"
  echo "  cd $SANDBOX/pwa && PW_BASE_URL=http://127.0.0.1:8090 npx playwright test e2e/<spec>"
  echo "  jitless session (cat /proc/self/cgroup shows lk-yggdrasil)? see $SANDBOX/AGENTS.md"
}

do_labs() {
  hr "LABS"
  local c l n
  lc() { git log -1 --format='%h %cd' --date=format:%m-%d -- "$@" 2>/dev/null; }
  # worldtree: the one lab with a live loop (timer + run ledger)
  n="$(systemctl --user list-timers worldtree-fetch.timer --no-pager 2>/dev/null | awk 'NR==2{print $1,$2,$3,"(next)"}')"
  l="$(tail -1 lab/worldtree-data/ledger.jsonl 2>/dev/null | python3 -c 'import sys,json
try: d=json.loads(sys.stdin.read()); print("last run",d["run_id"],"health",d["value"],"published",d["published"],"sha_ok",d["published_sha_ok"])
except Exception: print("no ledger line yet")')"
  echo "  worldtree   $(systemctl --user is-enabled worldtree-fetch.timer 2>/dev/null) timer · ${n:-?} · $l"
  echo "  lk-verify   $(systemctl --user is-enabled lk-verify.timer 2>/dev/null) timer · last run: $(systemctl --user show lk-verify.service -p ActiveState --value 2>/dev/null) (failed = RED)"
  c="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c '^ygg-sim$')"
  echo "  ygg-sim     container up=$c · driver: none · last lab commit $(lc lab/ygg-sim)"
  echo "  voice-lab   hand-fed, no driver · newest result $(ls -t ~/Work/voice-lab/results/*.json 2>/dev/null | head -1 | xargs -r stat -c '%y' | cut -c6-10) · its commits: $(git -C ~/Work/voice-lab rev-list --count HEAD 2>/dev/null || echo 0)"
  echo "  bridge      bifrost-bridge $(systemctl --user is-active bifrost-bridge 2>/dev/null) · yggdrasil $(systemctl --user is-active lk-yggdrasil 2>/dev/null) (graduated labs)"
  echo "  dormant     pcb $(lc hardware) · edge $(lc edge) · research-feed $(lc docs/research/research-feed.md) (last commits)"
  echo "registry (docs/labs.md): lab | state | wake trigger | owner"
  awk '/<!-- labs -->/{f=1;next} /<!-- \/labs -->/{f=0} f&&/^\| /&&!/^\| (lab|---)/' docs/labs.md |
    awk -F' \\| ' '{gsub(/^\| /,"",$1); gsub(/ \|$/,"",$4); printf "  %-20s %-60.60s | wake: %-50.50s | %s\n", $1,$2,$3,$4}'
}

case "$MODE" in
  version) do_version ;;
  url)     do_url ;;
  runs)    do_runs ;;
  next)    do_next ;;
  labs)    do_labs ;;
  all|"")  echo "where.sh · $(date '+%F %H:%M')"; do_version; do_url; do_runs; do_next; do_labs ;;
  *) echo "usage: where.sh [version|url|runs|next|labs|all]"; exit 2 ;;
esac
