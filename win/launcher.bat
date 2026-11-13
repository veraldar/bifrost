@echo off
REM launcher.bat - Veraldar: join this Windows PC to your tree as a root. Double-click it.
REM The root runs inside WSL2 (Ubuntu) and only DIALS OUT to your hub: no open port, no firewall rule.
REM   1. WSL2 with a Linux distribution?   no: prints the one install command and stops
REM   2. the hub address                   asked once, remembered in hub.txt next to this file
REM   3. wsl-bootstrap.sh inside WSL2      gets the code (REPO / BRANCH below) and runs root/install/join.sh:
REM                                        the QR shows in this window AND on your Desktop
REM   4. scan the QR with your paired phone and approve; the root starts and stays up (keepalive.vbs)
REM   launcher.bat --change-hub            forget the hub, ask again, join that one instead
REM Exit: 0 joined and running, 2 WSL missing, 3 refused on the phone, 4 expired, else see the log.
setlocal EnableExtensions
set "BRANCH=main"
set "REPO=https://github.com/veraldar/yggdrasil.git"
set "APPDIR=%~dp0"
set "HUBFILE=%APPDIR%hub.txt"
set "REJOIN="
title Veraldar - join this PC to your tree
echo.
echo  Veraldar: this PC joins your tree as a root.
echo.

REM ---- 1. WSL2 and a Linux distribution ------------------------------------------------
wsl.exe --status >nul 2>&1
if errorlevel 1 goto :nowsl
wsl.exe -e true >nul 2>&1
if errorlevel 1 goto :nowsl

REM ---- 2. the hub: asked once, remembered (read back with for /f: no stray CR/LF) --------
set "HUB="
if /i "%~1"=="--change-hub" set "REJOIN=--rejoin"
if defined REJOIN goto :askhub
if exist "%HUBFILE%" for /f "usebackq delims=" %%H in ("%HUBFILE%") do if not defined HUB set "HUB=%%H"
if defined HUB goto :havehub
:askhub
echo  Which hub should this PC join? Type the address your phone uses,
echo  for example https://tree.example.org
set "TYPED="
set /p "TYPED= Hub address: "
if not defined TYPED goto :badhub
> "%HUBFILE%" echo %TYPED%
for /f "usebackq delims=" %%H in ("%HUBFILE%") do if not defined HUB set "HUB=%%H"
:havehub
if not defined HUB goto :badhub
set "HUB=%HUB: =%"
if /i not "%HUB:~0,8%"=="https://" if /i not "%HUB:~0,7%"=="http://" goto :badhub
> "%HUBFILE%" echo %HUB%

REM ---- 3. paths as WSL sees them (wslpath), the Desktop for the QR picture ------------------
set "BOOT="
for /f "usebackq delims=" %%P in (`wsl.exe -e wslpath -a -u "%APPDIR%wsl-bootstrap.sh"`) do set "BOOT=%%P"
if not defined BOOT goto :nopath
set "DESK="
for /f "usebackq delims=" %%D in (`powershell.exe -NoProfile -NonInteractive -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESK=%%D"
if not defined DESK set "DESK=%USERPROFILE%\Desktop"
set "QRWIN=%DESK%\Veraldar-Join-QR.png"

REM ---- 4. join, inside WSL ----------------------------------------------------------------------
echo  Hub: %HUB%
echo  Working inside WSL. The first run downloads the code and builds the brain (5 to 15 minutes).
echo.
wsl.exe -e bash "%BOOT%" --hub "%HUB%" --branch "%BRANCH%" --repo "%REPO%" --qr-win "%QRWIN%" %REJOIN%
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :ok
if "%RC%"=="3" goto :refused
if "%RC%"=="4" goto :expired
echo.
echo  Something went wrong (exit %RC%). Read the lines above; the full log is inside WSL:
echo      ~/.local/state/veraldar/bootstrap.log
echo  Fix what it says, then double-click Veraldar again (it picks up where it stopped).
pause
exit /b %RC%

:ok
del "%QRWIN%" >nul 2>&1
REM keep the root up: the keepalive starts its services and holds WSL open (also at every logon)
start "" wscript.exe //B //Nologo "%APPDIR%keepalive.vbs"
echo.
echo  Done: this PC is a root of your tree. It keeps running in the background inside WSL,
echo  and starts again when you log on. You can close this window.
pause
exit /b 0

:refused
del "%QRWIN%" >nul 2>&1
echo.
echo  The join was refused on the phone. Nothing was started. Double-click Veraldar to try again.
pause
exit /b 3

:expired
del "%QRWIN%" >nul 2>&1
echo.
echo  The QR expired before it was approved. Double-click Veraldar for a new one.
pause
exit /b 4

:nowsl
echo  WSL2 (Windows Subsystem for Linux) with Ubuntu is needed and is not set up yet.
echo   1. Open PowerShell as Administrator and run:
echo          wsl --install -d Ubuntu
echo   2. Restart Windows when it asks. Open "Ubuntu" from the Start menu once and
echo      create your Linux user name and password.
echo   3. Double-click Veraldar again.
pause
exit /b 2

:badhub
echo  A hub address starts with https:// - for example https://tree.example.org
if exist "%HUBFILE%" del "%HUBFILE%"
pause
exit /b 64

:nopath
echo  WSL did not answer (wslpath). Open "Ubuntu" from the Start menu once, then try again.
pause
exit /b 1
