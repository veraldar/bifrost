Veraldar for Windows (0.2.0) - the Yggdrasil tree (root + trunk + branch app), inside WSL2
================================================================

Two ways in, ONE provisioner behind both (veraldar.ps1):

  A. Veraldar-Setup.exe  - per-user install into %LOCALAPPDATA%\Veraldar (no admin for the
                           install itself), Veraldar tile on the Desktop + Start Menu.
                           Double-click the tile (or say Yes to "Start it now?").
  B. the one-paste line  - paste into PowerShell (see ONE-PASTE.md):
       irm https://raw.githubusercontent.com/veraldar/bifrost/main/win/veraldar.ps1 | iex
                           It lays down the same files + tiles, then runs.

What runs (first time ~20-30 min, later ~1 min)
-----------------------------------------------
1. Preflight: Windows build, CPU virtualization (BIOS/UEFI), >= 10 GB free disk.
2. WSL2: `wsl --install --no-distribution` if missing - ONE admin prompt; if Windows needs a
   restart it asks, and Veraldar continues by itself after the next sign-in (RunOnce).
3. Phone reachability: networkingMode=mirrored in %USERPROFILE%\.wslconfig (per-user) +
   inbound firewall rules, local network only: TCP 8195 (app) + 8198 (trunk signaling),
   UDP 8199 (trunk media) - host rules + Hyper-V (WSL) rules, same admin prompt.
4. The "Veraldar" WSL distro: Ubuntu 24.04 WSL rootfs from cloud-images.ubuntu.com, sha256
   checked, `wsl --import` - never the Store, never the "create a UNIX user" prompt, never
   the user's own Ubuntu, never the default distro (Docker Desktop's included).
5. Inside it (wsl-bootstrap.sh, as root): first-run apt-get update + build deps, node 24
   (nodejs.org tarball) + rust (rustup), blobless clone of github.com/veraldar/bifrost,
   build once per source revision (the app: npm ci + next build; the root + the trunk:
   cargo build of lab/yggdrasil + lab/bifrost-net), then
   lab/layman-deploy/impl/layman-bootstrap.sh --stage with the PLAIN
   runner (no systemd, no docker):
       app 8195 / root (brain) 8196 / mock 8197 / trunk 8198 + 8199 udp
   first device minted through the real /api/pair, QR payload = the /bridge join URL.
6. Veraldar-Pair-QR.png lands on the real Desktop ([Environment]::GetFolderPath('Desktop'),
   i.e. the OneDrive Desktop when OneDrive moved it) AND in %USERPROFILE%\Desktop; the
   browser opens the app on http://localhost:8195 (the QR carries the PC's LAN IP).
7. The window holds the stack: close it (or Ctrl+C) = Veraldar stops.

Docker is NOT used (and not needed) on Windows. The mock brain answers until a provider
key is set - by design. Voice on the phone needs https (LAN http = no mic): text works.

Files
-----
  launcher.bat         the tile: hands over to veraldar.ps1 (CRLF; no execution-policy prompt)
  veraldar.ps1         the provisioner (both entry paths; ASCII, Windows PowerShell 5.1)
  wsl-bootstrap.sh     inner logic inside WSL2
  layman-bootstrap.sh  bundled copy of lab/layman-deploy/impl/layman-bootstrap.sh
  ONE-PASTE.md         the one line + the two hard stops (BIOS virtualization, admin)
  logs (after a run)   veraldar-ps.log, bootstrap.log, admin-step.log, last-error.txt
  repo only:           veraldar.nsi (installer source), wine-check.sh + check-ps.ps1 (the
                       Linux-side gate), REAL-WINDOWS-CHECKLIST.md, REMOTE-PROVE.md
  repo only, legacy:   installer.nsi, win-bootstrap.sh, gen-lnk.py, veraldar-*.lnk - the first
                       wine sim (10-30, ports 8155); NOT shipped, kept for the record

Build the installer
-------------------
  win/wine-check.sh                 (build + 7z payload proof + wine install/uninstall + ps checks)
  or just:  docker run --rm -v "$PWD":/src -w /src/win debian:stable-slim bash -c \
            "apt-get update -qq && apt-get install -y --no-install-recommends nsis && makensis veraldar.nsi"

Uninstall
---------
%LOCALAPPDATA%\Veraldar\Uninstall.exe - removes files, tiles, keys; asks whether to also remove
the "Veraldar" distro (the built stack + paired phones). Firewall rules (admin):
  Remove-NetFirewallRule -Name Veraldar-TCP,Veraldar-UDP
  Remove-NetFirewallHyperVRule -Name Veraldar-HV-TCP,Veraldar-HV-UDP

Honesty: what is proven where
-----------------------------
PROVEN on Linux (11-10): the installer builds, its payload, silent install/uninstall, tiles
and keys under wine; launcher.bat parses under wine cmd; veraldar.ps1 parses, uses only
PowerShell 5.1 syntax and its helpers pass (check-ps.ps1); the WSL inner path end-to-end in
a FRESH ubuntu:24.04 container (no systemd/node/docker): apt -> node -> rust -> clone ->
build -> stack up -> pair -> QR on both "Desktops" (incl. "OneDrive - Contoso\Desktop").
NOT PROVEN (needs a real Windows 11 box - REMOTE-PROVE.md): wsl --install + the restart,
UAC, the firewall cmdlets, wsl --import of the rootfs, mirrored networking, Explorer tiles,
the browser hand-off, and a phone joining over Wi-Fi.
