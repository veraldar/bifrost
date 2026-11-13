#!/usr/bin/env bash
# own-trunk-e2e.sh — YOUR OWN TRUNK, the lay procedure (docs/own-trunk.md) end to end in docker: fresh machines,
# the real scripts, a simulated phone. No real Let's Encrypt (Pebble, its test server), nothing public.
#
#   "internet" 172.31.250.0/24 (docker network ot-net, OT_SUBNET; the phone = this machine at .1)
#     ot-files   .5   a fake GitHub (release assets + SHA256SUMS, raw files) and an outside client (curl)
#     ot-pebble  .6   Let's Encrypt's test ACME server (HTTP-01 on port 80, like the real one)
#     ot-vps-a   .10  trunk.tree.test     Debian 12 + systemd + ufw: trunk.sh --self-signed, binary from the
#                                         fake release (sha256 checked), :443 direct
#     ot-vps-b   .11  trunk-le.tree.test  Debian 12 + systemd + ufw: trunk.sh with Pebble, certbot standalone on :80
#     ot-vps-c   .12  trunk-px.tree.test  Debian 12 + systemd + an nginx website (www.tree.test) on :80 + :443:
#                     www.tree.test       trunk.sh --behind-proxy, Pebble through nginx's webroot, then :443 shared by
#                                         name with sni-443.py (option A) and nginx stream (option B)
#     ot-home    .20  the home computer (Debian 12 + Node 24): install.sh --trunk '<line>' on the mock model
#     ot-mac     .30  another computer (Ubuntu 24.04): join.sh --hub https://trunk.tree.test, approved on the phone
#   the phone: Chromium (Playwright, Pixel 7) on this machine — branch/e2e/own-trunk.spec.ts
#
#   sim/own-trunk-e2e.sh                 every stage; exit 0 = all PASS (the table at the end)
#   OT_STAGES=a,b,c (subset) · OT_REAL_RELEASE=1 adds stage r: trunk.sh fetching the REAL v0.8.0 from GitHub
#   OT_KEEP=1 leaves the containers up · OT_STATE=DIR keeps state + logs there
#
# Needs: docker (privileged containers: systemd inside), the internet for apt in the fresh containers and the
# images, zbarimg, branch/ built (npm run build) with node_modules (Playwright + its chromium).
# Binaries: built for Debian 12 in docker (sim/own-trunk/build.Dockerfile → trunk/target-bookworm,
# root/target-bookworm), or OT_TRUNK_BIN / OT_YGG_BIN.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HERE=$ROOT/sim/own-trunk
STATE=${OT_STATE:-$(mktemp -d /tmp/own-trunk.XXXXXX)}
STAGES=,${OT_STAGES:-a,b,c},; [ "${OT_REAL_RELEASE:-0}" = 1 ] && STAGES="${STAGES}r,"
mkdir -p "$STATE"/{files,sim,log} && chmod 755 "$STATE" "$STATE/sim"
RESULTS=$STATE/results.tsv; : >"$RESULTS"; : >"$STATE/steps.tsv"
# a private /24 (docker's own DNS forwarder serves 172.16/12 networks; the sim needs it for apt)
NET=ot-net SUBNET=${OT_SUBNET:-172.31.250.0/24}; P=${SUBNET%.*}
PHONE_IP=$P.1 IP_FILES=$P.5 IP_PEBBLE=$P.6 IP_A=$P.10 IP_B=$P.11 IP_C=$P.12 IP_R=$P.13 IP_HOME=$P.20 IP_MAC=$P.30
A=trunk.tree.test B=trunk-le.tree.test C=trunk-px.tree.test WWW=www.tree.test
ALL=(ot-files ot-pebble ot-vps-a ot-vps-b ot-vps-c ot-vps-r ot-home ot-mac)
VER=0.8.0

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
pass() { printf 'PASS\t%s\t%s\n' "$1" "$2" >>"$RESULTS"; printf '\033[32mPASS\033[0m %-5s %s\n' "$1" "$2"; }
fail() { printf 'FAIL\t%s\t%s\t%s\n' "$1" "$2" "${3:-}" >>"$RESULTS"; printf '\033[31mFAIL\033[0m %-5s %s  %s\n' "$1" "$2" "${3:-}"; }
check() { # ID WHAT CMD… — PASS when CMD exits 0
  local id=$1 what=$2; shift 2
  if "$@" >>"$STATE/log/checks.log" 2>&1; then pass "$id" "$what"; else fail "$id" "$what" "(see log/checks.log)"; fi
}
stage() { case $STAGES in *,"$1",*) return 0 ;; esac; return 1; }
dx() { docker exec "$@"; }
vps() { local c=$1; shift; docker exec "$c" bash -c "$*"; }          # as the VPS admin (root)
homesh() { docker exec -u node ot-home bash -c "$*"; }               # as the home computer's user
outside() { docker exec ot-files bash -c "$*"; }                      # somebody on the internet
export -f dx vps homesh outside

cleanup() {
  [ "${OT_KEEP:-0}" = 1 ] && { say "kept: containers ${ALL[*]} · network $NET"; return; }
  docker rm -f "${ALL[@]}" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ------------------------------------------------------------------------------------ prerequisites
command -v docker >/dev/null || { echo "docker is needed"; exit 2; }
command -v zbarimg >/dev/null || { echo "zbarimg is needed (zbar)"; exit 2; }
[ -f "$ROOT/branch/.next/BUILD_ID" ] || { echo "build the app first: (cd branch && npm ci && npm run build)"; exit 2; }
# the home computer mounts the repo read-only: install.sh must find the build current (its own test, same files)
STALE=$(cd "$ROOT/branch" && find app components hooks lib styles public middleware.ts next.config.ts package.json package-lock.json server.mjs -newer .next/BUILD_ID -print -quit 2>/dev/null)
[ -z "$STALE" ] || { echo "branch/$STALE is newer than the app build: (cd branch && npm run build)"; exit 2; }
docker rm -f "${ALL[@]}" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
say "images"
docker build -q -t ot-vps:12 -f "$HERE/vps.Dockerfile" "$HERE" >/dev/null || exit 2
docker image inspect node:24 >/dev/null 2>&1 || docker pull -q node:24 >/dev/null
docker image inspect ubuntu:24.04 >/dev/null 2>&1 || docker pull -q ubuntu:24.04 >/dev/null
docker image inspect ghcr.io/letsencrypt/pebble:latest >/dev/null 2>&1 || docker pull -q ghcr.io/letsencrypt/pebble:latest >/dev/null
TRUNK_BIN=${OT_TRUNK_BIN:-} YGG_BIN=${OT_YGG_BIN:-}
if [ -z "$TRUNK_BIN" ] || [ -z "$YGG_BIN" ]; then
  say "binaries for Debian 12 (cargo in docker: trunk/target-bookworm, root/target-bookworm)"
  docker build -q -t ot-build:bookworm -f "$HERE/build.Dockerfile" "$HERE" >/dev/null || exit 2
  for c in trunk root; do
    docker run --rm --user "$(id -u):$(id -g)" -e CARGO_HOME=/cargo -e HOME=/tmp -v "$HOME/.cargo/registry:/cargo/registry" \
      -v "$ROOT:/src" -w "/src/$c" ot-build:bookworm bash -c \
      "CARGO_TARGET_DIR=/src/$c/target-bookworm cargo build --release --locked --offline -q 2>/dev/null || CARGO_TARGET_DIR=/src/$c/target-bookworm cargo build --release --locked -q" \
      || { echo "cargo build of $c/ failed"; exit 2; }
  done
  TRUNK_BIN=${TRUNK_BIN:-$ROOT/trunk/target-bookworm/release/bifrost-net}
  YGG_BIN=${YGG_BIN:-$ROOT/root/target-bookworm/release/yggdrasil}
fi
mkdir -p "$STATE/bin" && cp "$TRUNK_BIN" "$STATE/bin/bifrost-net" && cp "$YGG_BIN" "$STATE/bin/yggdrasil"

# ---- the fake GitHub: release assets (one honest, one tampered) + raw files
R=$STATE/files/releases
mkdir -p "$R/download/v$VER" "$R/latest/download" "$R/download/v9.9.9" "$STATE/files/raw/main/trunk/deploy"
cp "$STATE/bin/bifrost-net" "$R/download/v$VER/bifrost-net-$VER-linux-x86_64"
(cd "$R/download/v$VER" && sha256sum "bifrost-net-$VER-linux-x86_64" >SHA256SUMS)
cp "$R/download/v$VER/"* "$R/latest/download/"
cp "$STATE/bin/bifrost-net" "$R/download/v9.9.9/bifrost-net-9.9.9-linux-x86_64"
printf 'x' >>"$R/download/v9.9.9/bifrost-net-9.9.9-linux-x86_64"   # one byte more than SHA256SUMS says
sed "s/$VER/9.9.9/" "$R/download/v$VER/SHA256SUMS" >"$R/download/v9.9.9/SHA256SUMS"
cp "$ROOT/trunk/deploy/sni-443.py" "$STATE/files/raw/main/trunk/deploy/"
chmod -R a+rX "$STATE/files"

# ---- Pebble: HTTP-01 on port 80 like Let's Encrypt; no random nonce rejects, no sleeps (deterministic)
cat >"$STATE/pebble.json" <<'JSON'
{"pebble": {"listenAddress": "0.0.0.0:14000", "managementListenAddress": "0.0.0.0:15000",
  "certificate": "test/certs/localhost/cert.pem", "privateKey": "test/certs/localhost/key.pem",
  "httpPort": 80, "tlsPort": 443, "ocspResponderURL": "", "externalAccountBindingRequired": false,
  "keyAlgorithm": "ecdsa", "profiles": {"default": {"description": "90 days", "validityPeriod": 7776000}}}}
JSON
chmod 644 "$STATE/pebble.json"

say "network $NET ($SUBNET) — state + logs: $STATE"
docker network create --subnet "$SUBNET" "$NET" >/dev/null || exit 2
docker run -d --name ot-files --hostname files --network "$NET" --ip "$IP_FILES" --network-alias files.tree.test \
  -v "$STATE/files:/files:ro" -v "$STATE/sim:/sim" node:24 python3 -m http.server 8000 -d /files >/dev/null
docker run -d --name ot-pebble --network "$NET" --ip "$IP_PEBBLE" --network-alias pebble \
  -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 -e PEBBLE_AUTHZREUSE=0 \
  -v "$STATE/pebble.json:/pebble.json:ro" ghcr.io/letsencrypt/pebble:latest -config /pebble.json >/dev/null
docker cp ot-pebble:/test/certs/pebble.minica.pem "$STATE/sim/pebble-acme-ca.pem" >/dev/null
for _ in $(seq 30); do outside "curl -sk -o /sim/pebble-root.pem https://pebble:15000/roots/0" && [ -s "$STATE/sim/pebble-root.pem" ] && break; sleep 1; done

new_vps() { # NAME IP ALIAS… — a fresh Debian 12 server with systemd as PID 1
  local n=$1 ip=$2; shift 2
  local al=(); for a in "$@"; do al+=(--network-alias "$a"); done
  docker run -d --name "$n" --hostname "${n#ot-}" --network "$NET" --ip "$ip" "${al[@]}" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock ot-vps:12 >/dev/null
  for _ in $(seq 30); do s=$(dx "$n" systemctl is-system-running 2>/dev/null || true); case $s in running|degraded) break ;; esac; sleep 1; done
}
pin_of() { sed -n "s/.*--trunk 'wss:[^#]*#pin=\([0-9A-F:]*\),token=.*/\1/p" "$1" | tail -1; }
line_of() { sed -n "s/.*--trunk '\(wss:[^']*\)'.*/\1/p" "$1" | tail -1; }
reg_sum() { homesh 'sha256sum < ~/.local/state/bifrost/devices.json' | cut -c1-16; }
trunk_code() { # URL [CAFILE] → the HTTP status an outsider gets for URL/pair
  outside "curl -s -o /dev/null -m 10 -w '%{http_code}' ${2:+--cacert $2} ${2:--k} $1/pair" 2>/dev/null || echo 000
}
run_phone() { # SCOPE AP_URL AP_IP STEPS_FILE
  ( cd "$ROOT/branch" && OT_SCOPE=$1 OT_AP_URL=$2 OT_AP_IP=$3 OT_STATE="$STATE/sim" OT_STEPS=$4 OT_PHONE_IP=$PHONE_IP \
      OT_HUB_NAME=home-pc PW_BASE_URL=$2 npx playwright test e2e/own-trunk.spec.ts --reporter=list ) >>"$STATE/log/phone.log" 2>&1
}
install_home() { # LOGNAME LINE [more install.sh args] — the hub's one command
  local log=$1 line=$2; shift 2
  homesh "cd /repo/root/install && YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18397 YGG_UPSTREAM_STYLE=anthropic \
    YGG_UPSTREAM_API_KEY=mock YGG_UPSTREAM_MODEL=mock YGG_BINARY=/opt/bin/yggdrasil BRIDGE_BINARY=/opt/bin/bifrost-net \
    ./install.sh --direct --skip voice,livekit,agent --trunk '$line' $*" >"$STATE/log/$log" 2>&1
}

# =========================================================================================== stage a
LINE_A=''
if stage a; then
  say "stage a: a fresh VPS, trunk.sh --self-signed (the binary from the release, sha256-checked), ufw on"
  new_vps ot-vps-a "$IP_A" "$A"
  vps ot-vps-a 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq ufw >/dev/null && ufw allow 22/tcp >/dev/null && ufw --force enable >/dev/null && ufw status | head -1' >"$STATE/log/a-ufw.log" 2>&1
  docker cp "$ROOT/trunk/install/trunk.sh" ot-vps-a:/root/trunk.sh >/dev/null   # the one file a user downloads
  REL="TRUNK_RELEASES=http://files.tree.test:8000/releases"
  vps ot-vps-a "cd /root && $REL bash trunk.sh --name $A --self-signed --version v9.9.9" >"$STATE/log/a0-tampered.log" 2>&1; rc=$?
  check a0 "a tampered release binary is refused (sha256 ≠ SHA256SUMS), nothing installed" \
    bash -c "[ $rc != 0 ] && grep -q 'does not match SHA256SUMS' '$STATE/log/a0-tampered.log' && ! docker exec ot-vps-a test -e /usr/local/lib/yggdrasil-trunk/bifrost-net"
  vps ot-vps-a "cd /root && $REL bash trunk.sh --name $A --self-signed --version v$VER" >"$STATE/log/a1-trunk.log" 2>&1; rc=$?
  LINE_A=$(line_of "$STATE/log/a1-trunk.log"); PIN_A=$(pin_of "$STATE/log/a1-trunk.log")
  check a1 "trunk.sh --name $A --self-signed --version v$VER → exit 0, ONE connect line" \
    bash -c "[ $rc = 0 ] && [ -n '$LINE_A' ] && [ \$(grep -c -- \"--trunk 'wss://\" '$STATE/log/a1-trunk.log') = 1 ]"
  check a2 "the service runs as a dynamic user (not root), key 600 root, ap.toml holds only the token's sha256" \
    vps ot-vps-a "systemctl is-active -q yggdrasil-trunk && [ \"\$(ps -o user= -C bifrost-net)\" != root ] && \
      [ \"\$(stat -c '%a %U' /etc/yggdrasil-trunk/key.pem)\" = '600 root' ] && \
      ! grep -rq '${LINE_A##*token=}' /etc/yggdrasil-trunk/ && grep -q \"\$(printf %s '${LINE_A##*token=}' | sha256sum | cut -c1-64)\" /etc/yggdrasil-trunk/ap.toml"
  check a3 "ufw was active: trunk.sh opened 443/tcp (the outside reaches the trunk: 503, no hub yet)" \
    bash -c "docker exec ot-vps-a ufw status | grep -q '^443/tcp.*ALLOW' && [ \"\$(outside \"curl -sk -o /dev/null -w '%{http_code}' https://$A/\")\" = 503 ]"
  check a4 "the pin is the SPKI of the key (bifrost-net ap-pin of the served cert = the line's pin)" \
    vps ot-vps-a "[ \"\$(/usr/local/lib/yggdrasil-trunk/bifrost-net ap-pin /etc/yggdrasil-trunk/cert.pem)\" = 'pin = \"sha-256 $PIN_A\"' ]"
  KEYSUM=$(vps ot-vps-a 'sha256sum </etc/yggdrasil-trunk/key.pem')
  vps ot-vps-a "cd /root && $REL bash trunk.sh" >"$STATE/log/a5-rerun.log" 2>&1; rc=$?
  check a5 "re-run (no options, latest release): exit 0, same key + pin + token, no new connect line" \
    bash -c "[ $rc = 0 ] && [ \"\$(docker exec ot-vps-a bash -c 'sha256sum </etc/yggdrasil-trunk/key.pem')\" = '$KEYSUM' ] && \
      grep -q 'token kept' '$STATE/log/a5-rerun.log' && ! grep -q -- \"--trunk 'wss\" '$STATE/log/a5-rerun.log' && \
      grep -q 'pin: sha-256 $PIN_A' '$STATE/log/a5-rerun.log' && grep -q 'binary: .*unchanged' '$STATE/log/a5-rerun.log'"
  docker cp ot-vps-a:/etc/yggdrasil-trunk/cert.pem "$STATE/sim/trunk-ca.pem" >/dev/null; chmod 644 "$STATE/sim/trunk-ca.pem"

  # ------------------------------------------------------------------------------- the home computer
  say "stage a: a fresh home computer, install.sh --trunk '<the line>'"
  docker run -d --name ot-home --hostname home-pc --network "$NET" --ip "$IP_HOME" \
    -v "$ROOT:/repo:ro" -v "$STATE/bin:/opt/bin:ro" -v "$STATE/sim:/sim" node:24 sleep infinity >/dev/null
  # what root/install/README.md tells you to install first (Debian): node is in this image already
  dx ot-home bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libopus0 iproute2 >/dev/null' >"$STATE/log/home-apt.log" 2>&1
  homesh 'mkdir -p ~/mock && cd ~/mock && (setsid nohup python3 /repo/root/mock/mock_upstream.py 18397 >mock.log 2>&1 &)'
  install_home h1-install.log "$LINE_A"; rc=$?
  check h1 "install.sh --trunk '<line>' (fresh box): exit 0, health 'trunk https://$A/pair → 200'" \
    bash -c "[ $rc = 0 ] && grep -q 'trunk   https://$A/pair → 200' '$STATE/log/h1-install.log'"
  check h2 "bridge.toml [ap] url+pin+token+upstream, root-link on; app: devices, https://$A, loopback only" \
    homesh "c=~/.config/bifrost; grep -q '^url = \"wss://$A/ap\"' \$c/bridge.toml && grep -q '^pin = \"sha-256 $PIN_A\"' \$c/bridge.toml && \
      grep -q '^upstream = \"127.0.0.1:8082\"' \$c/bridge.toml && grep -q '^enabled = true' \$c/bridge.toml && \
      grep -qx 'BIFROST_PUBLIC_URL=https://$A' \$c/app.env && grep -qx 'HOST=127.0.0.1' \$c/app.env && \
      grep -qx 'BIFROST_AUTH=devices' \$c/app.env && grep -qx 'BIFROST_TRUST_PROXY=1' \$c/app.env && \
      grep -qx 'BIFROST_ROOTLINK_URL=wss://$A/rootlink' \$c/app.env && grep -q '^YGG_PEER_TOKEN=peer-' \$c/app.env && \
      ss -Hltn 'sport = :8082' | awk '{print \$4}' | grep -qx '127.0.0.1:8082'"
  check h3 "the brain: YGG_ROOT_NAME=home-pc, YGG_PEERS_FROM = the bridge's /_roots, the app's peer token" \
    homesh "e=~/.config/yggdrasil/yggdrasil.env; grep -qx 'YGG_ROOT_NAME=home-pc' \$e && grep -qx 'YGG_PEERS_FROM=http://127.0.0.1:7890/_roots' \$e && \
      [ \"\$(sed -n 's/^YGG_PEER_TOKEN=//p' \$e)\" = \"\$(sed -n 's/^YGG_PEER_TOKEN=//p' ~/.config/bifrost/app.env)\" ] && curl -s 127.0.0.1:4100/root | grep -q '\"name\":\"home-pc\"'"
  check h4 "from the internet: /pair 200, /api/* 401 at the edge, /_roots 404 (the trunk shows nothing private)" \
    outside "[ \"\$(curl -sk -o /dev/null -w '%{http_code}' https://$A/pair)\" = 200 ] && [ \"\$(curl -sk -o /dev/null -w '%{http_code}' https://$A/api/session)\" = 401 ] && \
      [ \"\$(curl -sk -o /dev/null -w '%{http_code}' https://$A/_roots)\" = 404 ]"

  # ------------------------------------------------------------------------------- the third machine
  docker run -d --name ot-mac --hostname mac-studio --network "$NET" --ip "$IP_MAC" \
    -v "$ROOT:/repo:ro" -v "$STATE/bin:/opt/bin:ro" -v "$STATE/sim:/sim" ubuntu:24.04 sleep infinity >/dev/null
  dx ot-mac bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3 ca-certificates curl >/dev/null && (id ubuntu >/dev/null 2>&1 || useradd -m ubuntu)' >"$STATE/log/mac-apt.log" 2>&1
  dx -u ubuntu ot-mac bash -c 'mkdir -p ~/mock && cd ~/mock && (setsid nohup python3 /repo/root/mock/mock_upstream.py 18397 >mock.log 2>&1 &) &&
    printf "YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18397\nYGG_UPSTREAM_STYLE=anthropic\nYGG_UPSTREAM_API_KEY=mock\nYGG_UPSTREAM_MODEL=mock\n" >~/model.env'

  # ------------------------------------------------------------------------------------------ phone
  say "stage a: the phone (Chromium) — pair, MAIN, join + approve, delegate, report home, revoke"
  run_phone full "https://$A" "$IP_A" "$STATE/sim/steps.tsv"; rc=$?
  check p "the phone walk through https://$A (table below; playwright exit $rc)" bash -c "[ $rc = 0 ]"

  # ------------------------------------------------------------------------- idempotency + rotation
  say "stage a: re-runs — install.sh --trunk twice, trunk.sh --rotate-token"
  SUM=$(reg_sum); BPID=$(homesh 'cat ~/.local/state/bifrost/run/yggdrasil.service.pid')
  install_home h5-again.log "$LINE_A"; rc=$?
  check h5 "install.sh --trunk (same line) again: exit 0, device registry unchanged, brain not restarted" \
    bash -c "[ $rc = 0 ] && [ '$(reg_sum)' = '$SUM' ] && [ \"\$(docker exec -u node ot-home cat /home/node/.local/state/bifrost/run/yggdrasil.service.pid)\" = '$BPID' ] && \
      grep -q 'trunk   https://$A/pair → 200' '$STATE/log/h5-again.log'"
  vps ot-vps-a "cd /root && $REL bash trunk.sh --rotate-token" >"$STATE/log/a6-rotate.log" 2>&1; rc=$?
  LINE_A2=$(line_of "$STATE/log/a6-rotate.log")
  sleep 4
  check a6 "trunk.sh --rotate-token: a new line, the same pin; the hub's old token is refused (503 from outside)" \
    bash -c "[ $rc = 0 ] && [ -n '$LINE_A2' ] && [ '$LINE_A2' != '$LINE_A' ] && [ '$(pin_of "$STATE/log/a6-rotate.log")' = '$PIN_A' ] && \
      [ \"\$(outside \"curl -sk -o /dev/null -w '%{http_code}' https://$A/pair\")\" = 503 ]"
  install_home h6-rotated.log "$LINE_A2"; rc=$?
  check h6 "install.sh --trunk '<the new line>': connected again (200), device registry unchanged" \
    bash -c "[ $rc = 0 ] && grep -q 'trunk   https://$A/pair → 200' '$STATE/log/h6-rotated.log' && [ '$(reg_sum)' = '$SUM' ]"
fi

# =========================================================================================== stage b
if stage b; then
  say "stage b: Let's Encrypt (Pebble) — certbot standalone on :80, from the trunk's own key"
  new_vps ot-vps-b "$IP_B" "$B"
  vps ot-vps-b 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq ufw >/dev/null && ufw allow 22/tcp >/dev/null && ufw --force enable >/dev/null' >"$STATE/log/b-ufw.log" 2>&1
  docker cp "$ROOT/trunk/install/trunk.sh" ot-vps-b:/root/trunk.sh >/dev/null
  docker cp "$STATE/bin/bifrost-net" ot-vps-b:/root/bifrost-net >/dev/null
  docker cp "$STATE/sim/pebble-acme-ca.pem" ot-vps-b:/root/pebble-acme-ca.pem >/dev/null
  PEB="REQUESTS_CA_BUNDLE=/root/pebble-acme-ca.pem"
  vps ot-vps-b "cd /root && $PEB bash trunk.sh --name $B --acme-server https://pebble:14000/dir --binary /root/bifrost-net" >"$STATE/log/b1-trunk.log" 2>&1; rc=$?
  LINE_B=$(line_of "$STATE/log/b1-trunk.log"); PIN_B=$(pin_of "$STATE/log/b1-trunk.log")
  check b1 "trunk.sh --acme-server <Pebble>: exit 0, a certificate from the ACME server, ufw 80 + 443 opened" \
    bash -c "[ $rc = 0 ] && [ -n '$LINE_B' ] && docker exec ot-vps-b openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -issuer | grep -qi pebble && \
      docker exec ot-vps-b ufw status | grep -q '^80/tcp.*ALLOW' && docker exec ot-vps-b ufw status | grep -q '^443/tcp.*ALLOW' && \
      docker exec ot-vps-b systemctl is-enabled -q yggdrasil-trunk-cert.timer"
  check b2 "an outsider verifies the chain against the ACME root (no -k): https://$B answers 503 (no hub yet)" \
    bash -c "[ \"\$(outside \"curl -s -o /dev/null -w '%{http_code}' --cacert /sim/pebble-root.pem https://$B/\")\" = 503 ]"
  SERIAL=$(vps ot-vps-b 'openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -serial')
  vps ot-vps-b "cd /root && /usr/local/sbin/yggdrasil-trunk --renew --force" >"$STATE/log/b3-renew.log" 2>&1; rc=$?
  check b3 "renewal (--renew --force, as the timer runs it): a new certificate, the SAME pin" \
    bash -c "[ $rc = 0 ] && [ \"\$(docker exec ot-vps-b openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -serial)\" != '$SERIAL' ] && \
      [ \"\$(docker exec ot-vps-b /usr/local/lib/yggdrasil-trunk/bifrost-net ap-pin /etc/yggdrasil-trunk/cert.pem)\" = 'pin = \"sha-256 $PIN_B\"' ] && \
      [ \"\$(outside \"curl -s -o /dev/null -w '%{http_code}' --cacert /sim/pebble-root.pem https://$B/\")\" = 503 ]"
  vps ot-vps-b 'systemctl start yggdrasil-trunk-cert.service' >"$STATE/log/b4-timer.log" 2>&1; rc=$?
  check b4 "the timer's unit runs clean: not due yet, nothing to do" \
    bash -c "[ $rc = 0 ] && docker exec ot-vps-b journalctl -u yggdrasil-trunk-cert -o cat --no-pager | grep -q 'nothing to do'"
  if [ -n "$(docker ps -q -f name=^ot-home$)" ]; then
    SUM=$(reg_sum)
    install_home h7-le.log "$LINE_B"; rc=$?
    check h7 "the hub moves to the Pebble trunk: health 200; an outsider gets /pair 200 with full chain validation" \
      bash -c "[ $rc = 0 ] && grep -q 'trunk   https://$B/pair → 200' '$STATE/log/h7-le.log' && [ \"\$(outside \"curl -s -o /dev/null -w '%{http_code}' --cacert /sim/pebble-root.pem https://$B/pair\")\" = 200 ] && \
        [ '$(reg_sum)' = '$SUM' ]"
  fi
fi

# =========================================================================================== stage c
if stage c; then
  say "stage c: a VPS whose :80 and :443 are a website (nginx) — trunk.sh --behind-proxy, Pebble through nginx"
  new_vps ot-vps-c "$IP_C" "$C" "$WWW"
  # shellcheck disable=SC2016  # $remote_addr is nginx's
  vps ot-vps-c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq nginx libnginx-mod-stream openssl curl >/dev/null &&
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /etc/nginx/www.key -out /etc/nginx/www.crt -days 30 \
      -subj /CN=www.tree.test -addext subjectAltName=DNS:www.tree.test 2>/dev/null &&
    cat >/etc/nginx/sites-enabled/default <<NGX
server { listen 80 default_server; server_name www.tree.test; location / { return 200 "WEBSITE OK (http)\n"; } }
server { listen 443 ssl default_server; server_name www.tree.test; ssl_certificate /etc/nginx/www.crt; ssl_certificate_key /etc/nginx/www.key;
         location / { return 200 "WEBSITE OK \$remote_addr\n"; } }
NGX
    nginx -t 2>/dev/null && systemctl restart nginx' >"$STATE/log/c-website.log" 2>&1
  docker cp ot-vps-c:/etc/nginx/www.crt "$STATE/sim/www.crt" >/dev/null; chmod 644 "$STATE/sim/www.crt"
  check c0 "the website answers on :443 and :80 before anything" \
    outside "curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | grep -q '^WEBSITE OK' && curl -s -m 5 http://$WWW/ | grep -q '^WEBSITE OK (http)'"
  docker cp "$ROOT/trunk/install/trunk.sh" ot-vps-c:/root/trunk.sh >/dev/null       # the single file again
  docker cp "$STATE/bin/bifrost-net" ot-vps-c:/root/bifrost-net >/dev/null
  docker cp "$STATE/sim/pebble-acme-ca.pem" ot-vps-c:/root/pebble-acme-ca.pem >/dev/null
  ENVC="REQUESTS_CA_BUNDLE=/root/pebble-acme-ca.pem TRUNK_RAW=http://files.tree.test:8000/raw"
  vps ot-vps-c "cd /root && $ENVC bash trunk.sh --name $C --acme-server https://pebble:14000/dir --binary /root/bifrost-net" >"$STATE/log/c1-busy.log" 2>&1; rc=$?
  check c1 "without --behind-proxy: refused (443 is nginx's), says --behind-proxy, nothing installed (not even a package), website up" \
    bash -c "[ $rc != 0 ] && grep -q 'taken by .nginx' '$STATE/log/c1-busy.log' && grep -q -- '--behind-proxy' '$STATE/log/c1-busy.log' && \
      ! grep -q 'apt-get install' '$STATE/log/c1-busy.log' && \
      ! docker exec ot-vps-c test -e /etc/systemd/system/yggdrasil-trunk.service && \
      [ \"\$(docker exec ot-files curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | cut -c1-10)\" = 'WEBSITE OK' ]"
  vps ot-vps-c "cd /root && $ENVC bash trunk.sh --name $C --behind-proxy --acme-server https://pebble:14000/dir --binary /root/bifrost-net" >"$STATE/log/c2-behind.log" 2>&1; rc=$?
  LINE_C=$(line_of "$STATE/log/c2-behind.log"); PIN_C=$(pin_of "$STATE/log/c2-behind.log")
  check c2 "--behind-proxy: ap on 127.0.0.1:4443 with proxy_protocol; nginx holds :80 → CERTIFICATE PENDING + the nginx snippet" \
    bash -c "[ $rc = 0 ] && [ -n '$LINE_C' ] && grep -q 'CERTIFICATE PENDING' '$STATE/log/c2-behind.log' && grep -q 'nginx holds port 80' '$STATE/log/c2-behind.log' && \
      docker exec ot-vps-c grep -qx 'listen = \"127.0.0.1:4443\"' /etc/yggdrasil-trunk/ap.toml && docker exec ot-vps-c grep -qx 'proxy_protocol = true' /etc/yggdrasil-trunk/ap.toml && \
      docker exec ot-vps-c test -x /usr/local/lib/yggdrasil-trunk/sni-443.py && \
      [ \"\$(docker exec ot-files curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | cut -c1-10)\" = 'WEBSITE OK' ]"
  # the user does what it printed: the server block into nginx, reload, re-run with --webroot
  awk '/nginx holds port 80/{f=1} f&&/^ *server \{/{p=1} p{print} p&&/^ *\}$/{exit}' "$STATE/log/c2-behind.log" | sed 's/^ *//' >"$STATE/sim/acme-snippet.conf"
  docker cp "$STATE/sim/acme-snippet.conf" ot-vps-c:/etc/nginx/conf.d/yggdrasil-trunk-acme.conf >/dev/null
  WR=$(sed -n 's/.*sudo bash trunk\.sh --webroot \([^ ]*\).*/\1/p' "$STATE/log/c2-behind.log" | head -1)
  vps ot-vps-c "nginx -t && systemctl reload nginx && cd /root && $ENVC bash trunk.sh --webroot $WR" >"$STATE/log/c3-webroot.log" 2>&1; rc=$?
  check c3 "the printed nginx snippet + trunk.sh --webroot: a certificate through nginx's :80, the same pin" \
    bash -c "[ $rc = 0 ] && ! grep -q 'CERTIFICATE PENDING' '$STATE/log/c3-webroot.log' && docker exec ot-vps-c openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -issuer | grep -qi pebble && \
      grep -q 'pin: sha-256 $PIN_C' '$STATE/log/c3-webroot.log' && [ \"\$(docker exec ot-files curl -s -m 5 http://$WWW/ | cut -c1-10)\" = 'WEBSITE OK' ]"
  # option A: the website moves to 127.0.0.1:8443, our router takes :443
  vps ot-vps-c "sed -i 's/listen 443 ssl default_server;/listen 127.0.0.1:8443 ssl default_server;/' /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx && sleep 1 && systemctl enable --now yggdrasil-sni-443" >"$STATE/log/c4-sni.log" 2>&1; rc=$?
  sleep 2
  check c4 "option A (sni-443.py on :443): the website still answers (its own cert), the trunk answers by name" \
    bash -c "[ $rc = 0 ] && [ \"\$(docker exec ot-files curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | cut -c1-10)\" = 'WEBSITE OK' ] && \
      [ \"\$(docker exec ot-files curl -s -o /dev/null -w '%{http_code}' --cacert /sim/pebble-root.pem https://$C/)\" = 503 ]"
  if [ -n "$(docker ps -q -f name=^ot-home$)" ]; then
    SUM=$(reg_sum)
    install_home h8-px.log "$LINE_C"; rc=$?
    check h8 "the hub on the trunk behind the router: health 200, registry unchanged" \
      bash -c "[ $rc = 0 ] && grep -q 'trunk   https://$C/pair → 200' '$STATE/log/h8-px.log' && [ '$(reg_sum)' = '$SUM' ]"
    say "stage c: the phone through the :443 router (pair, MAIN, revoke) — its region is its real address (PROXY v1)"
    run_phone short "https://$C" "$IP_C" "$STATE/sim/steps-c.tsv"; rc=$?
    check pc "the phone walk through https://$C behind sni-443.py (playwright exit $rc)" bash -c "[ $rc = 0 ]"
    # option B: nginx itself routes :443 by name (the printed stream block), PROXY v1 to both
    awk '/^ *stream \{/{p=1} p{print} p&&/^    \}$/{exit}' "$STATE/log/c2-behind.log" | sed 's/^    //' >"$STATE/sim/stream.conf"
    docker cp "$STATE/sim/stream.conf" ot-vps-c:/root/stream.conf >/dev/null
    vps ot-vps-c "systemctl disable --now yggdrasil-sni-443 && cat /root/stream.conf >>/etc/nginx/nginx.conf &&
      sed -i 's/listen 127.0.0.1:8443 ssl default_server;/listen 127.0.0.1:8443 ssl default_server proxy_protocol; set_real_ip_from 127.0.0.1; real_ip_header proxy_protocol;/' /etc/nginx/sites-enabled/default &&
      nginx -t && systemctl reload nginx" >"$STATE/log/c5-stream.log" 2>&1; rc=$?
    sleep 2
    # shellcheck disable=SC2016  # expanded on the home computer
    CODE=$(homesh 'curl -s -m 10 -X POST http://127.0.0.1:8082/api/pair/code -H "authorization: Bearer $(sed -n "s/^BIFROST_ADMIN_TOKEN=//p" ~/.config/bifrost/app.env)" -H "content-type: application/json" -d "{\"name\":\"curl\"}"' | python3 -c 'import json,sys,urllib.parse; u=json.load(sys.stdin)["url"]; print(urllib.parse.parse_qs(u.split("#")[1])["code"][0])' 2>/dev/null)
    CLAIM=$(outside "curl -s -m 10 --cacert /sim/pebble-root.pem -X POST https://$C/api/pair/claim -H 'content-type: application/json' -d '{\"code\":\"$CODE\",\"name\":\"via-nginx\"}'")
    check c5 "option B (nginx stream, the printed block): website answers with the client's real address; the trunk too (PROXY v1)" \
      bash -c "[ $rc = 0 ] && docker exec ot-files curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | grep -qx 'WEBSITE OK $IP_FILES' && \
        printf '%s' '$CLAIM' | grep -q '\"accessToken\":\"bfnd-' && \
        docker exec -u node ot-home cat /home/node/.local/state/bifrost/devices.json | python3 -c 'import json,sys; d=[x for x in json.load(sys.stdin)[\"devices\"] if x[\"name\"]==\"via-nginx\"]; sys.exit(0 if d and d[-1][\"region\"]==\"lan:$P.0/24\" else 1)'"
  fi
fi

# =========================================================================================== stage r
if stage r; then
  say "stage r: the REAL release from github.com/veraldar/yggdrasil (v$VER), sha256-checked"
  new_vps ot-vps-r "$IP_R" trunk-gh.tree.test
  docker cp "$ROOT/trunk/install/trunk.sh" ot-vps-r:/root/trunk.sh >/dev/null
  vps ot-vps-r "cd /root && bash trunk.sh --name trunk-gh.tree.test --self-signed --version v$VER" >"$STATE/log/r1-github.log" 2>&1; rc=$?
  check r1 "trunk.sh --version v$VER downloads bifrost-net-$VER-linux-x86_64 from GitHub, checks SHA256SUMS, runs it" \
    bash -c "[ $rc = 0 ] && grep -q 'binary: /usr/local/lib/yggdrasil-trunk/bifrost-net ← bifrost-net-$VER-linux-x86_64' '$STATE/log/r1-github.log' && \
      [ \"\$(docker exec ot-files curl -sk -o /dev/null -w '%{http_code}' https://trunk-gh.tree.test/)\" = 503 ]"
fi

# ====================================================================================== the table
echo
printf '%-5s %-4s %s\n' STEP "" WHAT
fails=0
while IFS=$'\t' read -r res id what detail; do
  printf '%-5s %-4s %s\n' "$id" "$res" "$what"
  [ "$res" = PASS ] || fails=$((fails + 1))
done <"$RESULTS"
for f in "$STATE/sim/steps.tsv" "$STATE/sim/steps-c.tsv"; do
  [ -s "$f" ] || continue
  echo "  phone ($(basename "$f" .tsv)):"
  while IFS=$'\t' read -r n res what detail; do
    printf '    %-5s %-4s %s\n' "$n" "$res" "$what"
    [ "$res" = PASS ] || { fails=$((fails + 1)); [ -n "$detail" ] && printf '           ↳ %s\n' "$detail"; }
  done <"$f"
done
echo "state + logs: $STATE"
if [ "$fails" != 0 ]; then echo "OWN-TRUNK: RED ($fails failed)"; exit 1; fi
echo "OWN-TRUNK: GREEN"
