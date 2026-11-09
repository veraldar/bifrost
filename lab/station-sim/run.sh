#!/usr/bin/env bash
# station-sim runner. usage: run.sh [case-number ...]   (default: all cases)
# Scratch only: SIMDIR (default /tmp/station-sim-r1). Never touches the real station.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SIMDIR="${SIMDIR:-/tmp/station-sim-r1}"
mkdir -p "$SIMDIR"; rows="$SIMDIR/rows.txt"; : >"$rows"
sel=("$@"); rc=0
for c in "$HERE"/cases/*.sh; do
  n=$(basename "$c" | cut -c1-2)
  if [ ${#sel[@]} -gt 0 ]; then case " ${sel[*]} " in *" $n "*|*" ${n#0} "*) ;; *) continue ;; esac; fi
  echo "== case $n: $(basename "$c" .sh)"
  timeout 300 bash "$c" 2>&1 | tee -a "$SIMDIR/run.log"
  [ "${PIPESTATUS[0]}" -ne 0 ] && rc=1
  [ -f "$SIMDIR/c$n/row" ] && cat "$SIMDIR/c$n/row" >>"$rows" || echo "ROW|$n|$(basename "$c" .sh)|(no result)|FAIL(crashed)" >>"$rows"
done
echo "--- table ($rows)"; cat "$rows"; exit $rc
