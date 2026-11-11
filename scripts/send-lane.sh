#!/usr/bin/env bash
# send-lane.sh — reliable brain POST for coordinator dispatches (send-reliability-r1).
# A dispatch POST that queues behind lane/owner traffic (per-session run lock) used to be killed with
# the coordinator's 15 s bash cap: the turn might still land (double-send on a naive retry) or die.
#   send-lane.sh -s SESSION -t TAG (-m "text" | -f payload.json|text-file) [-u BRAIN_URL] [-w SECS] [-N]
#   send-lane.sh --resend WILLFILE        (watcher re-send: same request-id)
# Flow: stamp a request-id into the text ("[req-id: X]") → register intent /tmp/send-will/<ts>.json
# (unless -N) → start a DETACHED worker (setsid nohup … </dev/null >log 2>&1 & disown, so no seat/tool
# kill can orphan it) → wait up to -w secs (default 12, under the 15 s cap) for the ack.
# Worker: ≤5 tries, 10 s backoff; each try FIRST reads the session transcript — the brain has no
# idempotency key, but it stores the user message at once, so a user message carrying our req-id means
# the first POST landed (client died) → ack as dup, NEVER re-POST. Ack = a response with a msg_ id.
# Ack file /tmp/acks/<ts>.txt: ts, session, msg id, try#, req-id, mode (post|dup).
# Exit: 0 acked · 3 worker still running (detached; ack will appear) · 1 gave up / bad args.
# Env: BRAIN_URL (default :4100) SEND_WILL_DIR SEND_ACK_DIR SEND_TRIES SEND_BACKOFF SEND_POST_MAX SEND_WAIT
set -u
BRAIN_URL="${BRAIN_URL:-http://127.0.0.1:4100}"
WILL_DIR="${SEND_WILL_DIR:-/tmp/send-will}"
ACK_DIR="${SEND_ACK_DIR:-/tmp/acks}"
TRIES="${SEND_TRIES:-5}"; BACKOFF="${SEND_BACKOFF:-10}"; POST_MAX="${SEND_POST_MAX:-120}"; WAIT="${SEND_WAIT:-12}"
SELF="$(readlink -f "$0")"
mkdir -p "$WILL_DIR" "$ACK_DIR"

jget() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$1" "$2"; }

# newest user message carrying the req-id → prints its msg id (empty = not landed)
landed_id() { # $1 session $2 req-id
  curl -s --max-time 8 "$BRAIN_URL/session/$1/message" | python3 -c '
import json, sys
try: ms = json.load(sys.stdin)
except Exception: sys.exit(0)
for m in reversed(ms if isinstance(ms, list) else []):
    i = m.get("info", {})
    if i.get("role") == "user" and ("[req-id: " + sys.argv[1] + "]") in json.dumps(m.get("parts", [])):
        print(i.get("id", "")); break' "$2" 2>/dev/null
}

worker() { # $1 = will file
  local will="$1" ts sess rid payload n=0 id mode resp
  ts=$(jget "$will" ts); sess=$(jget "$will" session); rid=$(jget "$will" reqid); payload=$(jget "$will" payload)
  BRAIN_URL="${BRAIN_URL_OVERRIDE:-$(jget "$will" brain)}"
  while [ $n -lt "$TRIES" ]; do
    n=$((n + 1)); id=$(landed_id "$sess" "$rid"); mode=dup
    if [ -z "$id" ]; then
      mode=post
      resp=$(curl -s --max-time "$POST_MAX" -X POST "$BRAIN_URL/session/$sess/message" \
        -H 'content-type: application/json' -d @"$payload")
      id=$(grep -oE 'msg_[A-Za-z0-9]+' <<<"$resp" | head -1)
      [ -n "$id" ] || { id=$(landed_id "$sess" "$rid"); mode=dup; }   # client gave up but turn landed?
    fi
    if [ -n "$id" ]; then
      printf 'ts=%s\tsession=%s\tmsg=%s\ttry=%s\treq-id=%s\tmode=%s\tacked=%s\n' \
        "$ts" "$sess" "$id" "$n" "$rid" "$mode" "$(date -Iseconds)" >>"$ACK_DIR/$ts.txt"
      return 0
    fi
    echo "$(date -Iseconds) try $n/$TRIES no ack (resp: ${resp:0:120})"
    [ $n -lt "$TRIES" ] && sleep "$BACKOFF"
  done
  echo "$(date -Iseconds) GAVE UP after $TRIES tries"; return 1
}

detach() { # $1 = will file
  BRAIN_URL_OVERRIDE="$BRAIN_URL" setsid nohup "$SELF" --worker "$1" </dev/null >>"$ACK_DIR/$(basename "$1" .json).log" 2>&1 &
  disown
}

wait_ack() { # $1 = ts, $2 = secs
  local i
  for ((i = 0; i < $2 * 5; i++)); do
    [ -s "$ACK_DIR/$1.txt" ] && { cat "$ACK_DIR/$1.txt"; return 0; }
    sleep 0.2
  done
  return 1
}

case "${1:-}" in
  --worker) worker "$2"; exit $? ;;
  --resend) will="$2"; detach "$will"; echo "re-sent via detached worker: $will"; exit 0 ;;
esac

SESS= TAG= TEXT= FILE= NOWILL=0
while getopts s:t:m:f:u:w:N o; do case $o in
  s) SESS=$OPTARG;; t) TAG=$OPTARG;; m) TEXT=$OPTARG;; f) FILE=$OPTARG;; u) BRAIN_URL=$OPTARG;; w) WAIT=$OPTARG;; N) NOWILL=1;; *) exit 1;; esac; done
[ -n "$SESS" ] && [ -n "$TAG" ] && { [ -n "$TEXT" ] || [ -f "$FILE" ]; } || { sed -n 2,6p "$0" >&2; exit 1; }

TS="$(date -u +%Y%m%dT%H%M%SZ)-$$"; RID="${SEND_REQ_ID:-$(python3 -c 'import uuid;print(uuid.uuid4().hex[:16])')}"
PAYLOAD="$WILL_DIR/$TS.payload.json"; WILLF="$WILL_DIR/$TS.json"
python3 - "$RID" "$TEXT" "${FILE:-}" >"$PAYLOAD" <<'PY'
import json, sys
rid, text, path = sys.argv[1:4]
body = None
if path:
    raw = open(path).read()
    try: body = json.loads(raw)
    except Exception: text = raw
if not isinstance(body, dict) or "parts" not in body:
    body = {"parts": [{"type": "text", "text": text}]}
mark = "\n\n[req-id: %s]" % rid
for p in body["parts"]:
    if p.get("type") == "text":
        p["text"] += mark; break
else:
    body["parts"].insert(0, {"type": "text", "text": mark.strip()})
print(json.dumps(body))
PY
python3 - "$WILLF" "$TS" "$SESS" "$TAG" "$RID" "$PAYLOAD" "$BRAIN_URL" "$NOWILL" <<'PY'
import json, sys, time
f, ts, sess, tag, rid, payload, brain, nowill = sys.argv[1:9]
json.dump({"ts": ts, "epoch": int(time.time()), "session": sess, "tag": tag, "reqid": rid, "payload": payload,
           "brain": brain, "watch": nowill != "1", "resends": 0}, open(f, "w"))
PY
detach "$WILLF"
if wait_ack "$TS" "$WAIT"; then exit 0; fi
echo "send-lane: PENDING ts=$TS tag=$TAG — detached worker running; ack → $ACK_DIR/$TS.txt" >&2
exit 3
