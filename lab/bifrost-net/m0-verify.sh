#!/usr/bin/env bash
# bifrost-net M0 verification — one command, one verifiable output.
# Refuses to lie: a FAIL or a missing line exits non-zero.
set -euo pipefail
cd "$(dirname "$0")"

echo "== bifrost-net M0 =="
cargo build --release

OUT="$(./target/release/bifrost-net)"
echo "$OUT"

echo "$OUT" | grep -q "M0.1 PASS" || { echo "VERIFY: FAIL (mesh)"; exit 1; }
echo "$OUT" | grep -q "M0.2 PASS" || { echo "VERIFY: FAIL (echo)"; exit 1; }
echo "$OUT" | grep -q "M0 VERDICT: GREEN" || { echo "VERIFY: FAIL (verdict)"; exit 1; }
echo "VERIFY: 3/3 PASS"
