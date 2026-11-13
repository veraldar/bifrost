#!/usr/bin/env python3
"""lk-probe.py — server-side LiveKit queries for the voice-stab e2e.

The playwright runner shell is jitless (the box's sandbox unit sets
MemoryDenyWriteExecute user-wide), where undici/llhttp (wasm) dies —
livekit-server-sdk's RoomServiceClient uses global fetch and fails with
"fetch failed" inside the runner. Python has no such constraint: the spec
calls this file via spawnSync for every server-side fact.

Usage:
  lk-probe.py participants <room>      # [{identity, joined_at}]
  lk-probe.py agent-count <room>       # int — participants matching agent-*
  lk-probe.py dispatch-jobs <room>     # total bound jobs across dispatch rows
  lk-probe.py dispatch-rows <room>     # int — dispatch row count
  lk-probe.py delete-room <room>       # (fire and forget)
  lk-probe.py wait-agents <room> <n> <timeout_s>   # exit 0 when count ≥ n

Env: VSTAB_AGENT_DIR (default /tmp/bifrost-vsim/agent) supplies .env
(LIVEKIT_URL/API_KEY/API_SECRET) and the venv via PYTHONPATH.
"""

import asyncio
import contextlib
import json
import os
import sys
import time

AGENT_DIR = os.environ.get("VSTAB_AGENT_DIR", "/tmp/bifrost-vsim/agent")
sys.path.insert(0, os.path.join(AGENT_DIR, ".venv", "lib", "python3.13", "site-packages"))

from livekit import api as lk_api  # noqa: E402


def load_env() -> tuple[str, str, str]:
    url = key = secret = ""
    try:
        with open(os.path.join(AGENT_DIR, ".env")) as f:
            for line in f:
                if line.startswith("LIVEKIT_URL="):
                    url = line.split("=", 1)[1].strip()
                elif line.startswith("LIVEKIT_API_KEY="):
                    key = line.split("=", 1)[1].strip()
                elif line.startswith("LIVEKIT_API_SECRET="):
                    secret = line.split("=", 1)[1].strip()
    except OSError:
        pass
    return url, key, secret


async def main() -> None:
    url, key, secret = load_env()
    lkapi = lk_api.LiveKitAPI(url, key, secret)
    args = sys.argv[1:]
    cmd = args[0] if args else ""

    if cmd == "participants":
        room = args[1]
        parts = await lkapi.room.list_participants(lk_api.ListParticipantsRequest(room=room))
        rows = [
            {"identity": p.identity, "joined_at": p.joined_at} for p in parts.participants
        ]
        print(json.dumps(rows))
    elif cmd == "agent-count":
        room = args[1]
        parts = await lkapi.room.list_participants(lk_api.ListParticipantsRequest(room=room))
        print(
            sum(1 for p in parts.participants if p.identity.startswith("agent-"))
        )
    elif cmd == "dispatch-rows":
        room = args[1]
        rows = await lkapi.agent_dispatch.list_dispatch(room)
        print(len(rows))
    elif cmd == "dispatch-jobs":
        room = args[1]
        rows = await lkapi.agent_dispatch.list_dispatch(room)
        total = 0
        for d in rows:
            st = getattr(d, "state", None)
            if st is not None:
                total += len(st.jobs)
        print(total)
    elif cmd == "purge-stubs":
        # every dispatch row whose state has NO bound job is a stub — the
        # mint-side fuel of the 10-30 avalanche (a worker restart re-offers
        # every pending row). Rows with bound jobs are serving: hands off
        # (deleting one terminates its live agent). Listing is room-scoped
        # in this SDK, so iterate the rooms.
        purged = kept = 0
        rooms = await lkapi.room.list_rooms(lk_api.ListRoomsRequest())
        for room in rooms.rooms:
            try:
                rows = await lkapi.agent_dispatch.list_dispatch(room.name)
            except Exception:  # noqa: BLE001 — room may vanish mid-pass
                continue
            for d in rows:
                st = getattr(d, "state", None)
                jobs = list(getattr(st, "jobs", []) or []) if st is not None else []
                if jobs:
                    kept += 1
                    continue
                with contextlib.suppress(Exception):
                    await lkapi.agent_dispatch.delete_dispatch(d.id, d.room)
                    purged += 1
        print(json.dumps({"purged": purged, "kept_serving": kept}))
    elif cmd == "delete-room":
        await lkapi.room.delete_room(lk_api.DeleteRoomRequest(room=args[1]))
        print("ok")
    elif cmd == "wait-agents":
        room, want, timeout_s = args[1], int(args[2]), float(args[3])
        deadline = time.monotonic() + timeout_s
        count = -1
        while time.monotonic() < deadline:
            parts = await lkapi.room.list_participants(
                lk_api.ListParticipantsRequest(room=room)
            )
            count = sum(
                1 for p in parts.participants if p.identity.startswith("agent-")
            )
            if count >= want:
                break
            await asyncio.sleep(0.5)
        print(count)
        sys.exit(0 if count >= want else 1)
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)

    await lkapi.aclose()


if __name__ == "__main__":
    asyncio.run(main())
