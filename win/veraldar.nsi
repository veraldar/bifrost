; veraldar.nsi — the bifrost branch: Windows installer (NSIS 3.x)
; .......................................................................
; Installs a per-user (no-admin) Windows app that brings up the Veraldar
; stack (root brain + trunk bridge + branch PWA, all inside WSL2) and
; hands the user a QR to scan with their phone. The .bat does the work;
; this file only lays down files + shortcuts + the uninstaller.
;
; Build — either of:
;   makensis win/veraldar.nsi         -> win/Veraldar-Setup.exe
;   docker run --rm -v "$PWD/win":/src -w /src debian:stable-slim bash -c \
;     "apt-get update -qq && apt-get install -y --no-install-recommends nsis \
;      && makensis veraldar.nsi"        (no sudo, no local NSIS — proven win-compile)
;
; Payload expected next to this script at build time:
;   launcher.bat   (win/launcher.bat — bundled verbatim)
;   wsl-bootstrap.sh (bash twin logic the .bat drives inside WSL2)
;
; Compression: keep the installer small — payload is two text files;
; Node/WSL are bootstrapped by the script itself (not bundled).
; .......................................................................

Unicode true
!define APPNAME      "Veraldar"
!define COMPANY      "veraldar"
!define APPVERSION   "0.1.0"
!define INSTDIR_DEF  "$LOCALAPPDATA\Veraldar"
!define UNINST_KEY   "Software\Microsoft\Windows\CurrentVersion\Uninstall\Veraldar"

Name "${APPNAME} (${APPVERSION})"
OutFile "Veraldar-Setup.exe"
InstallDir "${INSTDIR_DEF}"
InstallDirRegKey HKCU "Software\${COMPANY}\Veraldar" "InstallDir"
RequestExecutionLevel user        ; per-user install: no UAC prompt
SetCompressor /SOLID lzma
CRCCheck on

; ---- pages: minimal, layman-grade --------------------------------------
Page directory
Page instfiles

; ---- section: files -----------------------------------------------------
Section "Install"
  SetOutPath "$INSTDIR"

  ; the payload: launcher + the bash script it drives inside WSL2
  File "launcher.bat"
  File "wsl-bootstrap.sh"

  ; uninstaller + registry keys (per-user hive only)
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\${COMPANY}\Veraldar" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion"  "${APPVERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher"       "${COMPANY}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; Start Menu shortcut (AppData\Roaming — per-user, no admin)
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\launcher.bat"

  ; Desktop shortcut
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\launcher.bat"
SectionEnd

; ---- section: uninstall --------------------------------------------------
Section "Uninstall"
  Delete "$INSTDIR\launcher.bat"
  Delete "$INSTDIR\wsl-bootstrap.sh"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir  "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  RMDir  "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${COMPANY}\Veraldar"
SectionEnd
