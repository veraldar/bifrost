Veraldar — one-click install (root + trunk), Windows
=====================================================

What this installer does
------------------------
1. Installs to %LOCALAPPDATA%\veraldar (user scope — no admin prompt):
   veraldar-launcher.bat (double-click entry) + this README.
2. Creates a Start-Menu shortcut and a Desktop shortcut, both named "Veraldar".
3. "Veraldar" (double-click) runs the bootstrap in one of two paths:

   DOCKER PATH (if Docker Desktop is installed):
     docker compose up brings up root (brain) + trunk (bridge) + the app;
     this launcher then mints the first device and saves the join QR
     (pair-qr.png) to the Desktop. Scan it with the phone camera, tap
     Connect, talk.

   NATIVE PYTHON PATH (what ships today — no Docker):
     python3 mock upstream -> yggdrasil root -> bifrost-net trunk, transient
     services on ports 8155-8159 (app 8155 / root 8156 / mock 8157 / trunk
     8158+8159udp), first device minted via the real /api/pair surface, join
     QR saved to Desktop as pair-qr.png. The phone must be on the same
     Wi-Fi/LAN as this computer.

Uninstall
---------
Run %LOCALAPPDATA%\veraldar\uninstall.exe (removes shortcuts + this folder;
the running stage services stay until reboot or `systemctl --user stop win-sim-*`
on the sim box / Task Manager end-task on real Windows).

Sim honesty (this build was proven under wine on Linux, not on real Windows)
-----------------------------------------------------------------------------
wine is not Windows: the shortcut .lnk files, shell-folder redirection and
DOS-path semantics were all simulated inside a wine prefix. What a real
Windows box adds (and this sim could not prove): real Explorer shell,
real .lnk handling, Docker Desktop, Windows python. The exact real-box steps:

1. Download VeraldarSetup.exe, double-click, Next (installs to %LOCALAPPDATA%\veraldar).
2. Double-click the Desktop shortcut "Veraldar".
3. With Docker Desktop: compose up -> QR appears on Desktop. Without:
   install Python 3.12 from python.org (tick "Add to PATH"), plus the two
   prebuilt binaries (yggdrasil, bifrost-net) — see the repo's lab/layman-deploy.
4. Scan pair-qr.png with the phone (same Wi-Fi), tap Connect to bridge, talk.
