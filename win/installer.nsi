; installer.nsi — Veraldar one-click installer (root+trunk), user-scope.
; Installs to %LOCALAPPDATA%\veraldar, Start-Menu + Desktop shortcut "Veraldar",
; bundles veraldar-launcher.bat (docker-or-python bootstrap branch + QR to Desktop).
; Built with NSIS 3.12; executed under wine on the sim box (see artifacts/win-qr-sim-report.md).
; Shortcuts: real .lnk files (MS-SHLLINK, win/gen-lnk.py) are copied into the shell
; folders FIRST (works under wine where ShellLink COM is unreachable from 32-bit);
; CreateShortcut then rewrites them with the true per-user target on real Windows.

Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define APPNAME "Veraldar"

Name "${APPNAME}"
OutFile "../artifacts/VeraldarSetup.exe"
InstallDir "$LOCALAPPDATA\veraldar"

Page directory
Page instfiles

Section "${APPNAME}"
  SetOutPath "$INSTDIR"
  File "/oname=veraldar-launcher.bat" "launcher.bat"
  File "/oname=README.txt" "README.txt"
  File "/oname=win-bootstrap.sh" "win-bootstrap.sh"
  File "/oname=Veraldar.lnk" "veraldar-desktop.lnk"
  File "/oname=veraldar-startmenu.lnk" "veraldar-startmenu.lnk"

  ; shortcut into Start Menu + Desktop (registry-redirected under the wine sim,
  ; the real per-user folders on Windows). CopyFiles needs an absolute dest.
  CreateDirectory "$SMPROGRAMS"
  CopyFiles /SILENT "$INSTDIR\Veraldar.lnk" "$DESKTOP\Veraldar.lnk"
  CopyFiles /SILENT "$INSTDIR\veraldar-startmenu.lnk" "$SMPROGRAMS\Veraldar.lnk"
  ; real-Windows canonical path (overwrites the copies with a fresh per-user lnk)
  CreateShortcut "$SMPROGRAMS\Veraldar.lnk" "$INSTDIR\veraldar-launcher.bat"
  CreateShortcut "$DESKTOP\Veraldar.lnk" "$INSTDIR\veraldar-launcher.bat"

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\Veraldar.lnk"
  Delete "$DESKTOP\Veraldar.lnk"
  Delete "$INSTDIR\veraldar-launcher.bat"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\win-bootstrap.sh"
  Delete "$INSTDIR\Veraldar.lnk"
  Delete "$INSTDIR\veraldar-startmenu.lnk"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
