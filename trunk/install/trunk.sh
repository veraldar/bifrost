#!/usr/bin/env bash
# trunk.sh — your own trunk on a small rented server (a VPS): the public address your phone and your other
# computers reach. Your home computer (the hub) dials OUT to it; nothing at home opens a port.
#
#   sudo bash trunk.sh --name trunk.example.org   first run: install, certificate, start, print the CONNECT LINE
#   sudo bash trunk.sh                             re-run: upgrade the binary, renew the certificate if due, keep
#                                                  the key (= the pin your hub trusts) and the hub's token
#   sudo bash trunk.sh --rotate-token              a NEW connect line (the old token stops working at once)
#
#   --name NAME          the server's DNS name (an A/AAAA record pointing at this server). Needed once.
#   --version vX.Y.Z     which release of github.com/veraldar/yggdrasil (default: the latest)
#   --binary FILE        use this bifrost-net binary instead of downloading one
#   --port N             where the access point listens: 443 (default) — or, with --behind-proxy, the
#                        loopback port your :443 router forwards to (default 4443)
#   --behind-proxy       :443 already serves a website: listen on 127.0.0.1:<port>, read the client's real
#                        address from a PROXY v1 line, and print how to route the trunk's name to it
#   --self-signed        no Let's Encrypt (tests, LAN). Phones show a warning; the hub's pin works the same.
#   --webroot DIR        Let's Encrypt through the web server that holds port 80 (it serves DIR at
#                        http://NAME/.well-known/acme-challenge/). Without it, port 80 must be free.
#   --email ADDR         tell Let's Encrypt who you are (expiry mails). Default: no address.
#   --acme-server URL    another ACME server (default Let's Encrypt production; tests use Pebble)
#   --renew [--force]    certificate only (what the daily timer runs)
#   -y                   don't ask before installing packages with apt
#
# Debian 12+ / Ubuntu 22.04+ with systemd. Runs as the admin user (sudo). Files:
#   /etc/yggdrasil-trunk/key.pem      the access point's private key (600): made ONCE, kept forever — the pin
#                                     your hub trusts is its fingerprint, so certificate renewals never break it
#   /etc/yggdrasil-trunk/cert.pem     the certificate (Let's Encrypt, made from that key with certbot --csr)
#   /etc/yggdrasil-trunk/ap.toml      the access point's config: only the SHA-256 of the hub's token, no secret
#   /etc/yggdrasil-trunk/trunk.conf   what you chose (name, port, mode) — re-runs read it
#   /usr/local/lib/yggdrasil-trunk/   bifrost-net (+ sni-443.py with --behind-proxy)
#   yggdrasil-trunk.service           the access point (DynamicUser; gets a copy of the key in its private /run dir)
#   yggdrasil-trunk-cert.timer        daily: renews the certificate when a third of its life is left
set -euo pipefail
umask 022

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit "${2:-1}"; }

ARGS=("$@")
NAME='' VERSION='' BINARY='' PORT='' BEHIND='' CERTMODE='' WEBROOT='' EMAIL='' ACME=''
ROTATE=0 RENEW=0 FORCE=0 YES=0
need() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" 64; }
while [ $# -gt 0 ]; do
  case $1 in
    --name) need "$@"; NAME=$2; shift ;;
    --version) need "$@"; VERSION=$2; shift ;;
    --binary) need "$@"; BINARY=$2; shift ;;
    --port) need "$@"; PORT=$2; shift ;;
    --behind-proxy) BEHIND=1 ;;
    --direct) BEHIND=0 ;;
    --self-signed) CERTMODE=self-signed ;;
    --acme) CERTMODE=acme ;;
    --webroot) need "$@"; WEBROOT=$2; CERTMODE=acme; shift ;;
    --email) need "$@"; EMAIL=$2; shift ;;
    --acme-server) need "$@"; ACME=$2; CERTMODE=acme; shift ;;
    --rotate-token) ROTATE=1 ;;
    --renew) RENEW=1 ;;
    --force) FORCE=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" 64 ;;
  esac
  shift
done

# ------------------------------------------------------------------------------------ the server
if [ "$(id -u)" != 0 ]; then
  command -v sudo >/dev/null || die "run this as the admin user (root): it installs a system service"
  case $0 in /*|./*|../*) exec sudo -- bash "$0" "${ARGS[@]}" ;; *) exec sudo -- bash "./$0" "${ARGS[@]}" ;; esac
fi
[ -d /run/systemd/system ] || die "this server does not run systemd (needed for the service and the renewal timer)"
HERE=$(cd "$(dirname "$0")" && pwd)
ETC=/etc/yggdrasil-trunk
LIB=/usr/local/lib/yggdrasil-trunk
VAR=/var/lib/yggdrasil-trunk
CONF=$ETC/trunk.conf
KEY=$ETC/key.pem
CERT=$ETC/cert.pem
APTOML=$ETC/ap.toml
BIN=$LIB/bifrost-net
SELF=/usr/local/sbin/yggdrasil-trunk
UNIT=yggdrasil-trunk.service
UNIT_FILE=/etc/systemd/system/$UNIT
RELEASES=${TRUNK_RELEASES:-https://github.com/veraldar/yggdrasil/releases}
RAW=${TRUNK_RAW:-https://raw.githubusercontent.com/veraldar/yggdrasil}
CHANGED=0

confget() { [ -f "$CONF" ] && sed -n "s/^$1=//p" "$CONF" | tail -1 || true; }
NAME=${NAME:-$(confget NAME)}
[ -n "$NAME" ] || die "which name? sudo bash trunk.sh --name trunk.example.org  (a DNS name that points at this server)" 64
NAME=$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')
NAME=${NAME%.}
case $NAME in
  *[!a-z0-9.-]*|.*|-*|'') die "--name: '$NAME' is not a host name (letters, digits, dots, dashes) or an IPv4 address" 64 ;;
esac
IS_IP=0; case $NAME in *[!0-9.]*) ;; *) IS_IP=1 ;; esac
BEHIND=${BEHIND:-$(confget BEHIND_PROXY)}; BEHIND=${BEHIND:-0}
CERTMODE=${CERTMODE:-$(confget CERT)}; CERTMODE=${CERTMODE:-acme}
[ $IS_IP = 1 ] && [ "$CERTMODE" = acme ] && die "Let's Encrypt needs a DNS name, not an IP address (or use --self-signed)" 64
if [ -z "$PORT" ]; then
  PORT=$(confget PORT)
  # switching between direct and behind-proxy changes the default port
  if [ -z "$PORT" ] || [ "$BEHIND" != "$(confget BEHIND_PROXY)" ]; then [ "$BEHIND" = 1 ] && PORT=4443 || PORT=443; fi
fi
case $PORT in ''|*[!0-9]*) die "--port: a number" 64 ;; esac
WEBROOT=${WEBROOT:-$(confget WEBROOT)}
EMAIL=${EMAIL:-$(confget EMAIL)}
ACME=${ACME:-$(confget ACME_SERVER)}
CA_BUNDLE=${REQUESTS_CA_BUNDLE:-$(confget CA_BUNDLE)}   # a test ACME server's own CA (Pebble); empty for Let's Encrypt
PUBLIC_PORT=$PORT; [ "$BEHIND" = 1 ] && PUBLIC_PORT=443
HOSTPORT=$NAME; [ "$PUBLIC_PORT" = 443 ] || HOSTPORT=$NAME:$PUBLIC_PORT

# -------------------------------------------------------------------------------------- packages
apt_need() { # PKG… — install what is missing (asks first unless -y or not a terminal)
  local miss=() p
  for p in "$@"; do dpkg-query -W -f '${Status}' "$p" 2>/dev/null | grep -q 'ok installed' || miss+=("$p"); done
  [ ${#miss[@]} = 0 ] && return 0
  command -v apt-get >/dev/null || die "missing: ${miss[*]} — install them with your package manager, then re-run"
  if [ $YES = 0 ] && [ -t 0 ]; then
    read -r -p "install ${miss[*]} with apt? [Y/n] " a
    case $a in n*|N*) die "needs: ${miss[*]}" ;; esac
  fi
  say "apt-get install ${miss[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${miss[@]}" >/dev/null
}

# ---------------------------------------------------------------------------- the certificate
pin_of_key() { # the hub's pin: sha-256 of the public key (SPKI), "sha-256 AA:BB:…"
  openssl pkey -in "$KEY" -pubout -outform DER 2>/dev/null | sha256sum | cut -c1-64 | tr 'a-f' 'A-F' |
    sed 's/../&:/g; s/:$//; s/^/sha-256 /'
}
cert_key_ok() { # does cert.pem carry key.pem's public key?
  [ -s "$CERT" ] && [ "$(openssl x509 -in "$CERT" -noout -pubkey 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum)" = \
    "$(openssl pkey -in "$KEY" -pubout -outform DER 2>/dev/null | sha256sum)" ]
}
cert_names() { openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tr ',' '\n' | sed -n 's/^ *\(DNS\|IP Address\):\(.*\)$/\2/p' | tr '[:upper:]' '[:lower:]'; }
cert_for_name() { cert_names | grep -qx "$NAME"; }
cert_due() { # less than a third of its life left (90-day cert: 30 days; 6-day cert: 2 days)?
  local s e now
  s=$(date -d "$(openssl x509 -in "$CERT" -noout -startdate | cut -d= -f2)" +%s) || return 0
  e=$(date -d "$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)" +%s) || return 0
  now=$(date +%s)
  [ $((e - now)) -lt $(((e - s) / 3)) ]
}
self_signed() {
  local san="DNS:$NAME"; [ $IS_IP = 1 ] && san="IP:$NAME"
  openssl req -x509 -new -key "$KEY" -subj "/CN=$NAME" -addext "subjectAltName=$san" -days 3650 -out "$CERT.new" 2>/dev/null
  chmod 644 "$CERT.new"; mv -f "$CERT.new" "$CERT"
  echo self-signed >"$ETC/cert.source"
  CHANGED=1
}
port_owner() { # proto port → "name" of the process listening there, or empty when free
  ss -Hlnp"$1" "sport = :$2" 2>/dev/null | head -1 | sed -n 's/.*users:(("\([^"]*\)".*/\1/p;t;s/.*/somebody/p'
}
ACME_HINT=''
# printed snippets name IPv6 only where this server has it (nginx refuses [::] without it)
V6_80='' V6_443=''
if [ -s /proc/net/if_inet6 ]; then V6_80='listen [::]:80;' V6_443='listen [::]:443;'; fi
webroot_text() { # who holds :80 → what to add so http://NAME/.well-known/acme-challenge/ reaches the webroot
  local dir=$VAR/acme
  case $1 in
    nginx*) cat <<EOF
nginx holds port 80. Add this server block (e.g. /etc/nginx/conf.d/yggdrasil-trunk-acme.conf):

    server {
        listen 80; $V6_80
        server_name $NAME;
        location /.well-known/acme-challenge/ { root $dir; }
    }

then: sudo nginx -t && sudo systemctl reload nginx
and:  sudo bash trunk.sh --webroot $dir
EOF
    ;;
    caddy*) cat <<EOF
caddy holds port 80. Add this site to your Caddyfile ("http://" = caddy makes no certificate for it):

    http://$NAME {
        root * $dir
        file_server
    }

then: sudo systemctl reload caddy
and:  sudo bash trunk.sh --webroot $dir
EOF
    ;;
    apache2*|httpd*) cat <<EOF
apache holds port 80. Add to the <VirtualHost *:80> that answers $NAME (or a new one with ServerName $NAME):

    Alias /.well-known/acme-challenge/ $dir/.well-known/acme-challenge/
    <Directory $dir/.well-known/acme-challenge>
        Require all granted
    </Directory>

then: sudo systemctl reload apache2
and:  sudo bash trunk.sh --webroot $dir
EOF
    ;;
    *) cat <<EOF
"$1" holds port 80, so Let's Encrypt cannot check this server by itself. Make
http://$NAME/.well-known/acme-challenge/FILE serve $dir/.well-known/acme-challenge/FILE,
then: sudo bash trunk.sh --webroot $dir      (or free port 80 and re-run)
EOF
    ;;
  esac
}
acme_issue() { # Let's Encrypt for NAME from OUR key (certbot --csr): the pin survives every renewal
  local w how=() who
  if [ -n "$WEBROOT" ]; then
    mkdir -p "$WEBROOT/.well-known/acme-challenge"; chmod 755 "$WEBROOT" "$WEBROOT/.well-known" "$WEBROOT/.well-known/acme-challenge"
    how=(--webroot -w "$WEBROOT")
  else
    who=$(port_owner t 80)
    if [ -n "$who" ]; then ACME_HINT=$(webroot_text "$who"); return 2; fi
    how=(--standalone --http-01-port 80)
  fi
  w=$(mktemp -d)
  openssl req -new -key "$KEY" -subj "/CN=$NAME" -addext "subjectAltName=DNS:$NAME" -out "$w/ap.csr" 2>/dev/null
  local args=(certonly --non-interactive --agree-tos --preferred-challenges http "${how[@]}"
    --config-dir "$VAR/letsencrypt" --work-dir "$VAR/letsencrypt/work" --logs-dir /var/log/yggdrasil-trunk
    --csr "$w/ap.csr" --cert-path "$w/cert.pem" --fullchain-path "$w/fullchain.pem" --chain-path "$w/chain.pem")
  if [ -n "$EMAIL" ]; then args+=(--email "$EMAIL"); else args+=(--register-unsafely-without-email); fi
  [ -n "$ACME" ] && args+=(--server "$ACME")
  local ca="Let's Encrypt"; [ -n "$ACME" ] && ca=$ACME
  say "certificate: asking $ca for $NAME (HTTP-01 on port 80${WEBROOT:+ through $WEBROOT})"
  if ! REQUESTS_CA_BUNDLE=${CA_BUNDLE:-${REQUESTS_CA_BUNDLE:-}} certbot "${args[@]}" >"$w/log" 2>&1; then
    sed 's/^/    /' "$w/log" | tail -n 15 >&2
    ACME_HINT="the certificate request failed (above). Check that $NAME points at this server (DNS A/AAAA record)
and that port 80 is reachable from the internet (your provider's firewall too). Then re-run: sudo bash trunk.sh"
    rm -rf "$w"; return 1
  fi
  [ -s "$w/fullchain.pem" ] || { ACME_HINT="certbot answered but wrote no certificate"; rm -rf "$w"; return 1; }
  install -m 644 "$w/fullchain.pem" "$CERT.new" && mv -f "$CERT.new" "$CERT"
  rm -rf "$w"
  cert_key_ok || die "the new certificate does not carry this server's key — refusing (your hub's pin would break)"
  echo acme >"$ETC/cert.source"
  CHANGED=1
  say "certificate: $(openssl x509 -in "$CERT" -noout -issuer | sed 's/^issuer=//') · until $(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)"
}
ensure_cert() { # → 0 done · 2 waiting for the webroot · 1 failed (ACME_HINT says why)
  if ! cert_key_ok || ! cert_for_name; then
    self_signed   # a valid cert from our key right away: the access point starts, the hub's pin already works
    say "certificate: self-signed for $NAME (from this server's key)"
  fi
  [ "$CERTMODE" = acme ] || return 0
  if [ "$(cat "$ETC/cert.source" 2>/dev/null)" = acme ] && [ $FORCE = 0 ] && ! cert_due; then
    say "certificate: valid until $(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2) — nothing to do"
    return 0
  fi
  apt_need certbot
  acme_issue
}
restart_if_changed() {
  if [ $CHANGED = 1 ] && systemctl is-enabled --quiet $UNIT 2>/dev/null; then
    systemctl restart $UNIT; say "restarted $UNIT"
  fi
}

# ------------------------------------------------------------------------- --renew (the timer)
if [ $RENEW = 1 ]; then
  [ -s "$KEY" ] || die "no $KEY — run trunk.sh --name … first"
  rc=0; ensure_cert || rc=$?
  restart_if_changed
  [ $rc = 0 ] || { printf '%s\n' "$ACME_HINT" >&2; exit 1; }
  exit 0
fi

# ======================================================================================= install
say "yggdrasil trunk for $NAME ($( [ "$BEHIND" = 1 ] && echo "behind your :443 router → 127.0.0.1:$PORT" || echo "port $PORT" ), certificate: $CERTMODE)"
# in a subshell: os-release defines NAME and VERSION, which are ours here
# shellcheck disable=SC1091
OS=$( . /etc/os-release 2>/dev/null; printf '%s|%s' " ${ID:-} ${ID_LIKE:-} " "${PRETTY_NAME:-unknown}" )
case ${OS%%|*} in *" debian "*|*" ubuntu "*) ;; *) warn "made for Debian 12+ / Ubuntu 22.04+; this is ${OS#*|} — trying anyway" ;; esac
case $(uname -m) in x86_64|amd64) ARCH=x86_64 ;; aarch64|arm64) ARCH=aarch64 ;; *) ARCH=$(uname -m) ;; esac
# -------------------------------------------------------------------------------- 1. ports first
# before anything is installed: a port taken by someone else stops here (ss comes with iproute2)
command -v ss >/dev/null || apt_need iproute2
OURS=0; systemctl is-active --quiet $UNIT 2>/dev/null && OURS=1
OWNER=$(port_owner t "$PORT")
if [ -n "$OWNER" ] && ! { [ $OURS = 1 ] && [ "$OWNER" = bifrost-net ]; }; then
  if [ "$BEHIND" = 1 ]; then
    die "port $PORT (loopback, for the access point) is taken by '$OWNER' — pick another: --port N"
  fi
  die "port $PORT is taken by '$OWNER' (a website?). Keep it: run again with --behind-proxy — the trunk then
    listens on 127.0.0.1:4443 and this script shows how to route $NAME there from :443. Nothing was installed."
fi
if [ "$BEHIND" = 0 ] && [ -z "$(port_owner t 443)" ] && [ "$PORT" != 443 ]; then
  warn "port 443 is free but the trunk will listen on $PORT — phones then need https://$HOSTPORT"
fi

PKGS=(ca-certificates curl openssl iproute2 libopus0)
[ "$BEHIND" = 1 ] && PKGS+=(python3)
apt_need "${PKGS[@]}"

# ------------------------------------------------------------------------------ 2. the binary
install -d -m 755 "$ETC" "$LIB"
install -d -m 711 "$VAR"   # 711: a web server may reach $VAR/acme (--webroot), nobody may list
fetch() { curl -fsSL --retry 3 --proto '=https,http' -o "$2" "$1"; }
NEWBIN=''
SOURCE=$(confget SOURCE)
if [ -n "$BINARY" ]; then
  [ -x "$BINARY" ] || die "--binary $BINARY: not an executable file"
  NEWBIN=$BINARY GOTVER="local file $(basename "$BINARY")" SOURCE=file
elif [ "$SOURCE" = file ] && [ -z "$VERSION" ] && [ -x "$BIN" ]; then
  # installed from your own file: a re-run keeps it (--version vX.Y.Z switches to a release)
  NEWBIN=$BIN GOTVER=$(confget BINARY)
  say "binary: kept — installed from your own file (--version vX.Y.Z switches to a release)"
else
  SOURCE=release
  [ "$ARCH" = x86_64 ] || die "no release binary for $ARCH yet — build bifrost-net (cargo build --release in trunk/) and pass --binary FILE"
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  if [ -n "$VERSION" ]; then BASE=$RELEASES/download/$VERSION; else BASE=$RELEASES/latest/download; fi
  say "binary: $BASE/SHA256SUMS"
  fetch "$BASE/SHA256SUMS" "$T/SHA256SUMS" || die "cannot download $BASE/SHA256SUMS — check the network${VERSION:+ and that release $VERSION exists}"
  ASSET=$(sed -n "s/^[0-9a-f]\{64\}  \(bifrost-net-[0-9][0-9A-Za-z.+-]*-linux-$ARCH\)\$/\1/p" "$T/SHA256SUMS" | head -1)
  [ -n "$ASSET" ] || die "the release has no bifrost-net for linux-$ARCH"
  WANT=$(grep "  $ASSET\$" "$T/SHA256SUMS" | head -1 | cut -c1-64)
  if [ -x "$BIN" ] && [ "$(sha256sum <"$BIN" | cut -c1-64)" = "$WANT" ]; then
    NEWBIN=$BIN
  else
    say "binary: $BASE/$ASSET"
    fetch "$BASE/$ASSET" "$T/$ASSET" || die "cannot download $BASE/$ASSET"
    [ "$(sha256sum <"$T/$ASSET" | cut -c1-64)" = "$WANT" ] || die "$ASSET does not match SHA256SUMS — refusing to install it"
    chmod 755 "$T/$ASSET"; NEWBIN=$T/$ASSET
  fi
  GOTVER=$ASSET
fi
if [ "$NEWBIN" != "$BIN" ] && ! { [ -f "$BIN" ] && [ "$(sha256sum <"$NEWBIN")" = "$(sha256sum <"$BIN")" ]; }; then
  install -m 755 "$NEWBIN" "$BIN.new" && mv -f "$BIN.new" "$BIN"; CHANGED=1
  say "binary: $BIN ← $GOTVER"
else
  say "binary: $BIN ($GOTVER, unchanged)"
fi
MISSING=$(ldd "$BIN" 2>/dev/null | sed -n 's/^[[:space:]]*\([^ ]*\) => not found.*/\1/p' | tr '\n' ' ')
[ -z "$MISSING" ] || die "bifrost-net needs libraries this server lacks: $MISSING"
"$BIN" ap-token >/dev/null 2>&1 || die "$BIN does not run here (too old a release, or the wrong architecture?)"

# ------------------------------------------------------------------------------ 3. the key: once
if [ -s "$KEY" ]; then
  say "key: $KEY (kept — the pin stays the same)"
else
  (umask 077; openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$KEY.new" 2>/dev/null)
  chown root:root "$KEY.new"; chmod 600 "$KEY.new"; mv "$KEY.new" "$KEY"
  say "key: $KEY (new, mode 600 — keep it: your hub pins it)"
fi
chmod 600 "$KEY"; chown root:root "$KEY"
PIN=$(pin_of_key)

# ---------------------------------------------------------------------- 4. DNS + the certificate
if [ $IS_IP = 0 ]; then
  RESOLVED=$(getent ahosts "$NAME" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
  MINE=$(ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')
  if [ -z "$RESOLVED" ]; then
    [ "$CERTMODE" = acme ] && die "$NAME does not resolve yet: create a DNS record $NAME → this server's public address, wait a minute, re-run"
    warn "$NAME does not resolve (yet) — phones and your hub need it to"
  else
    hit=0; for r in $RESOLVED; do case " $MINE " in *" $r "*) hit=1 ;; esac; done
    [ $hit = 1 ] || warn "$NAME resolves to $RESOLVED but this server's addresses are $MINE (fine behind 1:1 NAT, e.g. a cloud provider's public IP)"
  fi
fi
CERT_RC=0
command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active' && UFW=1 || UFW=0
if [ "$UFW" = 1 ]; then
  # (no apostrophe in a ufw comment: ufw refuses the whole rule)
  if [ "$BEHIND" = 0 ]; then
    if ufw allow "$PORT/tcp" comment 'yggdrasil trunk' >/dev/null; then say "ufw: allow $PORT/tcp"; else warn "ufw would not open $PORT/tcp — open it yourself"; fi
  fi
  if [ "$CERTMODE" = acme ] && [ -z "$WEBROOT" ]; then
    if ufw allow 80/tcp comment 'yggdrasil trunk: Lets Encrypt check' >/dev/null; then say "ufw: allow 80/tcp (Let's Encrypt checks the server there)"
    else warn "ufw would not open 80/tcp — open it yourself (Let's Encrypt checks the server there)"; fi
  fi
fi
ensure_cert || CERT_RC=$?

# ------------------------------------------------------------------- 5. the token + ap.toml
OLDHASH=$(sed -n 's/^bridge_token_sha256 = "\([0-9a-f]\{64\}\)".*/\1/p' "$APTOML" 2>/dev/null | head -1 || true)
TOKEN=''
# a token is minted when there is none, on --rotate-token, and when the last run made one but stopped
# before showing it (the marker): nobody may be left holding a token that was never printed
UNSHOWN=$ETC/.token-not-shown-yet
if [ -z "$OLDHASH" ] || [ $ROTATE = 1 ] || [ -e "$UNSHOWN" ]; then
  T2=$("$BIN" ap-token)
  TOKEN=$(sed -n 's/^token = "\([0-9a-f]*\)".*/\1/p' <<<"$T2")
  HASH=$(sed -n 's/^bridge_token_sha256 = "\([0-9a-f]*\)".*/\1/p' <<<"$T2")
  [ ${#TOKEN} -ge 32 ] && [ ${#HASH} = 64 ] || die "bifrost-net ap-token gave no token"
  : >"$UNSHOWN"
else
  HASH=$OLDHASH
fi
LISTEN="0.0.0.0:$PORT"
[ "$BEHIND" = 1 ] && LISTEN="127.0.0.1:$PORT"
# both IPv4 and IPv6 when this server has IPv6 (a dual-stack socket)
[ "$BEHIND" = 0 ] && [ -s /proc/net/if_inet6 ] && [ "$(cat /proc/sys/net/ipv6/bindv6only 2>/dev/null)" = 0 ] && LISTEN="[::]:$PORT"
cat >"$APTOML.new" <<TOML
# GENERATED by trunk.sh — re-run it to change anything (sudo bash trunk.sh --help). No secret in here:
# the hub's token is known only by its SHA-256; the service gets the key in its own /run directory.
[ap]
listen = "$LISTEN"
cert_path = "/run/yggdrasil-trunk/cert.pem"
key_path = "/run/yggdrasil-trunk/key.pem"
bridge_token_sha256 = "$HASH"
proxy_protocol = $( [ "$BEHIND" = 1 ] && echo true || echo false )
TOML
chmod 644 "$APTOML.new"
if [ -f "$APTOML" ] && [ "$(sha256sum <"$APTOML.new")" = "$(sha256sum <"$APTOML")" ]; then rm -f "$APTOML.new"
else mv -f "$APTOML.new" "$APTOML"; CHANGED=1; fi

# ------------------------------------------------------------------------- 6. systemd units
put_unit() { # path — content on stdin; marks CHANGED
  local tmp; tmp=$(mktemp); cat >"$tmp"; chmod 644 "$tmp"
  if [ -f "$1" ] && [ "$(sha256sum <"$tmp")" = "$(sha256sum <"$1")" ]; then rm -f "$tmp"; else mv -f "$tmp" "$1"; CHANGED=1; fi
}
# The key stays root-only on disk. At each start, a root-run ExecStartPre (+) hands a copy to the service's
# dynamic user in its private /run directory (tmpfs, 0700, gone when it stops) — what LoadCredential= does,
# but it also works where systemd 252 leaves credentials unreadable (Debian 12 in a container-based VPS).
# shellcheck disable=SC2016  # $$ and %% are systemd's escapes; the shell inside the unit expands them
PRE='ExecStartPre=+/bin/sh -c '"'"'d=$$RUNTIME_DIRECTORY; install -m 400 -o "$$(stat -c %%u "$$d")" '"$KEY"' "$$d/key.pem" && install -m 444 '"$CERT"' "$$d/cert.pem"'"'"
put_unit "$UNIT_FILE" <<UNIT
# GENERATED by trunk.sh. The access point of your yggdrasil trunk.
[Unit]
Description=yggdrasil trunk — the access point your phone and your computers reach ($NAME)
After=network-online.target
Wants=network-online.target

[Service]
$PRE
ExecStart=$BIN ap -c $APTOML
RuntimeDirectory=yggdrasil-trunk
RuntimeDirectoryMode=0700
DynamicUser=yes
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
# this script, for the renewal timer (it reads trunk.conf)
if ! { [ -f "$SELF" ] && [ "$(sha256sum <"$0")" = "$(sha256sum <"$SELF")" ]; }; then install -m 755 "$0" "$SELF"; fi
if [ "$CERTMODE" = acme ]; then
  put_unit /etc/systemd/system/yggdrasil-trunk-cert.service <<UNIT
[Unit]
Description=renew the yggdrasil trunk certificate ($NAME) with the same key, when due
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=$SELF --renew
UNIT
  put_unit /etc/systemd/system/yggdrasil-trunk-cert.timer <<UNIT
[Unit]
Description=daily: renew the yggdrasil trunk certificate when a third of its life is left
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
fi

# ---------------------------------------------------------- 7. --behind-proxy: the :443 router
if [ "$BEHIND" = 1 ]; then
  SRC=''
  for c in "$HERE/../deploy/sni-443.py" "$HERE/sni-443.py"; do [ -f "$c" ] && { SRC=$c; break; }; done
  [ -z "$SRC" ] && [ -f "$LIB/sni-443.py" ] && SRC=$LIB/sni-443.py   # a re-run: keep the one installed
  if [ -z "$SRC" ]; then
    TAG=${VERSION:-$(sed -n 's/^bifrost-net-\([0-9][0-9A-Za-z.+-]*\)-linux-.*/v\1/p' <<<"${ASSET:-}")}
    [ -n "$TAG" ] || TAG=main
    T3=$(mktemp); fetch "$RAW/$TAG/trunk/deploy/sni-443.py" "$T3" || die "cannot download sni-443.py from $RAW/$TAG — run trunk.sh from a clone of the repository"
    SRC=$T3
  fi
  [ "$SRC" = "$LIB/sni-443.py" ] || { install -m 755 "$SRC" "$LIB/sni-443.py.new" && mv -f "$LIB/sni-443.py.new" "$LIB/sni-443.py"; }
  if [ ! -f "$ETC/sni-443.conf" ]; then
    cat >"$ETC/sni-443.conf" <<EOF
# sni-443.conf — who gets which TLS name on :443 (yggdrasil-sni-443.service). Re-read on restart.
#   route NAME BACKEND [proxy]   TLS for NAME (or *.example.org) goes to BACKEND, untouched;
#                                proxy = a PROXY v1 line first, carrying the client's real address
#   default BACKEND              everything else: other names, no name, plain http
#   stun BACKEND                 optional: STUN/TURN over TCP (coturn)
listen  0.0.0.0:443
route   $NAME  127.0.0.1:$PORT  proxy
default 127.0.0.1:8443
EOF
    chmod 644 "$ETC/sni-443.conf"
  elif ! grep -q "^route[[:space:]]\+${NAME}[[:space:]]" "$ETC/sni-443.conf"; then
    warn "$ETC/sni-443.conf has no route for $NAME — add: route $NAME 127.0.0.1:$PORT proxy"
  fi
  put_unit /etc/systemd/system/yggdrasil-sni-443.service <<UNIT
# GENERATED by trunk.sh. Shares :443 by TLS name (SNI): $NAME → the trunk, the rest → your website.
# NOT enabled by trunk.sh: move your website's https to the 'default' backend first (see trunk.sh's output).
[Unit]
Description=:443 by TLS name — the trunk and your website on one port ($ETC/sni-443.conf)
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/bin/python3 $LIB/sni-443.py -c $ETC/sni-443.conf
DynamicUser=yes
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
Restart=always
RestartSec=1
[Install]
WantedBy=multi-user.target
UNIT
fi

# ------------------------------------------------------------------- 8. settings, then start
cat >"$CONF.new" <<EOF
# GENERATED by trunk.sh — what you chose; re-runs read it. No secrets.
NAME=$NAME
PORT=$PORT
BEHIND_PROXY=$BEHIND
CERT=$CERTMODE
WEBROOT=$WEBROOT
EMAIL=$EMAIL
ACME_SERVER=$ACME
CA_BUNDLE=$CA_BUNDLE
BINARY=$GOTVER
SOURCE=$SOURCE
EOF
chmod 644 "$CONF.new"; mv -f "$CONF.new" "$CONF"
systemctl daemon-reload
systemctl enable --quiet $UNIT
if [ $OURS = 0 ] || [ $CHANGED = 1 ]; then systemctl restart $UNIT; say "started $UNIT"; else say "running $UNIT (unchanged)"; fi
if [ "$CERTMODE" = acme ]; then systemctl enable --quiet --now yggdrasil-trunk-cert.timer
else systemctl disable --quiet --now yggdrasil-trunk-cert.timer 2>/dev/null || true; fi

# the access point answers on its port with THIS key (curl pins it)
B64PIN=$(openssl pkey -in "$KEY" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -binary | base64)
PROBE=(curl -sk -o /dev/null -m 5 -w '%{http_code}' --pinnedpubkey "sha256//$B64PIN" --resolve "$NAME:$PORT:127.0.0.1" "https://$NAME:$PORT/")
[ "$BEHIND" = 1 ] && PROBE=(curl -sk -o /dev/null -m 5 -w '%{http_code}' --haproxy-protocol --pinnedpubkey "sha256//$B64PIN" --resolve "$NAME:$PORT:127.0.0.1" "https://$NAME:$PORT/")
code=000
for _ in $(seq 20); do code=$("${PROBE[@]}" 2>/dev/null || true); [ "$code" != 000 ] && break; sleep 0.5; done
if [ "$code" = 000 ]; then
  journalctl -u $UNIT -n 15 --no-pager -o cat >&2 || true
  die "the access point does not answer on 127.0.0.1:$PORT (log above)"
fi
case $code in 503) STATE="answering — no hub connected yet" ;; *) STATE="answering — a hub is connected (HTTP $code)" ;; esac
say "access point: https://$HOSTPORT  $STATE"
say "pin: $PIN"

# ----------------------------------------------------------------------------------- the end
line() { printf '%s\n' "────────────────────────────────────────────────────────────────────────────────"; }
echo
if [ "$BEHIND" = 1 ]; then
  line
  cat <<EOF
 :443 is your website's. Send the name $NAME to the trunk — pick ONE:

 A) our small router (python3, ~200 lines: $LIB/sni-443.py, config $ETC/sni-443.conf)
    1. move your website's HTTPS from :443 to 127.0.0.1:8443
         nginx:  listen 443 ssl;   →  listen 127.0.0.1:8443 ssl;
         caddy:  global options block { https_port 8443 }            (http stays on :80)
    2. sudo systemctl enable --now yggdrasil-sni-443
    The website keeps its own certificate and gets its TLS untouched; only $NAME is routed to the trunk.

 B) nginx already on :443 — let it route by name (module: libnginx-mod-stream), top level of nginx.conf:

    stream {
        map \$ssl_preread_server_name \$ygg_backend {
            $NAME  127.0.0.1:$PORT;
            default        127.0.0.1:8443;
        }
        server {
            listen 443; $V6_443
            ssl_preread on;
            proxy_pass \$ygg_backend;
            proxy_protocol on;
        }
    }

    and your website's server blocks:  listen 127.0.0.1:8443 ssl proxy_protocol;
                                       set_real_ip_from 127.0.0.1; real_ip_header proxy_protocol;
    then: sudo nginx -t && sudo systemctl reload nginx
EOF
  line
fi
if [ $CERT_RC != 0 ]; then
  line
  echo " CERTIFICATE PENDING — phones will refuse https://$HOSTPORT until this is done:"
  echo
  printf '%s\n' "$ACME_HINT" | sed 's/^/ /'
  echo
  echo " The trunk already runs with a temporary certificate from the same key: your hub can connect now"
  echo " (it trusts the key, not the certificate) and needs nothing new once the real one arrives."
  line
fi
if [ -n "$TOKEN" ]; then
  LINE="wss://$HOSTPORT/ap#pin=${PIN#sha-256 },token=$TOKEN"
  line
  cat <<EOF
 Your trunk is up: https://$HOSTPORT

 On your home computer (the hub), in the folder yggdrasil/root/install, run:

   ./install.sh --trunk '$LINE'

 This line holds a secret: the token that lets your hub in. It is shown ONCE — this
 server keeps only its SHA-256. Lost it, or want a new one? sudo bash trunk.sh --rotate-token
 prints a new line; the old one stops working, so re-run install.sh --trunk with it.
EOF
  line
  rm -f "$UNSHOWN"
  [ $ROTATE = 1 ] && [ -n "$OLDHASH" ] && warn "the previous token no longer works — your hub reconnects once you run install.sh --trunk with the line above"
else
  echo " The trunk is up: https://$HOSTPORT · token kept (your hub's connect line still works)."
  echo " Need the connect line again? It is not stored here: sudo bash trunk.sh --rotate-token prints a new one."
fi
exit 0
