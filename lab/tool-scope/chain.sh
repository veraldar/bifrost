#!/usr/bin/env bash
# Sequential V2 completion (10-28, after the 429 incident): one variant at a time, like the
# prompt-only arm. Stops at the first watchdog trip.
set -u
cd "$(dirname "$0")"
BIN=$HOME/.cache/tool-scope/yggdrasil-38b74c2
touch /tmp/tool-scope-chain.running
tripped() { grep -q TRIPPED runs/watchdog.log 2>/dev/null; }
python3 -u tp_enforced.py B 4122 3 t3-typo,t4-spawn-lab,t5-refactor >> runs/tp-enforced-B.log 2>&1
tripped && { rm -f /tmp/tool-scope-chain.running; exit 1; }
systemctl --user stop agg-tool-scope-tpc; rm -rf /tmp/tool-scope-store/tpc
TS_BIN=$BIN TS_MAX_STEPS=12 TS_ROLLUP=0 ./boot.sh tpc 4123 /tmp/toolpolicy/TS-C /tmp/toolpolicy/TS-C/POLICY.md seed >> runs/chain.log 2>&1
python3 -u tp_enforced.py C 4123 3 >> runs/tp-enforced-C.log 2>&1
tripped && { rm -f /tmp/tool-scope-chain.running; exit 1; }
systemctl --user stop agg-tool-scope-pressure; rm -rf /tmp/tool-scope-store/pressure
TS_BIN=$BIN TS_MAX_STEPS=12 TS_ROLLUP=0 ./boot.sh pressure 4121 /tmp/toolpolicy/TS-P /tmp/toolpolicy/TS-P/POLICY.md >> runs/chain.log 2>&1
python3 -u pressure.py 4121 3 >> runs/pressure.log 2>&1
rm -f /tmp/tool-scope-chain.running
echo "chain done $(date +%T)" >> runs/chain.log
