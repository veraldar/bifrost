#!/usr/bin/env bash
# pair.sh — pair a phone with this box from the terminal (also: install.sh pair …). No browser needed here.
#
#   ./pair.sh [NAME]          a one-time pairing QR (5 minutes, one use) in this terminal + a PNG; scan it with
#                             the phone's camera. It opens BIFROST_PUBLIC_URL/pair (your trunk's https address, or
#                             this box on the LAN) and pins this box's key. NAME labels the phone (default: phone).
#   ./pair.sh --list          the paired devices (id, name, region, last seen, revoked?)
#   ./pair.sh --revoke ID|NAME   revoke one device: its next call is refused, live connections are cut within ~1 s
#   ./pair.sh --kill          revoke EVERY device and burn every unused QR (lost phone, unsure which). Asks first.
#   --png FILE                where the QR picture goes (default ~/.local/state/bifrost/pair-qr.png, mode 600)
#   --open                    also show the PNG on this screen
#
# It talks to the app on this box (127.0.0.1) with the admin token install.sh generated — both read from
# the app's own env file, ~/.config/bifrost/app.env.
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "$0")" && pwd)
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
STATE_HOME=${XDG_STATE_HOME:-$HOME/.local/state}
APP_ENV=${BIFROST_APP_ENV:-$CONFIG_HOME/bifrost/app.env}

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit "${2:-1}"; }

ACTION=qr NAME='' ID='' PNG='' OPEN=0 YES=0
while [ $# -gt 0 ]; do
  case $1 in
    --list) ACTION=list ;;
    --revoke) [ -n "${2:-}" ] || die "--revoke ID or NAME (see --list)" 64; ACTION=revoke; ID=$2; shift ;;
    --kill) ACTION=killall ;;
    --png) [ -n "${2:-}" ] || die "--png FILE" 64; PNG=$2; shift ;;
    --open) OPEN=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" 64 ;;
    *) NAME=$1 ;;
  esac
  shift
done

[ -f "$APP_ENV" ] || die "no $APP_ENV — install the stack first: ./install.sh"
envget() { sed -n "s/^$1=//p" "$APP_ENV" | tail -1; }
PORT=$(envget PORT) HOST=$(envget HOST) TOKEN=$(envget BIFROST_ADMIN_TOKEN)
case $HOST in ''|0.0.0.0|::|127.0.0.1) HOST=127.0.0.1 ;; esac
APP=http://$HOST:${PORT:-8082}
[ -n "$TOKEN" ] || die "no BIFROST_ADMIN_TOKEN in $APP_ENV — re-run ./install.sh"
PY=$(command -v python3 || true)
[ -n "$PY" ] || die "python3 is needed (Debian/Ubuntu: sudo apt install python3)"

api() { # METHOD PATH [JSON] → body on stdout; fails with the app's own words
  local out code
  out=$(mktemp); trap 'rm -f "$out"' RETURN
  code=$(curl -s -m 15 -o "$out" -w '%{http_code}' -X "$1" "$APP$2" -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' ${3:+--data "$3"} || true)
  case $code in
    2??) cat "$out" ;;
    000) die "the app on this box ($APP) does not answer — is it running? (systemctl --user status bifrost-app)" ;;
    *) die "the app answered $code on $2: $(head -c 300 "$out")" ;;
  esac
}
json() { "$PY" -c "import json,sys; d=json.load(sys.stdin); $1"; }

case $ACTION in
  qr)
    NAME=${NAME:-phone}
    J=$(api POST /api/pair/code "$(printf '{"name":%s}' "$("$PY" -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$NAME")")")
    URL=$(printf '%s' "$J" | json 'print(d["url"])')
    PNG=${PNG:-$STATE_HOME/bifrost/pair-qr.png}
    mkdir -p "$(dirname "$PNG")"
    QRARGS=(qr "$URL" --png "$PNG")
    "$PY" "$HERE/rootjoin.py" "${QRARGS[@]}"
    chmod 600 "$PNG"
    [ $OPEN = 1 ] && { command -v xdg-open >/dev/null && xdg-open "$PNG" >/dev/null 2>&1 & } || true
    echo
    say "scan it with the phone's camera within 5 minutes (one use) — it opens ${URL%%#*}"
    say "the same QR as a picture: $PNG"
    W=$(printf '%s' "$J" | json 'print(d.get("warning") or "")')
    [ -z "$W" ] || printf '    note: %s\n' "$W"
    case $URL in http://*) say "plain http: the phone must be on this box's Wi-Fi (a trunk gives https from anywhere: docs/own-trunk.md)" ;; esac
    ;;
  list)
    api GET /api/pair | json '
def t(iso): return (iso or "-").replace("T", " ")[:16]
devs = d.get("devices", d if isinstance(d, list) else [])
print("%-22s %-16s %-24s %-16s %s" % ("ID", "NAME", "REGION", "LAST SEEN", "STATE"))
for x in devs:
    st = ("revoked" + (" (" + x["revokedWhy"] + ")" if x.get("revokedWhy") else "")) if x.get("revoked") else "active"
    print("%-22s %-16s %-24s %-16s %s" % (x.get("id",""), (x.get("name") or "")[:16], (x.get("region") or "-")[:24], t(x.get("lastSeen")), st))
if not devs: print("(no devices paired yet: ./pair.sh)")'
    ;;
  revoke)
    LIST=$(api GET /api/pair)
    DEV=$(printf '%s' "$LIST" | ID="$ID" json '
import os
want = os.environ["ID"]
devs = d.get("devices", d if isinstance(d, list) else [])
hit = [x for x in devs if x.get("id") == want] or [x for x in devs if x.get("name") == want and not x.get("revoked")]
print(hit[0]["id"] if len(hit) == 1 else ("AMBIGUOUS" if hit else ""))')
    [ -n "$DEV" ] || die "no device '$ID' — see ./pair.sh --list"
    [ "$DEV" != AMBIGUOUS ] || die "several devices are named '$ID' — revoke by ID (./pair.sh --list)"
    api DELETE /api/pair/devices "{\"id\":\"$DEV\"}" >/dev/null
    say "revoked $DEV — its next call is refused; a live connection is cut within a second"
    ;;
  killall)
    if [ $YES = 0 ]; then
      [ -t 0 ] || die "--kill revokes every device: add --yes to do it without a question"
      read -r -p "revoke EVERY paired device and every unused QR? [y/N] " a
      case $a in y|Y|yes) ;; *) die "nothing done" ;; esac
    fi
    api POST /api/pair/kill >/dev/null
    say "every device revoked, every pairing code burned. Pair again: ./pair.sh"
    ;;
esac
