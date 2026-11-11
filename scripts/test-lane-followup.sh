#!/usr/bin/env bash
# E2E for lane-followup.sh (better-loops): scratch artifacts + chain dir; the "agi-run" is a stub that
# starts a REAL transient unit agi-lane-<SESSION>-<pid>.service (sleep) so the live-unit dedupe is genuine.
set -u
HERE="$(dirname "$(readlink -f "$0")")"
T=$(mktemp -d); export LF_ART_DIR=$T/art LF_CHAIN_DIR=$T/ch LF_LOG_DIR=$T/log STATUS_FILE=$T/status AGI_WILL_DIR=$T/wills
mkdir -p "$LF_ART_DIR" "$LF_CHAIN_DIR" "$LF_LOG_DIR"; : >"$STATUS_FILE"
cat >"$T/fakerun" <<'S'
#!/usr/bin/env bash
while getopts "s:m:f:a:b:" o; do [ "$o" = s ] && s=$OPTARG; done
systemd-run --user --quiet --unit="agi-lane-$s-$$" -- sleep 60
S
chmod +x "$T/fakerun"; export LF_AGI_RUN="$T/fakerun"
fail=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
C=lfscratch$$; units() { systemctl --user list-units "agi-lane-$1-*" --no-legend --no-pager | wc -l; }
trap 'systemctl --user stop "agi-lane-${C^^}-*" 2>/dev/null; systemctl --user stop "agi-lane-${C}-*" 2>/dev/null; rm -rf "$T"' EXIT
printf '# %s-r1 — VERDICT: PARTIAL. thing half done\n- Next-actions: wire the digest prefetch; rerun gate\n' "$C" >"$LF_ART_DIR/$C-r1.md"
"$HERE/lane-followup.sh" "$LF_ART_DIR/$C-r1.md" >/dev/null; sleep 1
[ "$(units "${C^^}-R2")" -ge 1 ] && ok "PARTIAL dispatches, unit appears" || bad "no unit"
[ "$(cat "$LF_CHAIN_DIR/$C.n")" = 1 ] && ok "counter=1" || bad "counter"
grep -q "wire the digest prefetch" "$LF_CHAIN_DIR/$C.r2.prompt" && ok "brief cites next-actions line" || bad "brief"
"$HERE/lane-followup.sh" "$LF_ART_DIR/$C-r1.md" | grep -q dedupe && [ "$(cat "$LF_CHAIN_DIR/$C.n")" = 1 ] && ok "second call dedupes" || bad "dedupe"
systemctl --user stop "agi-lane-${C^^}-R2-*" 2>/dev/null; rm -f "$LF_CHAIN_DIR/$C.last"
"$HERE/lane-followup.sh" "$LF_ART_DIR/$C-r1.md" | grep -q DISPATCH && ok "after lane gone, re-dispatch (2/3)" || bad "redispatch"
printf '# %sg-r1 — VERDICT: DONE-GREEN. ok\n' "$C" >"$LF_ART_DIR/${C}g-r1.md"
"$HERE/lane-followup.sh" "$LF_ART_DIR/${C}g-r1.md" | grep -q "terminates" && [ ! -f "$LF_CHAIN_DIR/${C}g.n" ] && ok "DONE-GREEN no dispatch" || bad "green"
printf '# %so-r1 — VERDICT: OWNER-GATED. waits\n' "$C" >"$LF_ART_DIR/${C}o-r1.md"
"$HERE/lane-followup.sh" "$LF_ART_DIR/${C}o-r1.md" | grep -q "terminates" && ok "OWNER-GATED no dispatch" || bad "gated"
printf '# %sx-r2 — PARTIAL: x\n' "$C" >"$LF_ART_DIR/${C}x-r2.md"; echo 3 >"$LF_CHAIN_DIR/${C}x.n"; printf 'PARTIAL\nRIG\nPARTIAL\n' >"$LF_CHAIN_DIR/${C}x.v"
"$HERE/lane-followup.sh" "$LF_ART_DIR/${C}x-r2.md" >/dev/null; "$HERE/lane-followup.sh" "$LF_ART_DIR/${C}x-r2.md" >/dev/null
[ "$(grep -c "chain-escalate ${C}x — 3 attempts: " "$STATUS_FILE")" = 1 ] && [ "$(units "${C^^}X-R3")" = 0 ] && ok "counter 3: ONE escalate row, no dispatch" || bad "escalate"
echo ".done" ; touch "$LF_CHAIN_DIR/${C}d.done"; printf '# %sd — PARTIAL: x\n' "$C" >"$LF_ART_DIR/${C}d.md"
"$HERE/lane-followup.sh" "$LF_ART_DIR/${C}d.md" | grep -q override && ok ".done override" || bad "override"
exit $fail
