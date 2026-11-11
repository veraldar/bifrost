# launchd units (this Mac)

The live stack on this box is native launchd, not the systemd/omarchy setup in
README.md — these plists are the source of truth for what should be loaded:

| unit | runs | note |
|---|---|---|
| `com.yggdrasil.livekit` | livekit-server (deploy/livekit.yaml) | tracked only in `~/Library/LaunchAgents` |
| `com.yggdrasil.bifrost-pwa` | `next start -p 8080` from `pwa/` | tracked only in `~/Library/LaunchAgents` |
| `com.yggdrasil.lk-agent` | the voice worker (`uv run agent.py dev` from `agent/`) | **in-repo here** — added 2026-11-11 after the missing unit left every room agent-less post-reboot |

All three need `RunAtLoad` + `KeepAlive` so a reboot or crash self-heals. The
agent unit is the one that was missing: it had been started by hand, the
2026-11-10 14:21 reboot killed it, and the next morning every voice room sat
agent-less ("voice agent missing from the room — is lk-agent running?").

Install / reinstall:

```
cp deploy/launchd/com.yggdrasil.lk-agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yggdrasil.lk-agent.plist
```

Verify:

```
grep 'registered worker' agent/agent.launchd.log   # agent_name bifrost
launchctl print gui/$(id -u)/com.yggdrasil.lk-agent | grep state
```
