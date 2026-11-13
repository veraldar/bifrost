Veraldar for Windows - join this PC to your tree as a root
==========================================================

What it does
------------
Your tree already runs somewhere (the hub), and your phone is paired with it.
This installer makes THIS PC one more root of that tree: its own brain (yggdrasil),
running inside WSL2 (Ubuntu), doing work you send it from the phone.

The PC only DIALS OUT to the hub's public address. Nothing listens on your network:
no open port, no firewall rule, no certificate, no same-Wi-Fi requirement.

What gets installed (no admin prompt)
-------------------------------------
%LOCALAPPDATA%\Veraldar\
    launcher.bat       the "Veraldar" shortcut runs this
    wsl-bootstrap.sh   what the launcher runs inside WSL2
    keepalive.vbs      keeps the root running (WSL stops when idle otherwise)
    README.txt         this file
    hub.txt            your hub's address, written on the first run
Shortcuts: "Veraldar" on the Desktop and in the Start menu, "Veraldar - join another
hub" in the Start menu, and "Veraldar root" in your Startup folder (it starts the
root at every logon, without a window).

Inside WSL (your Linux home) the first run creates:
    ~/veraldar/yggdrasil                 the code (github.com/veraldar/yggdrasil)
    ~/.local/share/yggdrasil-root/       this root: brain, settings, keys (mode 600)
    ~/.local/state/veraldar/bootstrap.log

Step by step
------------
1. WSL2 with Ubuntu. If you don't have it, the launcher says so and stops. Then:
   open PowerShell as Administrator, run   wsl --install -d Ubuntu
   restart Windows, open "Ubuntu" from the Start menu once and create your
   Linux user name and password.
2. Run Veraldar-Setup.exe, click Install.
3. Double-click "Veraldar" on the Desktop.
   - It asks for your hub address once (the address your phone uses, https://...).
   - Inside WSL it may ask to install a few packages (git, python3, a compiler; sudo
     asks for your Linux password) and Rust. The first run builds the brain:
     5 to 15 minutes.
   - It asks which AI model this root uses: an OpenAI- or Anthropic-compatible
     address, a model name and an API key (the key is not shown and is stored only
     in ~/.local/share/yggdrasil-root/brain.env, mode 600).
4. A QR code appears in the window and as Veraldar-Join-QR.png on your Desktop.
   Scan it with the phone that is paired with your tree. The phone shows a code:
   check it matches the code in the window, then approve.
5. The window says Done. The root runs in the background and starts again at
   every logon. The QR picture is removed from the Desktop.

Running it again is safe: it updates the code and keeps your join (no new QR).
"Veraldar - join another hub" asks for a new hub address and joins that one.

Troubleshooting
---------------
- Refused or expired: double-click Veraldar again for a new QR.
- Anything else: the window shows the failing step; the full log is
  ~/.local/state/veraldar/bootstrap.log inside Ubuntu.
- See what the root does, in Ubuntu:   ls ~/.local/share/yggdrasil-root/log/
  or (systemd)   journalctl --user -u yggdrasil-root-brain -u yggdrasil-root-dial
- Stop it, in Ubuntu:   ~/.local/share/yggdrasil-root/bin/stop
- The code comes from the branch named in launcher.bat (BRANCH=main). Until the
  tree layout (root/install/join.sh) is on main, edit that line to BRANCH=tree.

Uninstall
---------
Settings > Apps > Veraldar > Uninstall (or %LOCALAPPDATA%\Veraldar\Uninstall.exe).
It stops the root inside WSL and removes the files and shortcuts above. The root's
files inside WSL stay; delete them in Ubuntu with
    rm -rf ~/.local/share/yggdrasil-root ~/veraldar/yggdrasil

Status of this build
--------------------
Veraldar-Setup.exe is compiled from veraldar.nsi in this folder (NSIS 3.11, in a
Debian container). The inside-WSL part (wsl-bootstrap.sh + join.sh) is tested on
Linux and in a clean Ubuntu 24.04 container against a test hub. The Windows-only
parts (launcher.bat, keepalive.vbs, the shortcuts) have not yet been run on a real
Windows PC.
