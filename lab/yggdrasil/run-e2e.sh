#!/usr/bin/env bash
# Slice-3 referee: bifrost's own e2e suite (pwa/e2e, unmodified) driving yggdrasil.
# Runs inside a private network namespace (unshare -rn): yggdrasil owns 127.0.0.1:4096
# and the PWA owns :8080 *inside* it, so even specs that hardcode opencode's port hit
# yggdrasil — and the live opencode/lk-pwa on the host are never touched.
# The PWA is the live production build (.next copied, never rebuilt) started from a
# scratch cwd (run/pwa) so its .oc-live/.oc-queue/.diag/.push-subs/artifacts files are
# the lab's own. Extra args go to `playwright test` (e.g. a spec file name).
set -euo pipefail
LAB=$(cd "$(dirname "$0")" && pwd); PWA=$(cd "$LAB/../../pwa" && pwd); RUN=$LAB/run
if [ -z "${YGG_NETNS:-}" ]; then
  source ~/.cargo/env; (cd "$LAB" && cargo build --release -q)
  rm -rf "$RUN"; mkdir -p "$RUN/pwa" "$RUN/artifacts"
  rsync -a --exclude cache "$PWA/.next" "$RUN/pwa/"
  for f in node_modules public package.json next.config.ts .env.local; do ln -s "$PWA/$f" "$RUN/pwa/$f"; done
  exec unshare -rn env YGG_NETNS=1 "$0" "$@"
fi
ip link set lo up
trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
# ~2s to first token, like a real provider: several specs assert getByText('pong'), which
# also matches the prompt echo — an instant reply makes that a strict-mode violation
MOCK_LATENCY=2 python3 "$LAB/mock/mock_upstream.py" 18080 >"$RUN/mock.log" 2>&1 &
YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18080/v1 YGG_UPSTREAM_MODEL=mock YGG_CATALOG="$LAB/fixtures/catalog.json" \
  YGG_DATA_DIR="$RUN/data" YGG_LISTEN=127.0.0.1:4096 "$LAB/target/release/yggdrasil" >"$RUN/ygg.log" 2>&1 &
(cd "$RUN/pwa" && OPENCODE_URL=http://127.0.0.1:4096 exec node node_modules/next/dist/bin/next start -p 8080 -H 127.0.0.1) >"$RUN/pwa.log" 2>&1 &
for _ in $(seq 100); do curl -sf 127.0.0.1:4096/session >/dev/null && curl -sf -o /dev/null 127.0.0.1:8080/ && break; sleep 0.2; done
# the artifacts gallery spec expects html designs on disk (the live dir always has some)
printf '<!doctype html><title>seed</title><h1>seed design</h1>\n' >"$RUN/artifacts/seed-design.html"
# the home specs need one existing session row (a real install always has some)
SEED=$(curl -sf -X POST 127.0.0.1:4096/session -H 'content-type: application/json' -d '{"title":"seed"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sf -X POST "127.0.0.1:4096/session/$SEED/message" -H 'content-type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello yggdrasil"}]}' >/dev/null
cd "$RUN/pwa" && "$PWA/node_modules/.bin/playwright" test -c "$LAB/e2e.config.mjs" "$@"
