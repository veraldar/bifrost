#!/usr/bin/env bash
# test-two-roots — the TWO-ROOTS LAW guard, hermetic (10-28, PROVIDER-WAVE item 4).
# Fake releases dir (BIFROST_HOME), fake unit dir (BIFROST_UNITS), two tiny /api/build servers on
# scratch ports standing in for :8080 / :8090. Nothing real is read for a verdict, nothing restarts:
# every promote.sh run either dies at the law or stops at PROMOTE_PRECHECK_ONLY (before drift-guard,
# before any switch). Cases: check OK / COLLAPSED (same BUILD_ID, and a rebuild of the same source) /
# UNKNOWN; next-slot.sh on live's build refused with no side effect; promote of the consent build
# without --next refused; --next = the same release / an off-tree with the same build refused; a
# rollback-direction --switch is never blocked by the law; the good path passes the precheck.
set -uo pipefail
cd "$(dirname "$0")/.."
LP=4151; NP=4152
for p in $LP $NP; do ss -ltn "sport = :$p" | grep -q LISTEN && { echo "FAIL: port $p held"; exit 1; }; done
T=$(mktemp -d); PIDS=()
trap 'kill ${PIDS[@]} 2>/dev/null; rm -rf $T' EXIT
export BIFROST_HOME=$T/bif BIFROST_UNITS=$T/units BIFROST_SANDBOX_PWA=$T/sandbox/pwa
export TWO_ROOTS_LIVE_URL=http://127.0.0.1:$LP TWO_ROOTS_NEXT_URL=http://127.0.0.1:$NP
mkdir -p $T/bif/releases $T/units/lk-pwa.service.d $T/units/lk-agent.service.d $T/sandbox/pwa/.next
echo 'EnvironmentFile=%h/.local/share/bifrost/live/env/live-pwa.env' >$T/units/lk-pwa.service.d/live.conf
echo 'EnvironmentFile=%h/.local/share/bifrost/live/env/live-agent.env' >$T/units/lk-agent.service.d/live.conf
rel() { # id label source build
  mkdir -p $T/bif/releases/$1/env $T/bif/releases/$1/pwa/.next
  printf '{"id":"%s","label":"%s","source":"%s","build_id":"%s"}\n' "$1" "$2" "$3" "$4" >$T/bif/releases/$1/RELEASE.json
  echo "$4" >$T/bif/releases/$1/pwa/.next/BUILD_ID
  : >$T/bif/releases/$1/env/live-pwa.env; : >$T/bif/releases/$1/env/live-agent.env
}
rel R1-live vL aaa1111 B-LIVE
rel R2-next vN bbb2222 B-NEXT
rel R3-rebuild vR aaa1111 B-REBUILD   # live's source, built again
rel R0-prev vP ccc3333 B-PREV
ln -s releases/R1-live $T/bif/live; ln -s releases/R0-prev $T/bif/previous
serve() { # port idfile
  python3 - "$1" "$2" <<'PY' & PIDS+=($!)
import http.server, json, sys
port, f = int(sys.argv[1]), sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = json.dumps({"id": open(f).read().strip()}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
}
echo B-LIVE >$T/live.id; echo B-NEXT >$T/next.id
serve $LP $T/live.id; serve $NP $T/next.id
for _ in $(seq 50); do curl -sf -o /dev/null http://127.0.0.1:$NP/api/build && curl -sf -o /dev/null http://127.0.0.1:$LP/api/build && break; sleep 0.1; done
N=0; FAILS=0
ok() { N=$((N+1)); echo "PASS $N: $1"; }
bad() { FAILS=$((FAILS+1)); echo "FAIL: $1"; }
expect() { # want-exit description cmd...
  local want=$1 d=$2; shift 2; local out rc; out=$("$@" 2>&1); rc=$?
  [ "$rc" = "$want" ] && ok "$d" || { bad "$d (exit $rc, want $want)"; echo "$out" | tail -5; }
  LAST="$out"
}

expect 0 "check: live B-LIVE / next B-NEXT → OK" scripts/two-roots.sh check
echo B-LIVE >$T/next.id
expect 1 "check: both serve B-LIVE → COLLAPSED" scripts/two-roots.sh check
echo B-REBUILD >$T/next.id
expect 1 "check: next = a REBUILD of live's source (other BUILD_ID, same commit) → COLLAPSED" scripts/two-roots.sh check
kill ${PIDS[1]}; wait ${PIDS[1]} 2>/dev/null
expect 2 "check: the next slot does not answer → UNKNOWN (exit 2, never a silent OK)" scripts/two-roots.sh check
echo B-NEXT >$T/next.id; serve $NP $T/next.id
for _ in $(seq 50); do curl -sf -o /dev/null http://127.0.0.1:$NP/api/build && break; sleep 0.1; done

expect 1 "guard next vL (live's release) → would collapse" scripts/two-roots.sh guard next vL
expect 1 "guard next vR (live's source rebuilt) → would collapse" scripts/two-roots.sh guard next vR
expect 0 "guard next vN → fine" scripts/two-roots.sh guard next vN
expect 1 "guard live vN while :8443 serves vN (the consent flow) → would collapse" scripts/two-roots.sh guard live vN

expect 1 "next-slot.sh on vL (live's build) → REFUSED" scripts/next-slot.sh on vL
echo "$LAST" | grep -q "refused" || bad "next-slot refusal does not say refused"
[ ! -e $T/bif/next ] && [ ! -e $T/units/bifrost-sandbox.service.d/next-slot.conf ] \
  && ok "the refusal happened before any side effect (no clone, no drop-in)" || bad "next-slot refused AFTER side effects"

expect 1 "promote.sh --switch vN while :8443 serves it, no --next → REFUSED before anything moves" scripts/promote.sh --switch vN
echo "$LAST" | grep -q -- "--next" || bad "the refusal does not name --next"
[ "$(readlink $T/bif/live)" = releases/R1-live ] && ok "live untouched by the refusal" || bad "live moved"
expect 1 "promote.sh --switch vN --next vN (same release) → REFUSED" scripts/promote.sh --switch vN --next vN
echo B-NEXT >$T/sandbox/pwa/.next/BUILD_ID
expect 1 "promote.sh --switch vN --next off while the sandbox tree is built at B-NEXT → REFUSED" scripts/promote.sh --switch vN --next off
echo B-SANDBOX >$T/sandbox/pwa/.next/BUILD_ID
expect 0 "promote.sh --switch vN --next off (sandbox tree at B-SANDBOX) → the law passes" env PROMOTE_PRECHECK_ONLY=1 scripts/promote.sh --switch vN --next off
expect 0 "promote.sh --switch vN --next vR → the law passes (vR ≠ vN)" env PROMOTE_PRECHECK_ONLY=1 scripts/promote.sh --switch vN --next vR
echo B-OTHER >$T/next.id
expect 0 "promote.sh --switch vN when :8443 serves something else → no --next needed" env PROMOTE_PRECHECK_ONLY=1 scripts/promote.sh --switch vN
echo B-PREV >$T/next.id
grep -q 'two_roots_pre "$to"; drift_gate; }' scripts/promote.sh && grep -q 'releases/$to" == "$(readlink "$BIF/previous"' scripts/promote.sh \
  && ok "back to PREVIOUS (rollback direction) skips the pre-check by construction — the safety net is never refused" \
  || bad "the rollback path is no longer exempt"
grep -q 'two_roots_post' scripts/promote.sh && [ "$(grep -c 'two_roots_post$' scripts/promote.sh)" -ge 2 ] \
  && ok "every GREEN switch path (switch_gated + the build path) re-checks the law out loud" || bad "a switch path lacks two_roots_post"

echo
[ $FAILS = 0 ] && { echo "two-roots guard: ALL $N PASS"; exit 0; } || { echo "two-roots guard: $FAILS FAIL"; exit 1; }
