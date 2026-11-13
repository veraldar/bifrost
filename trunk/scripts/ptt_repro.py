"""PTT repro: publish TTS speech, do the phone's exact ptt dance, check opencode.

Verdict:
  BUG    — committed turn was empty (no user message landed in opencode)
  OK     — user message landed (assistant reply may lag)
"""

import asyncio
import json
import sys
import time
import urllib.request

from livekit import rtc

ROOM = "voicerepro1"
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


async def main():
    # 1. token + dispatch via the pwa route (same path the phone uses)
    det = http_json("http://127.0.0.1:8080/api/token", "POST", {"room": ROOM})
    token = det["participantToken"]
    url = det["serverUrl"].replace("wss://", "ws://").replace("/livekit", "") or "ws://127.0.0.1:7880"
    url = "ws://127.0.0.1:7880"  # same box; token is url-agnostic
    print(f"[repro] room={ROOM}")

    room = rtc.Room()
    await room.connect(url, token, rtc.RoomOptions(auto_subscribe=False))
    print(f"[repro] connected, identity={room.local_participant.identity}")

    # wait for the agent participant
    deadline = time.time() + 20
    agent = None
    while time.time() < deadline and not room.remote_participants:
        await asyncio.sleep(0.2)
        agent = next(iter(room.remote_participants.values()), None)
    agent = next(iter(room.remote_participants.values()), None)
    if not agent:
        print("[repro] FAIL: no agent in room")
        sys.exit(2)
    print(f"[repro] agent={agent.identity}")

    async def rpc(method):
        return await room.local_participant.perform_rpc(
            destination_identity=agent.identity,
            method=method,
            payload="{}",
            response_timeout=10_000,
        )

    # 2. publish mic-equivalent track — must claim SOURCE_MICROPHONE or the
    # agent's room input ignores it (accepted_sources filter)
    source = rtc.AudioSource(SAMPLE_RATE, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(
        track, options=rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    await asyncio.sleep(0.3)

    # 3. press: ptt_begin (agent switches to manual turns), then speak
    print("[repro] ptt_begin →", await rpc("ptt_begin"))
    pcm = open(PCM, "rb").read()
    chunk = 320 * 2  # 20ms @16k mono s16
    t0 = time.time()
    for i in range(0, len(pcm) - chunk + 1, chunk):
        frame = rtc.AudioFrame(pcm[i : i + chunk], SAMPLE_RATE, 1, 320)
        await source.capture_frame(frame)
    dur = time.time() - t0
    print(f"[repro] spoke {dur:.1f}s")

    # 4. release: mute NOW (no trailing frames — the phone does mic(false) first)
    print("[repro] muted — no silence after speech")
    await asyncio.sleep(0.2)

    # 5. commit
    res = await rpc("commit_turn")
    print(f"[repro] commit_turn → {res}")
    commit_at = time.time()

    # 6. poll opencode: did a user message land?
    sid = None
    for _ in range(10):
        try:
            for s in http_json("http://127.0.0.1:4096/session"):
                if s.get("title") == ROOM:
                    sid = s["id"]
                    break
            if sid:
                break
        except Exception:
            pass
        await asyncio.sleep(0.5)
    if not sid:
        print("[repro] BUG (no opencode session appeared)")
        return 1

    for _ in range(60):
        try:
            msgs = http_json(f"http://127.0.0.1:4096/session/{sid}/message")
            if isinstance(msgs, dict):
                msgs = msgs.get("messages", [])
            for m in msgs:
                if m.get("role") == "user":
                    text = "".join(
                        p.get("text", "") for p in (m.get("parts") or []) if p.get("type") == "text"
                    )
                    if "testing one two three" in text.lower():
                        print(f"[repro] OK: user message landed: {text[:80]!r}")
                        return 0
        except Exception:
            pass
        await asyncio.sleep(1)
    print(f"[repro] BUG: no user message {time.time()-commit_at:.0f}s after commit")
    return 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    finally:
        try:
            asyncio.get_event_loop().run_until_complete  # noqa
        except Exception:
            pass
