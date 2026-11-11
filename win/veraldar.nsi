; veraldar.nsi — Veraldar for Windows: the installer (NSIS 3.x)
; .......................................................................
; Installs a per-user (no-admin) app that brings up the Veraldar stack —
; root (the brain) + trunk (the private line, bifrost-net bridge) + the
; branch app — inside WSL2, and hands the user a QR to scan with the phone.
; launcher.bat -> veraldar.ps1 does the work (the SAME provisioner the
; one-paste line runs); this file only lays down files + tiles + uninstaller.
;
; Build (from the repo root — the payload reaches into lab/):
;   docker run --rm -v "$PWD":/src -w /src/win debian:stable-slim bash -c \
;     "apt-get update -qq && apt-get install -y --no-install-recommends nsis \
;      && makensis veraldar.nsi"          -> win/Veraldar-Setup.exe
;   or: win/wine-check.sh  (build + 7z payload proof + wine install/uninstall)
;
; Payload (all text; Node/Rust/Ubuntu are fetched by the provisioner, not bundled):
;   launcher.bat        the desktop tile (CRLF, hands over to veraldar.ps1)
;   veraldar.ps1        WSL2 + distro + firewall + run + QR (both entry paths)
;   wsl-bootstrap.sh    inner logic inside WSL2 (build once, stage, QR)
;   layman-bootstrap.sh lab/layman-deploy/impl — the ONE stage bootstrap
;   ONE-PASTE.md, README.txt
; .......................................................................

Unicode true
!include x64.nsh
!define APPNAME      "Veraldar"
!define COMPANY      "veraldar"
!define APPVERSION   "0.2.0"
!define DISTRO       "Veraldar"
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

  File "launcher.bat"
  File "veraldar.ps1"
  File "wsl-bootstrap.sh"
  File "/oname=layman-bootstrap.sh" "../lab/layman-deploy/impl/layman-bootstrap.sh"
  File "ONE-PASTE.md"
  File "README.txt"

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

  ; Start Menu + Desktop tiles ($DESKTOP = the shell Desktop: OneDrive-redirected when it is)
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\launcher.bat"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\launcher.bat"
SectionEnd

Function .onInstSuccess
  IfSilent done
  MessageBox MB_YESNO|MB_ICONQUESTION "Veraldar is installed.$\n$\nStart it now? The first start takes ~20-30 minutes (it installs WSL2 and builds the stack once) and asks for admin permission once." IDNO done
  ExecShell "open" "$INSTDIR\launcher.bat"
  done:
FunctionEnd

; ---- section: uninstall --------------------------------------------------
Section "Uninstall"
  ; the Linux side (distro "Veraldar": the built stack + paired devices) only on a yes
  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove the Veraldar Linux environment (WSL distro '${DISTRO}' with the built stack and paired phones, ~5 GB)?" /SD IDNO IDNO keepdistro
    ${DisableX64FSRedirection}          ; 32-bit installer: reach the real System32\wsl.exe
    ExecWait '"$SYSDIR\wsl.exe" --unregister ${DISTRO}'
    ${EnableX64FSRedirection}
    RMDir /r "$INSTDIR\distro"
  keepdistro:
  Delete "$INSTDIR\launcher.bat"
  Delete "$INSTDIR\veraldar.ps1"
  Delete "$INSTDIR\wsl-bootstrap.sh"
  Delete "$INSTDIR\layman-bootstrap.sh"
  Delete "$INSTDIR\ONE-PASTE.md"
  Delete "$INSTDIR\README.txt"
  ; what a run leaves behind (logs, URLs, markers, the QR copy, the rootfs download cache)
  Delete "$INSTDIR\bootstrap.log"
  Delete "$INSTDIR\veraldar-ps.log"
  Delete "$INSTDIR\admin-step.log"
  Delete "$INSTDIR\join-url.txt"
  Delete "$INSTDIR\join-url-local.txt"
  Delete "$INSTDIR\versions.txt"
  Delete "$INSTDIR\ready"
  Delete "$INSTDIR\firewall.ok"
  Delete "$INSTDIR\last-error.txt"
  Delete "$INSTDIR\restart-pending.txt"
  Delete "$INSTDIR\Veraldar-Pair-QR.png"
  RMDir /r "$INSTDIR\cache"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir  "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  RMDir  "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "Veraldar"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${COMPANY}\Veraldar"
SectionEnd
