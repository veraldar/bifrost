#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
# 16: the REAL freshly built yggdrasil binary on a scratch store + the lab's mock upstream:
# a marked post with a >800-char reply gets the [auto-verdict] line; <=800 chars does not;
# an unmarked post with a long reply does not either (metadata-gated).
case_init 16 "[auto-verdict] line through the real brain binary"
BIN="$REPO/lab/yggdrasil/target/release/yggdrasil"; UP=$((PORT + 100))
[ -x "$BIN" ] || { echo "    FAIL no release binary (cargo build --release in lab/yggdrasil)"; FAILS=1; case_end; exit 1; }
spawn python3 "$REPO/lab/yggdrasil/mock/mock_upstream.py" "$UP"
YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$UP/v1" YGG_UPSTREAM_MODEL=mock YGG_DATA_DIR="$CD/ygg" \
  YGG_LISTEN="127.0.0.1:$((PORT + 200))" spawn "$BIN"
Y="http://127.0.0.1:$((PORT + 200))"
wait_for 15 "curl -sf $Y/session >/dev/null"
SID=$(curl -sf -X POST $Y/session -H 'content-type: application/json' -d '{"title":"sim"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
ask() { # $1 prefix, $2 reply length -> last text of the assistant reply
  python3 - "$Y" "$SID" "$1" "$2" <<'PY'
import json, sys, urllib.request
y, sid, pre, n = sys.argv[1:5]
body = "Green." + "x" * (int(n) - 6)   # mock echoes one whitespace-free token
req = urllib.request.Request(f"{y}/session/{sid}/message", method="POST", headers={"content-type": "application/json"},
    data=json.dumps({"parts": [{"type": "text", "text": f"{pre}reply with exactly: {body}"}]}).encode())
m = json.load(urllib.request.urlopen(req, timeout=60))
print([p["text"] for p in m["parts"] if p["type"] == "text"][-1])
PY
}
LONG=$(ask "AUTO-VERDICT REQUEST: " 1000); SHORT=$(ask "AUTO-VERDICT REQUEST: " 500); PLAIN=$(ask "" 1000)
check "long-marked-has-verdict-line" '[[ "$LONG" == *"[auto-verdict] Green."* ]]'
check "short-marked-unchanged" '[[ "$SHORT" != *"[auto-verdict]"* ]]'
check "long-unmarked-unchanged" '[[ "$PLAIN" != *"[auto-verdict]"* ]]'
META=$(curl -sf $Y/session/$SID/message | python3 -c 'import sys,json;print(sum(1 for m in json.load(sys.stdin) if m["info"].get("meta",{}).get("auto")))')
check "meta.auto-stored-on-2-user-msgs(got $META)" '[ "$META" = 2 ]'
SIG_SUMMARY="long+marked: line; short / unmarked: none"
case_end
