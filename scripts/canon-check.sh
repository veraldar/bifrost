#!/usr/bin/env bash
# canon-check.sh — CONSTRUCT canon conformance scan (owner [RUN] canon-enforce, 10-31).
# Canon: docs/CONSTRUCT.md — veraldar=org, yggdrasil=product; root=brain, trunk=private
# line, branch=app; bifrost=first branch. WIRING: every future report must carry one line
# of this output (`CANON  <tree>  PASS|FAIL  …`); FAIL without a drift note = refuse.
#
# Usage: canon-check.sh [TREE…]   (default: ~/Work/bifrost ~/Work/bifrost-sandbox ~/Work/yggdrasil)
# Exit 0 = no live FAIL · exit 1 = any FAIL. Reasons name file/branch/path per breach class:
#   trunk-in-bifrost        trunk* path/branch inside a non-product tree            [FAIL]
#   brain=yggdrasil         header text calling yggdrasil the brain (negations skip) [FAIL live / HIST frozen]
#   non-canon level         release/vN-style branch levels (releases are tags)       [FAIL]
#   dead map                "roots = the network" (09-30 map, DEAD per canon)        [FAIL live / HIST frozen]
#   bifrost=org             text calling bifrost the organization/whole system       [FAIL live / HIST frozen]
#   lore-in-structure       Midgard/Asgard in README headers (garnish, never structure)
# Severity: findings in docs/reviews/, artifacts/, or the frozen scaffold copies
# (yggdrasil root|trunk|branch) are HIST — cataloged, not blocking (canon: old docs
# are superseded, not rewritten). Live READMEs, refs, paths, canon-file = FAIL.
# The canon header sentence itself ("CANON: Veraldar=org…") is excluded — it IS the contract.
set -u
CANON_SHA="3a37c2945973b2e0cc56f29cd22e3d04d6f35f3d6c91de96e2fb22e681f7e76e"
ALL=0; TREES=()
for a in "$@"; do case "$a" in --all) ALL=1 ;; *) TREES+=("$a") ;; esac; done

# scan targets: README headers + report/review headers (first lines only — lore bodies exempt)
header_files() { # $1 = tree  → NUL-separated file list
  find "$1" \( -name .git -o -name node_modules -o -name .next -o -name target \
    -o -name dist -o -name .venv -o -name __pycache__ -o -name brand \) -prune -o \
    -type f \( -name 'README*.md' -o -name '*report*.md' -o -path '*/docs/reviews/*.md' \) \
    -print0 2>/dev/null
}

rc=0
(( ${#TREES[@]} == 0 )) && TREES=("$HOME/Work/bifrost" "$HOME/Work/bifrost-sandbox" "$HOME/Work/yggdrasil")
for tree in "${TREES[@]}"; do
  T="${tree%/}"
  name="$(basename "$T")"
  reasons=()
  [ -d "$T" ] || { printf 'CANON  %-18s SKIP   no such tree\n' "$name"; continue; }

  # 0 · canon file present + sha matches
  if [ -f "$T/docs/CONSTRUCT.md" ]; then
    sha="$(sha256sum "$T/docs/CONSTRUCT.md" | cut -d' ' -f1)"
    [ "$sha" = "$CANON_SHA" ] || reasons+=("canon file sha mismatch: docs/CONSTRUCT.md")
  else
    reasons+=("canon file missing: docs/CONSTRUCT.md")
  fi

  # 1 · branch/tag names — non-canon levels, trunk-in-bifrost
  if git -q -C "$T" rev-parse --git-dir >/dev/null 2>&1; then
    while IFS= read -r ref; do
      [[ "$ref" =~ (^|/)release/v?[0-9] ]] && reasons+=("non-canon level: ref '$ref' (releases are tags, not hierarchy)")
      case "$name" in yggdrasil) ;; *) [[ "$ref" == *trunk* ]] && reasons+=("trunk-in-bifrost: ref '$ref'") ;; esac
    done < <( { git -C "$T" branch -a --format='%(refname:short)'; git -C "$T" tag; } 2>/dev/null | sort -u )
  fi

  # 2 · repo paths — trunk* directories outside the product repo
  case "$name" in
    yggdrasil) ;;  # trunk/ IS canon there
    *)
      while IFS= read -r p; do reasons+=("trunk-in-bifrost: path '$p'"); done < <(
        find "$T" \( -name .git -o -name node_modules -o -name .next -o -name target -o -name dist \) -prune \
        -o -type d -name 'trunk*' -print 2>/dev/null | head -5)
      ;;
  esac

  # 3 · README/report headers — naming breaches (skip negation lines and the canon header itself)
  mapfile -t hits < <(
    while IFS= read -r -d '' f; do
      hit="$(head -c 4000 "$f" 2>/dev/null | grep -Eiav 'never|not the|isn.t|^ *>? *CANON: Veraldar=org' | grep -Eain \
        -e 'yggdrasil[^.]{0,60}\bbrain\b|\bbrain\b[^.]{0,60}yggdrasil' \
        -e 'roots? *= *the +network|the +roots +are +the +network' \
        -e 'bifrost[^.]{0,40}\b(organization|whole +system)\b' \
        -e '\bmidgard\b|\basgard\b' 2>/dev/null | head -1)"
      [ -n "$hit" ] && printf '%s: %s\n' "${f#"$T"/}" "$hit"
    done < <(header_files "$T")
  )
  for h in "${hits[@]:-}"; do
    [ -n "$h" ] || continue
    case "$h" in
      *brain*)  cls="brain=yggdrasil" ;;
      *network*) cls="dead map" ;;
      *organization*|*system*) cls="bifrost=org" ;;
      *midgard*|*asgard*) cls="lore-in-structure" ;;
      *) continue ;;
    esac
    case "$h" in
      *docs/reviews/*|*artifacts/*) reasons+=("HIST $cls: $h") ;;  # dated reviews/reports = frozen
      root/*|trunk/*|branch/*) reasons+=("HIST $cls: $h") ;;        # frozen scaffold copies
      *) reasons+=("$cls: $h") ;;
    esac
  done

  live=0; hist=0
  for r in "${reasons[@]:-}"; do
    [ -n "$r" ] || continue
    case "$r" in HIST\ *) hist=$((hist+1)) ;; *) live=$((live+1)) ;; esac
  done
  if [ "$live" -eq 0 ]; then
    printf 'CANON  %-18s PASS   construct ok' "$name"
    [ "$hist" -gt 0 ] && printf ' (%d HIST note%s — frozen docs, cataloged in the drift letter)' "$hist" "$([ "$hist" -eq 1 ] || echo s)"
    printf ' (%s)\n' "$(date -u +%FT%TZ)"
    [ "$ALL" = 1 ] && [ "$hist" -gt 0 ] && printf '  - %s\n' "${reasons[@]}"
  else
    printf 'CANON  %-18s FAIL   %d live reason(s)' "$name" "$live"
    [ "$hist" -gt 0 ] && printf ' + %d HIST' "$hist"
    printf '\n'
    printf '  - %s\n' "${reasons[@]}"
    rc=1
  fi
done
exit "$rc"
