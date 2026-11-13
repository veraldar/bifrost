#!/usr/bin/env bash
# launcher-test.sh — Veraldar-Setup.exe + launcher.bat + keepalive.vbs under wine, with a FAKE wsl.exe that
# records its arguments (no WSL here). Proves the Windows half's logic: install + shortcuts, the WSL gate,
# the hub asked once and remembered, wslpath for the script path, the exact bash command line, exit codes,
# --change-hub -> --rejoin, the keepalive's wsl.exe call, and the uninstaller stopping the root.
# What it cannot prove: real WSL, real Explorer, powershell's Desktop lookup (wine has no powershell, so
# the %USERPROFILE%\Desktop fallback is what runs here), real cmd's line-ending handling (see calls()).
#
#   win/launcher-test.sh [IMAGE]     a Debian image with wine (default veraldar-wine-check:local); apt adds mingw
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${1:-veraldar-wine-check:local}
[ -f "$HERE/Veraldar-Setup.exe" ] || { echo "build Veraldar-Setup.exe first (see veraldar.nsi)" >&2; exit 1; }

INNER=$(cat <<'INNER'
set -u
export DEBIAN_FRONTEND=noninteractive WINEPREFIX=/tmp/wp WINEDEBUG=-all DISPLAY=
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq gcc-mingw-w64-x86-64 >/dev/null 2>&1 || { echo "mingw install failed"; exit 1; }
cat > /tmp/wsl.c <<'C'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {   /* fake wsl.exe: one line per call, args joined by " | " */
    FILE *f = fopen("C:\\wsl-calls.txt", "a");
    for (int i = 1; i < argc; i++) fprintf(f, "%s%s", argv[i], i + 1 < argc ? " | " : "");
    fprintf(f, "\n"); fclose(f);
    const char *mode = getenv("FAKE_WSL");
    if (mode && !strcmp(mode, "missing")) return 1;
    if (argc >= 4 && !strcmp(argv[2], "wslpath")) { printf("WSLPATH(%s)\n", argv[argc - 1]); return 0; }
    if (argc >= 3 && !strcmp(argv[2], "bash")) { const char *rc = getenv("FAKE_RC"); return rc ? atoi(rc) : 0; }
    return 0;
}
C
x86_64-w64-mingw32-gcc -O2 -o /tmp/wsl.exe /tmp/wsl.c || exit 1
wineboot -i >/dev/null 2>&1 </dev/null
cp /tmp/wsl.exe "$WINEPREFIX/drive_c/windows/wsl.exe"   # C:\windows: on PATH, no WoW64 redirection
wine /w/Veraldar-Setup.exe /S >/dev/null 2>&1 </dev/null
U=$WINEPREFIX/drive_c/users/root
I=$U/AppData/Local/Veraldar
CALLS=$WINEPREFIX/drive_c/wsl-calls.txt
pass=0 fail=0
check() { # check NAME STATUS
  if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  PASS  $1"
  else fail=$((fail + 1)); echo "  FAIL  $1"; printf '%s\n' "${OUT:-}" | tail -6; tail -3 "$CALLS" 2>/dev/null; fi
}
run_rc() { # the batch's exit code (the pipeline above reports tr's)
  : > "$CALLS"
  (cd "$I" && printf "$1" | timeout 90 wine cmd /c launcher.bat ${2:-} >/tmp/out 2>&1); RC=$?
  OUT=$(tr -d '\r' </tmp/out)
}
# wine's cmd keeps the CR/LF of a set /p or for /f line inside the variable (real cmd strips it), so a
# value can arrive with a line break in it; wsl-bootstrap.sh strips CR/LF/blanks from --hub (join-test.py
# checks that). Calls are compared with CR/LF inside arguments removed.
calls() { tr -d '\r' < "$CALLS" | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n | / | /g'; }
last_bash() { calls | grep -F ' | bash | ' | tail -1; }
hubtxt() { tr -d '\r' < "$I/hub.txt"; }
BOOT='WSLPATH(C:\users\root\AppData\Local\Veraldar\wsl-bootstrap.sh)'
QR='C:\users\root\Desktop\Veraldar-Join-QR.png'
WANT="-e | bash | $BOOT | --hub | https://hub.example.org | --branch | main | --repo | https://github.com/veraldar/yggdrasil.git | --qr-win | $QR"

echo "[install]"
[ -f "$I/launcher.bat" ] && [ -f "$I/wsl-bootstrap.sh" ] && [ -f "$I/keepalive.vbs" ] && [ -f "$I/README.txt" ]
check 'installer: launcher.bat, wsl-bootstrap.sh, keepalive.vbs, README.txt in %LOCALAPPDATA%\Veraldar' $?
[ "$(find "$U" -iname '*Veraldar*.lnk' | wc -l)" = 5 ] && [ -f "$U/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/StartUp/Veraldar root.lnk" ]
check 'installer: Desktop + 3 Start menu shortcuts + "Veraldar root" in Startup' $?
! grep -q $'\r' "$I/wsl-bootstrap.sh" && grep -q $'\r' "$I/launcher.bat"
check 'installer: wsl-bootstrap.sh has LF line endings, launcher.bat CRLF' $?

echo "[launcher]"
FAKE_WSL=missing run_rc '\n'
[ "$RC" = 2 ] && grep -q 'wsl --install -d Ubuntu' <<<"$OUT"
check 'no WSL: exit 2 with the exact install command' $?
run_rc 'https://hub.example.org\n\n'
[ "$RC" = 0 ] && grep -q 'Hub address' <<<"$OUT"
check 'first run: asks for the hub, exit 0' $?
[ "$(hubtxt)" = https://hub.example.org ]
check 'first run: hub remembered in hub.txt' $?
[ "$(last_bash)" = "$WANT" ]
check 'first run: wsl.exe -e bash <wslpath of the script> --hub --branch main --repo --qr-win <Desktop png>' $?
grep -qF -- '-e | wslpath | -a | -u | C:\users\root\AppData\Local\Veraldar\wsl-bootstrap.sh' "$CALLS"
check 'first run: wslpath got the installed script path' $?
sleep 5
grep -qF -- '-e | sh | -c | s=$HOME/.local/share/yggdrasil-root/bin/start; [ -x $s ] && exec $s --hold' "$CALLS"
check 'first run: keepalive.vbs ran wsl.exe -e sh -c "...bin/start --hold"' $?
run_rc '\n'
[ "$RC" = 0 ] && ! grep -q 'Hub address' <<<"$OUT" && [ "$(last_bash)" = "$WANT" ]
check 'second run: no question, the same command line from hub.txt' $?
run_rc 'https://other.example\n\n' --change-hub
[ "$RC" = 0 ] && last_bash | grep -qF -- '--hub | https://other.example |' && last_bash | grep -q ' | --rejoin$' && [ "$(hubtxt)" = https://other.example ]
check '--change-hub: asks again, passes --rejoin, remembers the new hub' $?
FAKE_RC=3 run_rc '\n'
[ "$RC" = 3 ] && grep -q refused <<<"$OUT"
check 'refused on the phone (3): exit 3, says so' $?
FAKE_RC=4 run_rc '\n'
[ "$RC" = 4 ] && grep -q expired <<<"$OUT"
check 'expired (4): exit 4, says so' $?
FAKE_RC=1 run_rc '\n'
[ "$RC" = 1 ] && grep -q bootstrap.log <<<"$OUT"
check 'other failure: exit code passed on, points at bootstrap.log' $?
rm -f "$I/hub.txt"
run_rc 'ftp://nope\n\n'
[ "$RC" = 64 ] && [ ! -f "$I/hub.txt" ] && [ -z "$(last_bash)" ]
check 'a hub that is not http(s): exit 64, nothing remembered, no join started' $?

echo "[uninstall]"
: > "$CALLS"
wine "$I/Uninstall.exe" /S >/dev/null 2>&1 </dev/null
sleep 4
grep -qF -- '-e | sh | -c | s=$HOME/.local/share/yggdrasil-root/bin/stop; [ -x $s ] && $s' "$CALLS"
check 'uninstall: stops the root inside WSL (bin/stop)' $?
[ ! -d "$I" ] && [ "$(find "$U" -iname '*Veraldar*.lnk' | wc -l)" = 0 ]
check 'uninstall: files, hub.txt and all shortcuts gone' $?
echo; echo "$pass/$((pass + fail)) checks passed"
[ "$fail" = 0 ]
INNER
)
exec docker run --rm -v "$HERE:/w:ro" --entrypoint bash "$IMAGE" -c "$INNER"
