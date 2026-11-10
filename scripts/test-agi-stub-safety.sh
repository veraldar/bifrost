#!/usr/bin/env bash
# test-agi-stub-safety.sh — agi-run: (a) typo'd artifact dir refused rc2, no unit/will;
# (b) a live name-keyed unit + dead-pid will → lane exit writes NO stub, no status line.
set -u
R="$(cd "$(dirname "$0")" && pwd)/agi-run.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/wills" "$T/log" "$T/art"
printf '#!/bin/sh\nexit 0\n' >"$T/bin/claude"
# fake systemctl: list-units reports a running agi-lane-<s>-* unit when FAKE_LIVE=1
cat >"$T/bin/systemctl" <<'F'
#!/bin/sh
case "$*" in *list-units*) [ "${FAKE_LIVE:-0}" = 1 ] && echo "agi-lane-t1-999.service loaded active running fake";; esac
exit 0
F
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" AGI_SYSTEMD=0 AGI_BIN="$T/bin/claude" AGI_WILL_DIR="$T/wills" AGI_LOG_DIR="$T/log" AGI_STATUS_FILE="$T/status.tsv" AGI_PUSH_URL="" AGI_LETTER_DIR="$T/letters"
fail=0
# a) typo dispatch
FAKE_LIVE=0 "$R" -s t1 -a /nonexistent-dir/x.md "p" >"$T/a.out" 2>&1; rc=$?
[ "$rc" = 2 ] && grep -q "nonexistent-dir" "$T/a.out" && [ -z "$(ls "$T/wills")" ] && echo "PASS a: typo refused rc2, no will" || { echo "FAIL a rc=$rc"; cat "$T/a.out"; fail=1; }
# b) live unit owns the artifact → no stub
printf 'pid=999999\nunit=none\n' >"$T/wills/t1.will"
FAKE_LIVE=1 "$R" -s t1 -a "$T/art/x.md" "p" >"$T/b.out" 2>&1
[ ! -e "$T/art/x.md" ] && ! grep -q FAILED-STUB "$T/status.tsv" 2>/dev/null && echo "PASS b: live unit, no stub, no status line" || { echo "FAIL b"; cat "$T/b.out"; fail=1; }
# control: no live unit → stub written
rm -f "$T/wills/"*; FAKE_LIVE=0 "$R" -s t1 -a "$T/art/y.md" "p" >"$T/c.out" 2>&1
[ -e "$T/art/y.md" ] && echo "PASS c: control stubs when no owner" || { echo "FAIL c"; cat "$T/c.out"; fail=1; }
exit $fail
