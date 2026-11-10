#!/usr/bin/env bash
# grade.sh — fake-nous grades sub answers against ground truth, computes the
# metric table from the latest run-*/results.tsv. Bash+awk, no product lines.
set -uo pipefail
LAB="$(cd "$(dirname "$0")" && pwd)"
RUN=$(ls -1d "$LAB"/run-* 2>/dev/null | sort | tail -1)
[ -n "$RUN" ] || { echo "no run dir"; exit 1; }

# ---- grading: deterministic checks against ground truth ---------------------
score() { # slug, answer-text -> CORRECT|WRONG
  local text="$2" low
  low=$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]')
  case "$1" in
    brand-banned-words)
      local n=0 w
      for w in revolutionary seamless "ai-powered" magic empower cutting-edge \
               enterprise-grade "blazing fast" game-changing; do
        printf '%s' "$low" | grep -q "$w" && n=$((n+1))
      done
      [ "$n" -eq 9 ] && echo CORRECT || echo "WRONG ($n/9)"
      ;;
    commit-types)
      # "type" is ambiguous: semantic grouping merges run+run-scripts (run=6),
      # mechanical first-tokens keep them apart (top-2 = docs=5, drift-guard=3).
      # docs=5 is unambiguous under both readings -> exact match = PARTIAL floor.
      if printf '%s' "$low" | grep -q 'docs=5'; then
        if printf '%s' "$low" | grep -qE 'drift-guard=3|run=5'; then
          echo "PARTIAL (docs=5 exact; top-2 rest is interpretation: drift-guard=3 mechanical vs run=5 semantic)"
        else echo "PARTIAL (docs=5 exact, pairing unverified)"; fi
      else echo "WRONG"; fi
      ;;
    versions-v6)
      printf '%s' "$low" | grep -q 'incident' && printf '%s' "$low" | grep -q 'environment' \
        && printf '%s' "$low" | grep -q 'usage' && echo CORRECT || echo "WRONG"
      ;;
  esac
}

echo "## Answer grading (async arm, ground-truthed)"
awk -F'\t' '$1=="async"' "$RUN/results.tsv" | while IFS=$'\t' read -r arm slug _ _ _ outcome ab _; do
  printf -- '- %s: %s' "$slug" "$outcome"
  if [ "$outcome" = done ]; then
    text=$(awk '/^```$/{f=!f;next} f' "$LAB/reports/$slug.md")
    printf ' — %s\n' "$(score "$slug" "$text")"
  else printf '\n'; fi
done

# ---- latency stats ----------------------------------------------------------
stat() { # arm, col
  awk -F'\t' -v a="$1" -v c="$2" '$1==a {print $c}' "$RUN/results.tsv" | sort -n | awk '
    {v[NR]=$1} END {
      if (NR==0) { print "n/a"; exit }
      p50=v[int((NR+1)*0.5)]; p95=v[int((NR*0.95+0.5))];
      printf "p50=%dms p95=%dms (n=%d)", p50, p95, NR }'
}
echo
echo "## Latency (async vs sync)"
printf 'spawn_latency: %s\n' "$(stat async 3)"
printf 'sync_blocking: %s\n' "$(stat sync 4)"
