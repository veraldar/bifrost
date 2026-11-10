#!/usr/bin/env bash
# Spec for scripts/metrics.py (S14). Scratch METRICS_DIR; never writes docs/metrics or artifacts.
set -u
cd "$(dirname "$0")/.."
M=scripts/metrics.py
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export METRICS_DIR="$T/metrics"
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS  $1"; }
bad() { fail=$((fail+1)); echo "FAIL  $1 — $2"; }
has() { grep -qF -- "$2" <<<"$3" && ok "$1" || bad "$1" "missing: $2"; }

# 1. regenerate from the JSONL alone: the committed ledger → same table from a copy, no git, no cycle files
cp -r docs/metrics "$T/metrics"
want=$(python3 $M report --all)
rm -rf "$T/metrics/index.jsonl"; python3 $M index
got=$(python3 $M report --all)
[ "$want" = "$got" ] && ok "table regenerates from waves/*.jsonl alone" || bad "regenerate" "tables differ"
has "c7 row" '| `2026-10-07-sim-c7` | 2026-10-07 | ygg-sim: 100.0 % (23/23) | — | sim handsfree_turn: p50 20302 ms (n=1)' "$got"
has "gate 3/8" 'plan.md gate: 3/8' "$got"
has "final suite 57/57" 'general: 100.0 % (57/57)' "$got"
has "lk-verify fails not invented" 'lk-verify: 45 passed (fails n/r)' "$got"
n=$(wc -l < "$T/metrics/index.jsonl"); [ "$n" -ge 27 ] && ok "index has $n waves" || bad "index" "$n waves"

# 2. the block: six rows, missing is said, not zeroed
b=$(python3 $M report --wave 2026-10-07-sim-c7)
[ "$(grep -c '^| ' <<<"$b")" = 7 ] && ok "block = header + six rows" || bad "block rows" "$(grep -c '^| ' <<<"$b")"
has "block says not collected" '| flake rate | — not collected *(needs `--retries=1`' "$b"

# 3. playwright adapter: passed + flaky + unexpected, names kept, flake separated
cat > "$T/pw.json" <<'J'
{"stats":{"expected":8,"unexpected":1,"flaky":1,"skipped":2},
 "suites":[{"title":"base.spec.ts","specs":[
   {"title":"new session","tests":[{"status":"flaky"}]},
   {"title":"wedge","tests":[{"status":"unexpected"}]}],"suites":[]}]}
J
python3 $M append --wave 2026-10-30-t --ts 2026-10-30 --build abc123 --device desktop-chromium --from playwright "$T/pw.json" >/dev/null
r=$(python3 $M report --wave 2026-10-30-t)
has "pw pass rate counts flaky as passed" 'pw: 90.0 % (9/10)' "$r"
has "pw flake rate" 'pw: 10.0 % (1/10)' "$r"
has "pw build+device on the row" '| abc123 | desktop-chromium |' "$r"
grep -q '"failed": \["base.spec.ts wedge"\]' "$T/metrics/waves/2026-10-30-t.jsonl" && ok "pw keeps failing names" || bad "pw names" "$(cat $T/metrics/waves/2026-10-30-t.jsonl | head -c 300)"
python3 $M append --wave 2026-10-30-t --ts 2026-10-30 --build abc123 --device desktop-chromium --from playwright "$T/pw.json" >/dev/null
[ "$(wc -l < $T/metrics/waves/2026-10-30-t.jsonl)" = 2 ] && ok "re-append replaces, never duplicates" || bad "dup" "rows != 2"

# 4. sim adapter on the real cycle-7
python3 $M append --wave 2026-10-30-s --ts 2026-10-30 --build x --device phone-sim --from sim lab/ygg-sim/report/cycles/cycle-7.json >/dev/null 2>&1 \
  && has "sim adapter" 'ygg-sim: 100.0 % (23/23)' "$(python3 $M report --wave 2026-10-30-s)" || bad "sim adapter" "failed"

# 5. voice digest: split by source, dedupe the double-written lines, dup turns out of the percentiles
cat > "$T/diag.log" <<'L'
2026-10-30T10:00:00Z [voice] (/s) voice.turn {"source":"you","run_id":"r1","release_to_transcript":800,"release_to_first_audio":6000,"dup":false}
2026-10-30T10:00:00Z [voice] (/s) voice.turn {"source":"you","run_id":"r1","release_to_transcript":800,"release_to_first_audio":6000,"dup":false}
2026-10-30T10:01:00Z [voice] (/s) voice.turn {"source":"you","run_id":"r2","release_to_transcript":1000,"release_to_first_audio":8000,"dup":false}
2026-10-30T10:02:00Z [voice] (/s) voice.turn {"source":"you","run_id":"r3","release_to_transcript":90000,"release_to_first_audio":90000,"dup":true}
2026-10-30T10:03:00Z [voice] (/s) voice.turn {"source":"e2e","run_id":"r4","release_to_transcript":10447,"release_to_first_audio":10447,"dup":false}
2026-10-30T10:04:00Z [net] 200 7ms POST /api/diag
L
python3 $M append --wave 2026-10-30-v --ts 2026-10-30 --build live1 --device s22 --from voice "$T/diag.log" >/dev/null
v=$(python3 $M report --wave 2026-10-30-v)
has "voice you transcript p50 over n=2" 'you transcript: p50 900 ms / p95 990 ms (n=2)' "$v"
has "voice e2e kept apart from you" 'e2e first_audio: p50 10447 ms (n=1)' "$v"
grep -q '"dup_turns": 1' "$T/metrics/waves/2026-10-30-v.jsonl" && ok "dup turn counted, not averaged" || bad "dup" "no dup_turns"
: > "$T/empty.log"
out=$(python3 $M append --wave 2026-10-30-e --ts 2026-10-30 --build live1 --device s22 --from voice "$T/empty.log" 2>&1)
has "no voice.turn lines → loud no-op" 'found nothing' "$out"
[ ! -e "$T/metrics/waves/2026-10-30-e.jsonl" ] && ok "no empty wave written" || bad "empty wave" "file exists"

# 6. agi adapter: counts per day, statuses kept
printf 'id1\t2026-10-30\tL\tsonnet\ta\tb\t1800\t0\tOK\tout\t-\nid2\t2026-10-30\tL2\tsonnet\ta\tb\t600\t1\tFAIL\tout\t-\nid3\t2026-10-30\tL3\tsonnet\ta\t-\t-\t-\tRUNNING\tout\t-\n' > "$T/log.tsv"
python3 $M append --wave ignored --ts 2026-10-30 --from agi "$T/log.tsv" --build n/a --device box >/dev/null
grep -q '"num": 1' "$T/metrics/waves/agi-2026-10-30.jsonl" && grep -q '"den": 2' "$T/metrics/waves/agi-2026-10-30.jsonl" && ok "agi: RUNNING excluded, 1/2 OK" || bad "agi" "$(cat $T/metrics/waves/agi-2026-10-30.jsonl)"

# 7. report --check: opens with the block, or exit 1
{ echo "# Title"; echo; python3 $M report --wave 2026-10-30-t; echo; echo "body"; } > "$T/r_ok.md"
printf '# Title\n\nno block here\n' > "$T/r_bad.md"
python3 $M report --wave 2026-10-30-t --check "$T/r_ok.md" >/dev/null && ok "check passes on a report that opens with the block" || bad "check ok" "exit != 0"
python3 $M report --wave 2026-10-30-t --check "$T/r_bad.md" >/dev/null 2>&1 && bad "check bad" "exit 0" || ok "check fails on a report without it"

# 8. validation + chart
python3 $M append --wave w --ts 2026-10-30 --build b --device d --metric nonsense --value 1 >/dev/null 2>&1 && bad "validate" "accepted unknown metric" || ok "unknown metric refused"
python3 $M append --wave w --ts 2026-10-30 --metric gate_green --value 1 >/dev/null 2>&1 && bad "validate" "accepted row without build/device" || ok "row without build+device refused"
python3 $M month 2026-10 --svg "$T/m.svg" >/dev/null 2>&1
python3 -c "import sys,xml.dom.minidom as m;m.parse(sys.argv[1])" "$T/m.svg" && grep -q 'target 8 s' "$T/m.svg" && ok "month chart is valid SVG with the 8 s target" || bad "svg" "invalid"

echo; [ $fail = 0 ] && echo "metrics spec GREEN ($pass/$pass)" || echo "metrics spec RED ($fail failed, $pass passed)"
exit $((fail>0))
