# ENVIRONMENT — the manifest the simulation is the model of

The co-evolution law: reality surprising the model is the evolution trigger.
The cycle hashes this manifest into every snapshot; drift since the last
version = a new chaos profile or scenario dimension owed in the next version.
Update this file when reality moves (provider change, transport swap, store
split, model swap) — the cycle will catch an undeclared move on the usage/env
scan and the next version must answer it.

upstream-provider: zai (anthropic Messages dialect + openai compat), 429 balance errors, 5xx, slow streams
agent-core: yggdrasil opencode-compatible REST + SSE, per-session run locks, roll-up, tool loop (bash)
transport: WebRTC datachannel + opus (str0m 0.24); boringtun mesh (userspace WG)
bridge: bifrost-net v0.9 — token-gated /offer, app channel, UNPACED TTS bursts (no BWE), no ICE restart
speech: speaches — Kokoro-82M TTS (24k wav) + faster-whisper-small STT
proxy: Next 15 /api/* seam on undici (headersTimeout uncapped since 10-05)
app: PWA 0.6.0 (Next 15, sw push) + Capacitor wrap (parallel lane, pending)
network: tailnet + LAN; phone-cell 2% loss; poor-cell 15%+reorder; congested 64kbps caps both ways
store: opencode SQLite (opencode.db) — sessions+messages, live on this box
