#!/usr/bin/env bash
# subjob.sh — the detached SUB. Runs one mission to completion, then reports.
# usage: subjob.sh <sessionID> <slug> <promptfile> <reports_dir> <status_tsv> <t_fire_ms>
set -u
SID="$1"; SLUG="$2"; PROMPT="$3"; REPORTS="$4"; STATUS="$5"; T_FIRE="$6"
ROOT="http://127.0.0.1:4100"
nowms() { date +%s%3N; }

T0=$(nowms)
RESP=$(curl -s -m 230 -X POST "$ROOT/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":$(jq -Rs . < "$PROMPT")}]}")
RC=$?
WALL=$(( $(nowms) - T0 ))

if [ $RC -ne 0 ] || [ -z "$RESP" ]; then
  echo "$SLUG|TIMEOUT|$WALL|n/a" >> "$STATUS"
  printf '# %s — subjob rc=%s after %sms\n' "$SLUG" "$RC" "$WALL" > "$REPORTS/$SLUG.md"
  exit 1
fi

TEXT=$(printf '%s' "$RESP" | jq -r '[.parts[]? | select(.type=="text") | .text] | join("\n")')
ANSWER_BYTES=$(printf '%s' "$TEXT" | wc -c)
PROMPT_BYTES=$(wc -c < "$PROMPT")

{
  echo "# $SLUG — sub answer"
  echo "- session: $SID"
  echo "- wall_ms: $WALL (fired at $T_FIRE)"
  echo "- bytes: prompt=$PROMPT_BYTES answer=$ANSWER_BYTES"
  echo
  echo '```'
  printf '%s\n' "$TEXT"
  echo '```'
} > "$REPORTS/$SLUG.md"

# record only if MAIN's watchdog hasn't already timed us out
grep -q "^$SLUG|" "$STATUS" || echo "$SLUG|done|$WALL|$ANSWER_BYTES" >> "$STATUS"
