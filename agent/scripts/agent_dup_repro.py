"""Reproduce the duplicate-agent race (req 10-05 'voice agent missing from
the room — is lk-agent running? try again in a moment').

The live failure (room lab-cognitive-ceiling 17:41): a page refresh made the
phone drop and rejoin the room <1s apart. The rejoin's token mint dispatched a
NEW agent job; the new agent joined while the OLD job was still draining and
yielded to it ("duplicate agent", ~2.1s after join), and the old job ended a
moment later — the room sat AGENTLESS with the phone connected, and every
PTT/tap commit failed "no voice agent in the room after 4s".

Fix under test (agent.py):
  1. close_on_disconnect=False restored (livekit-agents 1.8.2 _ensure_options
     ignored the deprecated room_input_options once room_options was also
     given — commit 49e3c26 silently re-enabled the close).
  2. a new job WAITS (bounded) for the sibling agent to leave instead of
     yielding instantly.

This script is the phone's exact dance, protocol level:
  connect → wait for agent → disconnect (page refresh)
  → re-mint + rejoin (~1s later) → an agent MUST be present
  → commit_turn MUST answer "ok" (it must not bounce off a
  not-yet-registered sibling).

Verdict:
  OK   — agent present after rejoin AND commit_turn answered
  BUG  — no agent in the room after the refresh, or commit failed
"""

import asyncio
import json
import sys
import time
import urllib.request

from livekit import rtc

JOIN_TIMEOUT = float(__import__("os").environ.get("DUP_REJOIN_SECS", "20"))


def http_json(url, method="GET", body=None, timeout=15):
    req = urllib.request.Request(url, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
        return json.loads(r.read().decode())


async def wait_agent(room, secs):
    deadline = time.time() + secs
    while time.time() < deadline and not room.remote_participants:
        await asyncio.sleep(0.1)
    return next(iter(room.remote_participants.values()), None)


async def run_cycle(base: str, url: str, tag: str) -> bool:
    room_name = f"agentdup{int(time.time())}"
    det = http_json(f"{base}/api/token", "POST", {"room": room_name})
    r1 = rtc.Room()
    await r1.connect(url, det["participantToken"], rtc.RoomOptions(auto_subscribe=False))
    a1 = await wait_agent(r1, 15)
    if not a1:
        print(f"[{tag}] BUG: no agent for the FIRST join — worker down?")
        return False
    print(f"[{tag}] phone1 joined, agent={a1.identity}")

    # page refresh: socket drops, fresh page preconnects with a NEW token
    await r1.disconnect()
    await asyncio.sleep(1.0)
    det2 = http_json(f"{base}/api/token", "POST", {"room": room_name})
    r2 = rtc.Room()
    await r2.connect(url, det2["participantToken"], rtc.RoomOptions(auto_subscribe=False))
    print(f"[{tag}] phone2 rejoined (refresh)")

    # the moment the live failure hit: a commit ~70s after rejoin. Here a
    # short wait is enough to expose a yielded new agent + dead old one.
    a2 = await wait_agent(r2, JOIN_TIMEOUT)
    if not a2:
        print(f"[{tag}] BUG: no agent in the room after refresh — the 10-05 race")
        await r2.disconnect()
        return False
    print(f"[{tag}] agent present after refresh: {a2.identity}")
    try:
        res = await r2.local_participant.perform_rpc(
            destination_identity=a2.identity,
            method="commit_turn",
            payload="{}",
            response_timeout=14_000,
        )
    except Exception as e:  # noqa: BLE001
        print(f"[{tag}] BUG: commit_turn failed: {e!r}")
        await r2.disconnect()
        return False
    print(f"[{tag}] commit_turn -> {res}")
    await r2.disconnect()
    return res == "ok"


async def main():
    base = "http://127.0.0.1:8080"
    url = "ws://127.0.0.1:7880"  # same box; token is url-agnostic
    ok = True
    for i in range(3):
        ok = await run_cycle(base, url, f"cycle{i+1}") and ok
        await asyncio.sleep(1)
    print(f"\n=== verdict: {'OK' if ok else 'BUG'} ===")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))