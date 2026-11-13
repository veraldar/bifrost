; veraldar.nsi - Windows installer: "join this PC to my tree" (NSIS 3.x, per-user, no admin prompt)
; .................................................................................................
; Lays down the launcher + its WSL script + the keepalive, and the shortcuts. The work happens when
; the user double-clicks "Veraldar": launcher.bat -> WSL2 -> wsl-bootstrap.sh -> root/install/join.sh
; (the code is cloned inside WSL from github.com/veraldar/yggdrasil, branch set in launcher.bat).
;
; Build (from the repo root; no local NSIS needed):
;   docker run --rm -v "$PWD/win":/src -w /src debian:stable-slim bash -c \
;     "apt-get update -qq && apt-get install -y -qq nsis >/dev/null && makensis -V2 veraldar.nsi"
; or: makensis win/veraldar.nsi            -> win/Veraldar-Setup.exe
; .................................................................................................

Unicode true
!define APPNAME    "Veraldar"
!define COMPANY    "veraldar"
!define APPVERSION "0.2.0"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Veraldar"

Name "${APPNAME} ${APPVERSION}"
OutFile "Veraldar-Setup.exe"
InstallDir "$LOCALAPPDATA\Veraldar"
InstallDirRegKey HKCU "Software\${COMPANY}\Veraldar" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
CRCCheck on

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File "launcher.bat"
  File "wsl-bootstrap.sh"
  File "keepalive.vbs"
  File "README.txt"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\${COMPANY}\Veraldar" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion"  "${APPVERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher"       "${COMPANY}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; double-click entry points
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\launcher.bat"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME} - join another hub.lnk" "$INSTDIR\launcher.bat" "--change-hub"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME} README.lnk" "$INSTDIR\README.txt"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\launcher.bat"
  ; at every logon: start the root inside WSL and keep WSL awake (no window; a no-op until joined)
  CreateShortcut "$SMSTARTUP\${APPNAME} root.lnk" "$SYSDIR\wscript.exe" '//B //Nologo "$INSTDIR\keepalive.vbs"'
SectionEnd

Section "Uninstall"
  ; stop the root inside WSL; its files stay there (~/.local/share/yggdrasil-root, ~/veraldar/yggdrasil)
  nsExec::Exec 'wsl.exe -e sh -c "s=$$HOME/.local/share/yggdrasil-root/bin/stop; [ -x $$s ] && $$s"'
  Delete "$INSTDIR\launcher.bat"
  Delete "$INSTDIR\wsl-bootstrap.sh"
  Delete "$INSTDIR\keepalive.vbs"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\hub.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir  "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME} - join another hub.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME} README.lnk"
  RMDir  "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMSTARTUP\${APPNAME} root.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${COMPANY}\Veraldar"
SectionEnd
