"""Join canary: the phone's exact voice path, protocol level.

1. mint a token via the served PWA route (what the phone calls)
2. join the room via the phone-facing wss URL (e.g. `.../livekit` through
   `tailscale serve` — falls back to the LIVEKIT_URL of agent/.env)
3. wait for the voice agent to appear in the room

The 2026-10-01 incident: the phone's signal websocket connected but the
join never completed — the signal was landing on a dockerized LiveKit
inside the colima VM (via the 127.0.0.1:7880 ssh forward) where UDP
media can't route. An HTTP probe of :7880 could NOT tell the difference;
this canary can: it fails at the join timeout exactly in that state.

Usage: uv run scripts/join_canary.py [room]
Exit 0 = JOIN OK; 2 = connect/join failed; 3 = joined but no agent.
"""

import asyncio
import json
import os
import sys
import time
import urllib.request

from livekit import rtc

ROOM = sys.argv[1] if len(sys.argv) > 1 else "canary-join-check"
JOIN_TIMEOUT = float(os.environ.get("CANARY_JOIN_TIMEOUT", "12"))  # the page's signal timeout — the canary must beat it


def http_json(url, method="GET", body=None, timeout=15):
    req = urllib.request.Request(url, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
        return json.loads(r.read().decode())


def load_env(path="agent/.env"):
    # tiny parser: agent/.env holds LIVEKIT_URL etc. (no quoting needs so far)
    d = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    d[k] = v
    except OSError:
        pass
    return d


async def main():
    env = load_env(os.path.join(os.path.dirname(__file__), "..", ".env"))
    base = os.environ.get("PWA_BASE", "http://127.0.0.1:8080")
    t0 = time.time()
    det = http_json(f"{base}/api/token", "POST", {"room": ROOM})
    url = det.get("serverUrl") or env.get("LIVEKIT_URL", "ws://127.0.0.1:7880")
    print(f"[canary] minted for room={det.get('roomName')} via {base}/api/token ({time.time()-t0:.1f}s)")

    room = rtc.Room()
    try:
        await asyncio.wait_for(
            room.connect(url, det["participantToken"], rtc.RoomOptions(auto_subscribe=False)),
            timeout=JOIN_TIMEOUT,
        )
    except asyncio.TimeoutError:
        print(f"[canary] FAIL: join did not complete within {JOIN_TIMEOUT}s (signal ok, media dead — 2026-10-01 incident signature)")
        return 2
    except Exception as e:
        print(f"[canary] FAIL: connect error: {e}")
        return 2
    print(f"[canary] JOINED via {url} ({time.time()-t0:.1f}s) — signal AND media established")

    deadline = time.time() + 12
    while time.time() < deadline and not room.remote_participants:
        await asyncio.sleep(0.2)
    agent = next(iter(room.remote_participants.values()), None)
    if not agent:
        print("[canary] FAIL: joined, but no voice agent in the room after 12s — is the agent worker running?")
        return 3
    print(f"[canary] OK: agent in room: {agent.identity} (total {time.time()-t0:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))