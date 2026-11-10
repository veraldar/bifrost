#!/usr/bin/env bash
# nous-sim.sh — fake-nous harness: synthetic user driving k missions through MAIN+sub
# coordination. Async arm = detached subjobs (MAIN polls status.tsv); sync arm = the
# same missions inline. Numbers land in run-<ts>.tsv; report built by report.sh.
set -euo pipefail
LAB="$(cd "$(dirname "$0")" && pwd)"
ROOT="http://127.0.0.1:4100"
PARENT="ses_770b899884cf47718e054f6f2702630c"
TS=$(date +%Y%m%d-%H%M%S)
RUN="$LAB/run-$TS"; mkdir -p "$RUN" "$LAB/reports"
STATUS="$LAB/status.tsv"; : > "$STATUS"
nowms() { date +%s%3N; }

# ---- fake nous: k real missions (small, verifiable) -------------------------
PROMPTS_DIR="$RUN/prompts"; mkdir -p "$PROMPTS_DIR"
cat > "$PROMPTS_DIR/brand-banned-words" <<'EOF'
Read docs/brand/brand.md in this repo (~/Work/bifrost) and list the words brand
copy must never say. Answer with ONLY the comma-separated list, nothing else.
EOF
cat > "$PROMPTS_DIR/commit-types" <<'EOF'
Run: git -C ~/Work/bifrost log --oneline -40
Count how many of the last 40 commits start with each leading type word (the
first token before a colon or space, e.g. "docs", "drift-guard"). Answer ONLY
the top 2 as "type=count, type=count", nothing else.
EOF
cat > "$PROMPTS_DIR/versions-v6" <<'EOF'
Read ~/Work/bifrost/VERSIONS.md and summarize section v6 in exactly 3 bullets.
Answer with ONLY the 3 bullets, nothing else.
EOF
SLUGS=(brand-banned-words commit-types versions-v6)

mk_session() { # -> sessionID on stdout
  curl -s -m 10 -X POST "$ROOT/session" -H 'Content-Type: application/json' \
    -d "{\"title\":\"nous-sim $1\",\"parentID\":\"$PARENT\"}" | jq -r .id
}

log_row() { # arm|slug|spawn_ms|blocking_ms|wall_ms|outcome|answer_bytes|prompt_bytes
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >> "$RUN/results.tsv"
}

# ---- ASYNC arm: MAIN claims light, subs detached, MAIN polls status ---------
echo "== ASYNC arm =="
for slug in "${SLUGS[@]}"; do
  T0=$(nowms)
  SID=$(mk_session "$slug-async")
  CREATE_MS=$(( $(nowms) - T0 ))
  [ -n "$SID" ] && [ "$SID" != "null" ] || { log_row async "$slug" "$CREATE_MS" "n/a" "n/a" "SPAWN_FAIL" "-" "-"; continue; }

  # fire-and-forget: detached sub, generous timeout, MAIN returns at once
  nohup "$LAB/subjob.sh" "$SID" "$slug" "$PROMPTS_DIR/$slug" "$LAB/reports" "$STATUS" "$T0" \
    </dev/null >>"$RUN/subjobs.log" 2>&1 &
  SPAWN_MS=$(( $(nowms) - T0 ))                       # MAIN's total claim cost
  echo "  $slug spawned in ${SPAWN_MS}ms (create ${CREATE_MS}ms) -> $SID"

  # MAIN polls the status file, watchdog 240s, never hangs on the sub
  WDEADLINE=$(( $(nowms) + 240000 ))
  while [ "$(grep -c "^$slug|" "$STATUS" 2>/dev/null)" -eq 0 ]; do
    [ "$(nowms)" -lt "$WDEADLINE" ] || break
    sleep 1
  done
  WD_MS=$(( $(nowms) - T0 ))
  LINE=$(grep "^$slug|" "$STATUS" || true)
  OUTCOME=$(printf '%s' "$LINE" | cut -d'|' -f2); [ -n "$OUTCOME" ] || OUTCOME=TIMEOUT
  WALL=$(printf '%s' "$LINE" | cut -d'|' -f3); [ -n "$WALL" ] || WALL="$WD_MS"
  AB=$(printf '%s' "$LINE" | cut -d'|' -f4); [ -n "$AB" ] || AB=0
  PB=$(wc -c < "$PROMPTS_DIR/$slug")
  log_row async "$slug" "$SPAWN_MS" "0" "$WALL" "$OUTCOME" "$AB" "$PB"
done

# wait for any stragglers to finish writing (up to the watchdog window)
for i in $(seq 1 240); do
  [ "$(grep -c '|' "$STATUS" 2>/dev/null)" -ge "${#SLUGS[@]}" ] && break
  sleep 1
done

# ---- SYNC arm: identical missions, blocking POST (the counterfactual) -------
echo "== SYNC arm =="
for slug in "${SLUGS[@]}"; do
  T0=$(nowms)
  SID=$(mk_session "$slug-sync")
  CREATE_MS=$(( $(nowms) - T0 ))
  RESP=$(curl -s -m 240 -X POST "$ROOT/session/$SID/message" \
    -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":$(jq -Rs . < "$PROMPTS_DIR/$slug")}]}")
  RC=$?
  BLOCK_MS=$(( $(nowms) - T0 ))
  if [ $RC -ne 0 ] || [ -z "$RESP" ]; then
    log_row sync "$slug" "$CREATE_MS" "$BLOCK_MS" "$BLOCK_MS" "TIMEOUT" "0" "$(wc -c < "$PROMPTS_DIR/$slug")"; continue
  fi
  TEXT=$(printf '%s' "$RESP" | jq -r '[.parts[]? | select(.type=="text") | .text] | join("\n")')
  log_row sync "$slug" "$CREATE_MS" "$BLOCK_MS" "$BLOCK_MS" done \
    "$(printf '%s' "$TEXT" | wc -c)" "$(wc -c < "$PROMPTS_DIR/$slug")"
done

echo "== run complete: $RUN/results.tsv =="
column -t -s$'\t' "$RUN/results.tsv"
