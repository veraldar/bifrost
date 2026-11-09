@echo off
REM launcher.bat — the one double-click: bring up Veraldar, show the QR, open the join URL.
REM Installed by win/veraldar.nsi into %LOCALAPPDATA%\Veraldar\.
REM Inner logic (proven on Linux via the bash twin, artifacts/win-qr-sim2-report.md):
REM   1. find WSL2 + a Linux user distro          -> else: tell the user to install it, exit 2
REM   2. drive wsl-bootstrap.sh inside WSL2        -> stage up, pair minted, QR png written
REM   3. the QR lands on the WINDOWS Desktop       -> the user scans it with their phone
REM   4. open the same join URL in the default browser (desktop preview of the phone flow)
setlocal EnableExtensions

set "INSTD=%~dp0"
set "BASE=8195"
set "BOOTSH=%INSTD%wsl-bootstrap.sh"
set "WSLBASE=%INSTD%wsl"
set "QRDIR=%USERPROFILE%\Desktop"
set "QRFILE=%QRDIR%\Veraldar-Pair-QR.png"

echo [veraldar] starting: stage ports %BASE%-%BASE%+4, QR png %QRFILE%

REM ---- 1. WSL2 present? (first-run gap, stated plainly, no silent death) ----
wsl.exe --status >nul 2>&1
if errorlevel 1 (
  echo [veraldar] WSL2 is missing.
  echo [veraldar] Install it once with:   wsl --install -d Ubuntu
  echo [veraldar] then reboot and double-click this shortcut again.
  timeout /t 15 >nul
  exit /b 2
)

REM ---- 2. bootstrap inside WSL2; QR png written straight to the Windows Desktop ----
REM (%USERPROFILE%\Desktop seen from WSL via the automounted C: drive; the bash
REM script resolves it to the Linux-side path it can actually write.)
wsl.exe -- bash -c "chmod +x '%WSLBASE:\=/%/wsl-bootstrap.sh' 2>/dev/null; '%WSLBASE:\=/%/wsl-bootstrap.sh' --qr-dir '%QRDIR:\=/%' --print-qr-file '%QRFILE:\=/%' --ports %BASE%"
if errorlevel 1 (
  echo [veraldar] bootstrap FAILED - see the log: %WSLBASE%\bootstrap.log
  timeout /t 30 >nul
  exit /b 1
)

REM ---- 3. the join URL: the payload the QR encodes (written by the bootstrap) ----
set /p JOINURL=<"%WSLBASE%\join-url.txt"
echo [veraldar] join URL: %JOINURL%

REM ---- 4. open it (browser preview on the desktop; the phone scans the QR) ----
start "" "%JOINURL%"

echo [veraldar] UP. Scan the QR with your phone ^(same Wi-Fi^): %QRFILE%
timeout /t 20 >nul
exit /b 0
