' keepalive.vbs - keeps this PC's root running: starts its services inside WSL2 and holds WSL open
' (Windows stops an idle WSL, and the root with it). No window. Run by launcher.bat after a join and
' at every logon (Startup shortcut "Veraldar root"). Does nothing until this PC has joined a tree.
Set sh = CreateObject("WScript.Shell")
sh.Run "wsl.exe -e sh -c ""s=$HOME/.local/share/yggdrasil-root/bin/start; [ -x $s ] && exec $s --hold""", 0, False
