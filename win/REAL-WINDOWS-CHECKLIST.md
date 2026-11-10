# Veraldar on Windows — the 10-minute real-box test (one page)

**One sentence:** run the installer, double-click the desktop tile, scan the QR with your
phone — if checks 1–11 pass, Veraldar is proven on a real Windows 11 box.

**Before you start:** a Windows 11 PC, the `Veraldar-Setup.exe` file, ~10 minutes, and your
phone on the **same Wi-Fi** as the PC. Printable copy: `win/REAL-WINDOWS-CHECKLIST.md` in the repo.

## A · Install (2 min)

| # | Action | Expect | Pass? |
|---|---|---|---|
| 1 | Copy `Veraldar-Setup.exe` to the PC (USB or download) | file lands, ~104 KB | ☐ |
| 2 | Double-click `Veraldar-Setup.exe` | **no UAC prompt** (per-user install) | ☐ |
| 3 | Click through: Next → Install → Close | finishes in seconds, no errors | ☐ |
| 4 | Look at the Desktop and the Start Menu | **Veraldar** tile in both places | ☐ |
| 5 | Paste `%LOCALAPPDATA%\Veraldar` into the Explorer address bar | `launcher.bat` + `wsl-bootstrap.sh` + `Uninstall.exe` there | ☐ |

## B · First run (3 min)

| # | Action | Expect | Pass? |
|---|---|---|---|
| 6 | Double-click the **Veraldar** desktop tile | a console window opens — keep it open | ☐ |
| 7 | Watch the console ~2 min | progress lines (ports `8195…8199`), no red errors | ☐ |
| 8 | Wait for "stack is up" | your browser opens `http://<PC-LAN-IP>:8195/bridge?…&t=bfnd-…` **pre-filled** | ☐ |
| 9 | Look at the Desktop again | **`Veraldar-Pair-QR.png`** is there | ☐ |

## C · Pair (2 min)

| # | Action | Expect | Pass? |
|---|---|---|---|
| 10 | Scan the QR with the phone camera | phone browser opens the same `/bridge` URL, pre-filled — tap **Connect** | ☐ |
| 11 | In `/bridge`: type a message, send | a reply arrives (mock brain) | ☐ |
| 12 | Phone menu → "Add to Home Screen" | phone gets a Veraldar icon (optional) | ☐ |

## D · Voice smoke (optional, 2 min)

| # | Action | Expect | Pass? |
|---|---|---|---|
| 13 | In `/bridge`: hold the mic button, talk, release | your words land as text; reply may be text-only (mock brain) | ☐ |

## E · Cleanup (1 min)

| # | Action | Expect | Pass? |
|---|---|---|---|
| 14 | Close the console window | the stage stops (ports free again) | ☐ |
| 15 | Run `%LOCALAPPDATA%\Veraldar\Uninstall.exe` | Veraldar removes itself; desktop tile gone | ☐ |

**GATE: checks 1–11 all PASS = install + join proven on real Windows.**
12–13 are bonus. Any FAIL: screenshot + the console text — that is the bug report.

---

For the record-keeper (not the tester): exe sha256 `69fc97b7a2be…0334842` (NSIS 3.11
Unicode, 106,285 B) · QR lands at `%USERPROFILE%\Desktop\Veraldar-Pair-QR.png` · stage
ports `8195–8199` (`VERALDAR_PORT_BASE` overrides) · no telemetry · internet needed only
for the first clone + browser · the PC runs the whole stack locally (mock brain — real
answers need a provider key, by design).
