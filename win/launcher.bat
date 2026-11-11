@echo off
REM launcher.bat - the Veraldar desktop tile. Installed by Veraldar-Setup.exe (veraldar.nsi)
REM or by the one-paste line into %LOCALAPPDATA%\Veraldar\ (or the folder picked in Setup).
REM
REM All the logic lives in veraldar.ps1 (ONE provisioner for both entry paths): WSL2 +
REM the Veraldar distro + build + root/trunk/app on 8195-8199 + the QR on the Desktop.
REM This file only hands over, and keeps the window open when something stopped.
REM
REM Hardening for real boxes:
REM  - no ( ) blocks: a ")" in the user folder name (C:\Users\Jo (Work)) breaks them
REM  - veraldar.ps1 is read + run as a script block: no execution-policy prompt, no -File
REM  - CRLF line endings (win\.gitattributes keeps them): cmd mis-parses LF-only labels
setlocal EnableExtensions
title Veraldar - keep this window open (closing it stops Veraldar)
set "VERALDAR_LOCAL=%~dp0"
set "VERALDAR_PS1=%~dp0veraldar.ps1"

set "PSEXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%VERALDAR_PS1%" goto nofile
if exist "%PSEXE%" goto run
set "PSEXE=powershell.exe"
where powershell.exe >nul 2>&1
if errorlevel 1 goto nops

:run
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:VERALDAR_PS1)))"
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" exit /b 0
echo.
echo [veraldar] Veraldar stopped - the lines above say what to do next.
echo [veraldar] logs: %~dp0veraldar-ps.log and %~dp0bootstrap.log
pause
exit /b %RC%

:nofile
echo [veraldar] veraldar.ps1 is missing next to this launcher: %~dp0
echo [veraldar] Reinstall: run Veraldar-Setup.exe again, or paste into PowerShell:
echo [veraldar]   irm https://raw.githubusercontent.com/veraldar/bifrost/main/win/veraldar.ps1 ^| iex
pause
exit /b 3

:nops
echo [veraldar] Windows PowerShell 5.1 was not found - it ships with every Windows 10/11:
echo [veraldar]   %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
echo [veraldar] Repair Windows: open Command Prompt as administrator, run  sfc /scannow
echo [veraldar] then restart and double-click Veraldar again.
pause
exit /b 4
