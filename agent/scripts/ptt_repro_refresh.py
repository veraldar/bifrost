"""Reproduce req 09-29 'PTT after refresh / after hf→keyboard switch drops the turn'.

Scenarios (phone-protocol level, real TTS speech audio):
  refresh — connect, disconnect (page reload), re-mint + reconnect, PTT dance
  hfswitch — publish mic (hands-free state), unpublish it (= releaseMicDevice
             on the keyboard switch), then the PTT dance re-publishes a track

Verdict per scenario:
  OK   — user message landed in the room's opencode session
  BUG  — commit accepted but no user message (turn dropped)
"""

import asyncio
import json
import sys
import time
import urllib.request

from livekit import rtc

PCM = "/tmp/opencode/ptt_speech.pcm"
SAMPLE_RATE = 16000


def http_json(url, method="GET", body=None):
    req = urllib.request.Request(url, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=15) as r:
        return json.loads(r.read().decode())


async def ptt_dance(room, tag):
    """ptt_begin → publish mic → speak → mute → commit_turn (phone's order)."""
    deadline = time.time() + 20
    agent = next(iter(room.remote_participants.values()), None)
    while time.time() < deadline and not agent:
        await asyncio.sleep(0.2)
        agent = next(iter(room.remote_participants.values()), None)
    if not agent:
        print(f"[{tag}] BUG: no agent in room")
        return False
    print(f"[{tag}] agent={agent.identity}")

    async def rpc(method):
        return await room.local_participant.perform_rpc(
            destination_identity=agent.identity,
            method=method,
            payload="{}",
            response_timeout=10_000,
        )

    print(f"[{tag}] ptt_begin →", await rpc("ptt_begin"))
    source = rtc.AudioSource(SAMPLE_RATE, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(
        track, options=rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    await asyncio.sleep(0.3)
    pcm = open(PCM, "rb").read()
    chunk = 320 * 2  # 20ms @16k mono s16
    for i in range(0, len(pcm) - chunk + 1, chunk):
        frame = rtc.AudioFrame(pcm[i : i + chunk], SAMPLE_RATE, 1, 320)
        await source.capture_frame(frame)
    print(f"[{tag}] spoke, muted (no trailing frames)")
    await asyncio.sleep(0.2)
    res = await rpc("commit_turn")
    print(f"[{tag}] commit_turn → {res}")
    return True


async def turn_landed(room_name, timeout=60):
    sid = None
    for _ in range(10):
        for s in http_json("http://127.0.0.1:4096/session"):
            if s.get("title") == room_name:
                sid = s["id"]
                break
        if sid:
            break
        await asyncio.sleep(0.5)
    if not sid:
        return None
    t0 = time.time()
    while time.time() - t0 < timeout:
        msgs = http_json(f"http://127.0.0.1:4096/session/{sid}/message")
        if isinstance(msgs, dict):
            msgs = msgs.get("messages", [])
        for m in msgs:
            if m.get("role") == "user":
                text = "".join(
                    p.get("text", "") for p in (m.get("parts") or []) if p.get("type") == "text"
                )
                if "testing one two three" in text.lower():
                    return text[:70]
        await asyncio.sleep(1)
    return None


async def scenario_refresh():
    room_name = "reprorefresh1"
    url = "ws://127.0.0.1:7880"

    det = http_json("http://127.0.0.1:8080/api/token", "POST", {"room": room_name})
    room = rtc.Room()
    await room.connect(url, det["participantToken"], rtc.RoomOptions(auto_subscribe=False))
    print(f"[refresh] pre-refresh connected as {room.local_participant.identity}")
    await asyncio.sleep(1.0)

    # page reload: socket drops, then the fresh page preconnects with a NEW
    # token (which also fires a fresh agent dispatch — same as the phone)
    await room.disconnect()
    print("[refresh] --- page refresh ---")
    await asyncio.sleep(0.5)
    det = http_json("http://127.0.0.1:8080/api/token", "POST", {"room": room_name})
    room = rtc.Room()
    await room.connect(url, det["participantToken"], rtc.RoomOptions(auto_subscribe=False))
    print(f"[refresh] reconnected as {room.local_participant.identity}")
    await asyncio.sleep(0.5)

    ok = await ptt_dance(room, "refresh")
    if not ok:
        return False
    text = await turn_landed(room_name)
    print(f"[refresh] {'OK: landed ' + repr(text) if text else 'BUG: turn dropped'}")
    return bool(text)


async def scenario_hfswitch():
    room_name = "reprohfsw1"
    url = "ws://127.0.0.1:7880"

    det = http_json("http://127.0.0.1:8080/api/token", "POST", {"room": room_name})
    room = rtc.Room()
    await room.connect(url, det["participantToken"], rtc.RoomOptions(auto_subscribe=False))
    print(f"[hfswitch] connected as {room.local_participant.identity}")

    # hands-free state: mic track is live
    deadline = time.time() + 20
    while time.time() < deadline and not room.remote_participants:
        await asyncio.sleep(0.2)
    source = rtc.AudioSource(SAMPLE_RATE, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(
        track, options=rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    await asyncio.sleep(0.5)

    # switch to keyboard: releaseMicDevice = unpublish (device closes, room warm)
    try:
        await room.local_participant.unpublish_track(track.sid)
    except TypeError:
        await room.local_participant.unpublish_track(track.sid, stop_on_unpublish=True)
    print("[hfswitch] mic track unpublished (keyboard switch)")

    ok = await ptt_dance(room, "hfswitch")
    if not ok:
        return False
    text = await turn_landed(room_name)
    print(f"[hfswitch] {'OK: landed ' + repr(text) if text else 'BUG: turn dropped'}")
    return bool(text)


async def main():
    results = {}
    for name, fn in [("refresh", scenario_refresh), ("hfswitch", scenario_hfswitch)]:
        try:
            results[name] = await fn()
        except Exception as e:
            print(f"[{name}] EXC: {e!r}")
            results[name] = False
        await asyncio.sleep(1)
    print("\n=== verdict ===")
    for k, v in results.items():
        print(f"{k}: {'OK' if v else 'BUG'}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
