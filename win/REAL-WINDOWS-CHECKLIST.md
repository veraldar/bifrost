# Veraldar on Windows — the real-box test (one page)

**One sentence:** install by **one** of the two entry paths, let the first run finish, scan the QR
with your phone. If checks 1–12 pass, Veraldar is proven on a real Windows 11 box.

**Before you start:** a Windows 11 PC (an admin account for ONE prompt), ~10 GB free, internet,
your phone on the **same Wi-Fi** as the PC. Hands-on ≈10 min, plus ≈20–30 min of waiting on the
first run (WSL2 + Ubuntu + one build; maybe one restart). How to reach the PC: `REMOTE-PROVE.md`.

## A · Install — pick ONE path

**A1 · Setup.exe**

| # | Action | Expect | Pass? |
|---|---|---|---|
| 1 | Copy `Veraldar-Setup.exe` to the PC | file lands, ~140 KB | ☐ |
| 2 | Double-click it | **no UAC prompt** (per-user install) | ☐ |
| 3 | Next → Install; "Start it now?" → **Yes** | finishes in seconds, a console window opens | ☐ |
| 4 | Look at the Desktop and the Start Menu | a **Veraldar** tile in both | ☐ |
| 5 | Paste `%LOCALAPPDATA%\Veraldar` into Explorer's address bar | `launcher.bat`, `veraldar.ps1`, `wsl-bootstrap.sh`, `layman-bootstrap.sh`, `ONE-PASTE.md`, `Uninstall.exe` | ☐ |

**A2 · the one-paste line** (`ONE-PASTE.md`)

| # | Action | Expect | Pass? |
|---|---|---|---|
| 1 | Start → type `powershell` → Enter (normal window) | a PowerShell window | ☐ |
| 2 | Paste `irm https://raw.githubusercontent.com/veraldar/bifrost/main/win/veraldar.ps1 \| iex` | `[veraldar] Veraldar for Windows 0.2.0 …` | ☐ |
| 3 | Watch the first lines | `installed to …\AppData\Local\Veraldar (+ Veraldar tile …)` | ☐ |
| 4 | Look at the Desktop and the Start Menu | a **Veraldar** tile in both | ☐ |
| 5 | Paste `%LOCALAPPDATA%\Veraldar` into Explorer's address bar | `launcher.bat`, `veraldar.ps1`, `wsl-bootstrap.sh`, `layman-bootstrap.sh` (+ docs) | ☐ |

## B · First run (both paths, same console)

| # | Action | Expect | Pass? |
|---|---|---|---|
| 6 | If WSL2 was missing: Windows asks for permission → **Yes** | a second window runs `wsl --install …` + the firewall rules, then closes. Asked to restart? Say **Y**. After you sign in, the Veraldar window reopens by itself | ☐ |
| 7 | Watch the console | steps `1/6 … 6/6` and inside `1/5 … 5/5`; no `STOPPED:` block. A `WARN` about NAT/firewall = the phone will fail at 10: note it | ☐ |
| 8 | Wait for `Veraldar is UP` | the browser opens `http://localhost:8195/bridge?b=…&t=bfnd-…`, **pre-filled** | ☐ |
| 9 | Look at the Desktop (the one you see, OneDrive or not) | **`Veraldar-Pair-QR.png`** is there (also in `%USERPROFILE%\Desktop`) | ☐ |

## C · Pair + versions

| # | Action | Expect | Pass? |
|---|---|---|---|
| 10 | Scan the QR with the phone camera (same Wi-Fi) | the phone opens `http://<PC-LAN-IP>:8195/bridge?…`, pre-filled. Tap **Connect** | ☐ |
| 11 | In `/bridge` on the phone: type a message, send | a reply arrives (mock brain) | ☐ |
| 12 | **Versions visible.** Read the console's `versions:` line, then open `http://localhost:8195/settings` | console: `app <v> (<build>) · root <v> · trunk <v> · src <sha>` (same text in `%LOCALAPPDATA%\Veraldar\versions.txt`). The app page footer shows `<v> · a Veraldar product.` with the **same `<v>`** as the console's `app` | ☐ |

## D · Bonus + cleanup (not in the gate)

| # | Action | Expect | Pass? |
|---|---|---|---|
| 13 | Phone menu → "Add to Home Screen" | a Veraldar icon on the phone | ☐ |
| 14 | `/bridge`: hold the mic, talk | over LAN http the phone mic is blocked (needs https). Text-only is expected | ☐ |
| 15 | Close the console window | the stack stops: `http://localhost:8195` stops answering | ☐ |
| 16 | Double-click the **Veraldar** tile again | up in ≈1 min (no rebuild), a new QR on the Desktop | ☐ |
| 17 | A1 only: run `%LOCALAPPDATA%\Veraldar\Uninstall.exe`, answer Yes to "remove the Linux environment" | tiles + folder gone, `wsl -l` no longer lists `Veraldar` | ☐ |

**GATE: checks 1–12 all PASS (either A path) = install + join + versions proven on real Windows.**
Any FAIL: a screenshot plus the console text plus `%LOCALAPPDATA%\Veraldar\bootstrap.log` and
`veraldar-ps.log`. That's the bug report.

Check 12 honesty: the app page shows the **app** version only. The full stack line (root + trunk +
source sha) is the console's `versions:` line and `versions.txt`. A stack-versions line *on the
app page* would be a pwa change outside `win/`. Until it exists, 12 passes when the app page's
version matches the console line's `app` field.

---

For the record-keeper (not the tester): exe = NSIS 3 Unicode, per-user, built + wine-checked by
`win/wine-check.sh` (sha256 in the latest artifact receipt) · QR at the shell Desktop **and**
`%USERPROFILE%\Desktop\Veraldar-Pair-QR.png` · ports 8195–8199 (`VERALDAR_PORT_BASE` overrides) ·
WSL distro `Veraldar` (Ubuntu 24.04 rootfs, `wsl --import`), stack built from `VERALDAR_REF`
(default `main`) · firewall: TCP 8195 + 8198, UDP 8199, local subnet only · no telemetry ·
the mock brain answers until a provider key is set (by design).
