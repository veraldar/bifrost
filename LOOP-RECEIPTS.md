# AGI-LOOP receipts — night cycle, 2026-10-06

## GREEN (measured, no asterisks)

| leg | evidence |
|---|---|
| brain voice-mode LIVE | 46-word speech-shaped reply on the real zai glm-5.3-flash path; zero markdown/emoji/dash leftovers; model-name fix (glm-4.7→5.3) |
| agent streaming first-sound | 1248–1285ms (was 5–7.5s); 3/3 sentences in order; AGENT_STREAM_TTS=0 fallback verbatim |
| STT (production MLX) | USER-AGI's wav transcribed EXACTLY ×3 |
| TTS (production) | multi-paragraph receipt audio 460KB–1.29MB (the JSON path fixed: contract test + SPEACHES_URL deployment fix) |
| full-stack installer | PASS-SIM 9/9 in the clean container: brain, app+/pair QR, bridge identity, seam PONG, device-401, livekit binary, local voice, local TTS |
| v0.9.0 | tagged (fb911b7 line), gates: yggdrasil 1–8 PASS, pwa build, agent replay, ladder 8/8 |
| emulator APK | installs, launches, renders the tree door + live onboarding with the voice-mode greeting inside the native webview; native telemetry (crash/ANR/permission) → /api/diag; remote-URL hot reload (a server-side change reached the installed app with NO reinstall — demonstrated) |

## BLOCKED (surfaced, precisely)

**The emulator's RTC voice loop** — the last red cell. Chain of evidence:
signal ws joins (roomID assigned) ✓ → the media/ICE path needs UDP to the
LiveKit media port → the only LiveKits the AVD can reach sit behind the box's
firewall law (tailnet/loopback only; `sudo` unavailable to this session) or
the Mac's lab instance (reachable: join + ping OK) — but the AUDIO track then
fails to publish: 4 injection mechanisms attempted (command-line file, intent
args, element captureStream, AudioContext destination — the last RMS-proven
0.12 in-page) and the track still never reaches the server.

**What unlocks it (operator, pick one):**
1. `sudo iptables -I INPUT -s 192.168.50.0/24 -j ACCEPT` on omarchy → the
   emulator reaches the Mac LiveKit with a real audio stack → the loop reruns
   end-to-end (everything else is standing).
2. A real phone mic: the tailnet door (:8443) is REPAIRED for PTT/audio (the
   lab-URL leak fixed; brain restored) — the human test path works now.
3. A Chromium debug build on the AVD (honors fake-mic file capture).

**Also surfaced:** the veraldar-vps SSH access — the AP lane's deploy
(`deploy-vps.sh`, committed with AP_ICE_TCP option) is ready but undeployable
without it.
