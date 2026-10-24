#!/usr/bin/env python3
"""THE ACCELERATED STABILITY SUITE — v0.7 gate item 4 (Rule 10-09: only simulation is
proof; the wall-clock 24h gate is deleted).

It runs on the SIM stack (scripts/sim-stack.sh): the served sandbox build + the yggdrasil
release binary under their production restart policies, against the mock LLM, so a day's
worth of churn fits in minutes and every kill lands on a sim unit — never on the user's
stack (asserted at the end). The 24h budget is the measured life, rounded up:
  - reconnects: the live diag's peak day showed 64 visibility flips → 200 (SSE re-subscribe
    + transcript poll + list poll, the phone's wake sequence)
  - rekeys: 132-155 voice-connect lines on the peak day → 100 fresh-token LiveKit joins of
    the same room (a phone's reconnect), against the real LiveKit server
  - turns: the life study (LIFE.md) measured ~64 user turns/day, each an agent loop → 300
    tool-loop turns in ONE marathon session (the life's marathon pattern), plus the turns
    the other phases drive
  - the faults a day can bring, at a far higher rate than a day brings them: 10 brain
    SIGKILLs mid-turn, 5 LLM-provider deaths mid-stream, 10 proxy SIGKILLs with turns queued
Exit 0 = PASS; the receipt lands in artifacts/stability-report-<run>.json.

Only python3-stdlib + curl-free urllib + systemctl; the LiveKit join loop runs under the
voice agent's venv (livekit rtc SDK)."""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = "http://127.0.0.1:8096"
BRAIN = "http://127.0.0.1:4111"
PWA_UNIT, BRAIN_UNIT, MOCK_UNIT = "sim-pwa", "sim-ygg", "sim-mock"
SIM_DIR = Path(os.environ.get("SIM_DIR", "/tmp/bifrost-sim"))
LK_PY = Path.home() / "Work/lane2-merge/agent/.venv/bin/python"
N_RECONNECT = int(os.environ.get("CHURN_RECONNECTS", 200))
N_REKEY = int(os.environ.get("CHURN_REKEYS", 100))
N_BRAIN_KILL = int(os.environ.get("CHURN_BRAIN_KILLS", 10))
N_PROVIDER_DEATH = int(os.environ.get("CHURN_PROVIDER_DEATHS", 5))
N_PROXY_KILL = int(os.environ.get("CHURN_PROXY_KILLS", 10))
N_SOAK = int(os.environ.get("CHURN_SOAK_TURNS", 300))
RUN = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
MARATHON = f"churn-marathon-{RUN.lower()}"

results = []
report_path = ROOT / "artifacts" / f"stability-report-{RUN}.json"


# ── plumbing ──────────────────────────────────────────────────────────────────
def phase(n, name):
    print(f"\n== phase {n}: {name}", flush=True)
    return {"phase": n, "name": name, "checks": [], "t0": time.time()}


def check(p, what, ok, detail=""):
    p["checks"].append({"what": what, "ok": bool(ok), "detail": str(detail)[:400]})
    print(f"   {'PASS' if ok else 'FAIL'}  {what}" + (f"  — {detail}" if detail else ""), flush=True)
    return ok


def finish(p):
    p["dur_s"] = round(time.time() - p.pop("t0"), 1)
    p["ok"] = bool(p["checks"]) and all(c["ok"] for c in p["checks"])
    results.append(p)
    print(f"   phase {'GREEN' if p['ok'] else 'RED'} in {p['dur_s']}s", flush=True)


def call(method, url, body=None, headers=None, timeout=30):
    """→ (status, lowercase-keyed headers, parsed body). Never raises for HTTP or socket errors."""
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json", **(headers or {})}
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw, st, hd = resp.read().decode(), resp.status, resp.headers
    except urllib.error.HTTPError as e:
        raw, st, hd = e.read().decode(), e.code, e.headers
    except (urllib.error.URLError, OSError) as e:
        return 0, {}, str(e)
    hd = {k.lower(): v for k, v in hd.items()}  # Next sends lowercase names
    try:
        return st, hd, json.loads(raw) if raw.strip()[:1] in "[{" else raw
    except ValueError:
        return st, hd, raw


def unit_pid(unit):
    out = subprocess.run(["systemctl", "--user", "show", "-p", "MainPID", "--value", unit],
                         capture_output=True, text=True).stdout.strip()
    return int(out) if out.isdigit() and int(out) > 0 else None


def proc_stat(unit):
    """(rss KB, open fds) of a unit's main process — the leak witnesses."""
    pid = unit_pid(unit)
    if not pid:
        return None, None
    try:
        rss = next(int(l.split()[1]) for l in Path(f"/proc/{pid}/status").read_text().splitlines()
                   if l.startswith("VmRSS:"))
        return rss, len(os.listdir(f"/proc/{pid}/fd"))
    except (OSError, StopIteration):
        return None, None


def sigkill(unit):
    subprocess.run(["systemctl", "--user", "kill", "--signal=SIGKILL", unit], check=False)


def healed(unit, probe, old_pid, timeout=40):
    """systemd brought the unit back (a NEW pid) AND it answers on its port."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        pid = unit_pid(unit)
        if pid and pid != old_pid and call("GET", probe, timeout=3)[0] == 200:
            return round(time.time() - t0, 1)
        time.sleep(0.25)
    return None


def poll(fn, timeout, every=0.25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(every)
    return fn()


def mk_session(name):
    st, _, d = call("POST", f"{APP}/api/session", {"name": name})
    assert st == 200 and isinstance(d, dict) and d.get("id"), f"create {name}: {st} {d}"
    return d["id"]


def send(sid, text):
    return call("POST", f"{APP}/api/session/{sid}/messages", {"text": text, "async": True},
                headers={"X-Session-Pin": sid}, timeout=15)[0]


def transcript(sid):
    st, h, d = call("GET", f"{APP}/api/session/{sid}/messages?limit=5000",
                    headers={"X-Session-Pin": sid}, timeout=30)
    return (d if st == 200 and isinstance(d, list) else None), h


def brain_state(sid):
    st, _, d = call("GET", f"{BRAIN}/session/{sid}", timeout=5)
    if st != 200 or not isinstance(d, dict):
        return "unreachable"
    s = d.get("state") or {}
    return s.get("type", "?") + (f"/{s['reason']}" if s.get("reason") else "")


def settled(sid):
    """the run is over on BOTH sides: proxy not live, brain not working"""
    _, h, _ = call("GET", f"{APP}/api/session/{sid}/messages?limit=1",
                   headers={"X-Session-Pin": sid}, timeout=10)
    return h.get("x-run-live") == "0" and not brain_state(sid).startswith(("working", "unreach"))


def turn(sid, text, timeout=30):
    """one phone turn: send, wait until both sides settle → seconds, or None"""
    t0 = time.time()
    if send(sid, text) != 200:
        return None
    time.sleep(0.05)
    return round(time.time() - t0, 2) if poll(lambda: settled(sid), timeout, 0.1) else None


def users_and_replies(msgs, texts):
    """for each sent text: how many times it landed as a user turn, and whether an
    assistant message follows its first landing"""
    out = {}
    for t in texts:
        idx = [i for i, m in enumerate(msgs) if m.get("role") == "user" and m.get("text", "").strip() == t]
        replied = bool(idx) and any(m.get("role") == "assistant" for m in msgs[idx[0] + 1:])
        out[t] = (len(idx), replied)
    return out


class Listener(threading.Thread):
    """the phone's long-lived run-events stream: counts run-end nudges for one session"""

    def __init__(self, slug):
        super().__init__(daemon=True)
        self.slug, self.idle, self.alive, self.stop = slug, 0, False, False

    def run(self):
        try:
            with urllib.request.urlopen(f"{APP}/api/run-events?slug={self.slug}", timeout=600) as r:
                self.alive = True
                while not self.stop:
                    line = r.readline().decode()
                    if not line:
                        break
                    if line.strip() == "data: idle":
                        self.idle += 1
        except OSError:
            pass
        self.alive = False


def reconnect(slug, sid):
    """one wake: re-subscribe run-events (first frame), poll the transcript, poll the list"""
    ok = True
    try:
        with urllib.request.urlopen(f"{APP}/api/run-events?slug={slug}", timeout=10) as r:
            ok = r.readline().decode().startswith("retry:")
    except OSError:
        ok = False
    ok &= transcript(sid)[0] is not None
    ok &= call("GET", f"{APP}/api/session", timeout=15)[0] == 200
    return ok


# ── phase 0: the sim stack + the user's stacks' fingerprints ─────────────────
p = phase(0, "preflight: a fresh sim stack; fingerprints of the stacks that must not move")
up = subprocess.run([str(ROOT / "scripts/sim-stack.sh"), "up"], env={**os.environ, "SIM_FRESH": "1"},
                    capture_output=True, text=True)
check(p, "sim stack up (mock + brain + proxy)", up.returncode == 0, up.stdout.strip().splitlines()[-1:])
st, _, b = call("GET", f"{APP}/api/build")
want = (ROOT / "pwa/.next/BUILD_ID").read_text().strip()
check(p, "the sim serves the sandbox build under test", isinstance(b, dict) and b.get("id") == want,
      f"sim {b.get('id') if isinstance(b, dict) else b} vs sandbox {want}")
USER_STACKS = {u: unit_pid(u) for u in ("lk-yggdrasil", "bifrost-sandbox", "lk-pwa", "opencode-legacy")}
_, _, main_before = call("GET", "http://127.0.0.1:4100/session")
MAIN_ID = next((s["id"] for s in main_before if isinstance(main_before, list)
                and s.get("title") in ("[MAIN]", "MAIN")), None) if isinstance(main_before, list) else None
MAIN_BEFORE = json.dumps(call("GET", f"http://127.0.0.1:4100/session/{MAIN_ID}/message")[2]) if MAIN_ID else None
check(p, "user stacks fingerprinted (pids + the sandbox MAIN transcript)",
      all(USER_STACKS.values()) and MAIN_BEFORE is not None, {**USER_STACKS, "main": MAIN_ID})
SID = mk_session(MARATHON)
warm = [turn(SID, f"Reply with exactly: warm-{i}") for i in range(10)]
check(p, "10 warm-up turns", all(warm), f"turn s: {warm}")
BASE_PWA, BASE_BRAIN = proc_stat(PWA_UNIT), proc_stat(BRAIN_UNIT)
check(p, "baselines (rss KB, fds)", BASE_PWA[0] and BASE_BRAIN[0], f"proxy {BASE_PWA} brain {BASE_BRAIN}")
finish(p)

# ── phase 1: reconnects ──────────────────────────────────────────────────────
p = phase(1, f"reconnects x{N_RECONNECT} — the phone's wake sequence, turns running underneath")
L = Listener(MARATHON)
L.start()
poll(lambda: L.alive, 10)
sent, ok_wakes, lat = [], 0, []
for i in range(N_RECONNECT):
    if i % 20 == 0:
        t = f"Reply with exactly: wake-{i}"
        send(SID, t)
        sent.append(t)
    t0 = time.time()
    ok_wakes += reconnect(MARATHON, SID)
    lat.append(time.time() - t0)
poll(lambda: settled(SID), 30)
time.sleep(1.5)  # the last idle nudge in flight
msgs, _ = transcript(SID)
landed = users_and_replies(msgs or [], sent)
L.stop = True
lat.sort()
check(p, f"{N_RECONNECT}/{N_RECONNECT} wakes answered (SSE first frame + transcript + list)",
      ok_wakes == N_RECONNECT, f"{ok_wakes}/{N_RECONNECT}; p50 {lat[len(lat)//2]*1000:.0f}ms max {lat[-1]*1000:.0f}ms")
check(p, f"all {len(sent)} turns sent under the churn landed exactly once, each replied",
      all(v == (1, True) for v in landed.values()), {k[-8:]: v for k, v in landed.items() if v != (1, True)} or "all (1, replied)")
check(p, "the long-lived stream saw every run end (no lost or doubled nudge)",
      L.alive and L.idle == len(sent), f"idle nudges {L.idle} for {len(sent)} runs, stream alive={L.alive}")
after = proc_stat(PWA_UNIT)
check(p, "no socket leak from the re-subscribes (proxy fds)", after[1] <= BASE_PWA[1] + 15,
      f"fds {BASE_PWA[1]} → {after[1]}")
finish(p)

# ── phase 2: rekeys (real LiveKit joins) ─────────────────────────────────────
p = phase(2, f"rekeys x{N_REKEY} — fresh token, same room, real LiveKit join/leave")
env_local = dict(l.split("=", 1) for l in (ROOT / "pwa/.env.local").read_text().splitlines()
                 if "=" in l and not l.startswith("#"))
LK_ROOM = f"sim-churn-{RUN.lower()}"
lk_script = r'''
import asyncio, json, sys, time, urllib.request
from livekit import rtc, api
app, room_name, n, api_url, key, secret = sys.argv[1], sys.argv[2], int(sys.argv[3]), *sys.argv[4:7]
res = {"ok": 0, "fail": [], "ms": [], "identities": set()}
async def main():
    for i in range(n):
        t0 = time.time()
        try:
            req = urllib.request.Request(f"{app}/api/token", data=json.dumps({"room": room_name}).encode(),
                                         headers={"content-type": "application/json"})
            d = json.loads(urllib.request.urlopen(req, timeout=15).read())
            room = rtc.Room()
            await asyncio.wait_for(room.connect(d["serverUrl"], d["participantToken"]), 15)
            res["identities"].add(room.local_participant.identity)
            await room.disconnect()
            res["ok"] += 1
            res["ms"].append(round((time.time() - t0) * 1000))
        except Exception as e:
            res["fail"].append(f"{i}: {e!r}"[:160])
    await asyncio.sleep(2)
    lk = api.LiveKitAPI(url=api_url, api_key=key, api_secret=secret)
    try:
        parts = await lk.room.list_participants(api.ListParticipantsRequest(room=room_name))
        res["left_in_room"] = len(parts.participants)
    except Exception as e:
        res["left_in_room"] = f"room gone ({type(e).__name__})"
    await lk.aclose()
asyncio.run(main())
res["identities"] = sorted(res["identities"])
print(json.dumps(res))
'''
lk = subprocess.run([str(LK_PY), "-c", lk_script, APP, LK_ROOM, str(N_REKEY),
                     env_local.get("LIVEKIT_API_URL", "http://127.0.0.1:7880"),
                     env_local["LIVEKIT_API_KEY"], env_local["LIVEKIT_API_SECRET"]],
                    capture_output=True, text=True, timeout=900)
try:
    lr = json.loads(lk.stdout.strip().splitlines()[-1])
except (ValueError, IndexError):
    lr = {"ok": 0, "fail": [lk.stderr[-400:]], "ms": [0], "identities": [], "left_in_room": "?"}
ms = sorted(lr["ms"]) or [0]
check(p, f"{N_REKEY}/{N_REKEY} rekeys joined the room on a fresh token", lr["ok"] == N_REKEY,
      f"{lr['ok']} ok, p50 {ms[len(ms)//2]}ms max {ms[-1]}ms, fails {lr['fail'][:3]}")
check(p, "one stable identity across every rekey (reconnects resume the participant)",
      lr["identities"] == [f"user_{LK_ROOM}"], lr["identities"])
check(p, "no participant leaked into the room after the churn",
      lr["left_in_room"] == 0 or str(lr["left_in_room"]).startswith("room gone"), lr["left_in_room"])
check(p, "the proxy still serves the session after the token churn", transcript(SID)[0] is not None)
finish(p)

# ── phase 3: the brain dies mid-turn ─────────────────────────────────────────
p = phase(3, f"brain SIGKILL mid-turn x{N_BRAIN_KILL} — heal, the dead run said, the next turn runs")
heals, said, closed, unwedged, next_ok, resub = [], 0, 0, 0, 0, []
for i in range(N_BRAIN_KILL):
    send(SID, f"slow please — kill round {i}")
    poll(lambda: brain_state(SID) == "working", 10)
    old = unit_pid(BRAIN_UNIT)
    t_kill = time.time()
    sigkill(BRAIN_UNIT)
    h = healed(BRAIN_UNIT, f"{BRAIN}/session", old)
    t_back = time.time()
    heals.append(h)
    said += bool(poll(lambda: brain_state(SID) == "blocked/interrupted", 10))
    _, hd = transcript(SID)
    closed += "|0|" not in hd.get("x-run-state", "|0|")
    unwedged += bool(poll(lambda: settled(SID), 20))
    nt = f"Reply with exactly: after-kill-{i}"
    next_ok += bool(turn(SID, nt))

    # the proxy's brain event stream re-subscribed: probe turns until the proxy
    # stamps a brain event newer than the heal → seconds from "brain back"
    def seen_again():
        _, hd = transcript(SID)
        if int(hd.get("x-run-last-event", 0)) / 1000 > t_back:
            return round(time.time() - t_back, 2)
        turn(SID, "Reply with exactly: probe")
        return None
    resub.append(poll(seen_again, 10, 0.05))
rss_b = proc_stat(BRAIN_UNIT)[0]
check(p, f"{N_BRAIN_KILL}/{N_BRAIN_KILL} kills healed by systemd (new pid, port answers)",
      all(heals), f"heal s: {heals}")
check(p, "every killed run declared blocked/interrupted by the restarted brain", said == N_BRAIN_KILL, f"{said}/{N_BRAIN_KILL}")
check(p, "every killed run closed in the transcript (no ghost step)", closed == N_BRAIN_KILL, f"{closed}/{N_BRAIN_KILL}")
check(p, "the phone never left on working (proxy live flag clears)", unwedged == N_BRAIN_KILL, f"{unwedged}/{N_BRAIN_KILL}")
check(p, "the next turn after every heal runs and settles", next_ok == N_BRAIN_KILL, f"{next_ok}/{N_BRAIN_KILL}")
check(p, "the proxy's brain event stream back within 2s of every heal", all(r is not None and r <= 2 for r in resub),
      f"s after the brain answered: {resub}")
check(p, "brain memory released by the restarts", rss_b and rss_b < max(3 * BASE_BRAIN[0], 60_000),
      f"rss {BASE_BRAIN[0]} → {rss_b} KB")
finish(p)

# ── phase 4: the LLM provider dies mid-stream ────────────────────────────────
p = phase(4, f"LLM provider death mid-stream x{N_PROVIDER_DEATH} — the brain survives and says so")
brain_pid = unit_pid(BRAIN_UNIT)
blocked, recovered, outcomes = 0, 0, []
for i in range(N_PROVIDER_DEATH):
    send(SID, f"slow please — provider round {i}")
    poll(lambda: brain_state(SID) == "working", 10)
    time.sleep(1.0)  # mid-stream: deltas are flowing
    old = unit_pid(MOCK_UNIT)
    sigkill(MOCK_UNIT)
    poll(lambda: settled(SID), 30)
    outcomes.append(brain_state(SID))
    blocked += outcomes[-1].startswith("blocked")
    healed(MOCK_UNIT, "http://127.0.0.1:18190/calls", old, 20)
    recovered += bool(turn(SID, f"Reply with exactly: provider-back-{i}"))
check(p, "the brain process survived every provider death (same pid)", unit_pid(BRAIN_UNIT) == brain_pid,
      f"pid {brain_pid} → {unit_pid(BRAIN_UNIT)}")
check(p, "every cut-off run declared blocked (never a silent idle on a truncated reply)",
      blocked == N_PROVIDER_DEATH, f"states after the cut: {outcomes}")
check(p, "the next turn after the provider returns runs and settles", recovered == N_PROVIDER_DEATH,
      f"{recovered}/{N_PROVIDER_DEATH}")
finish(p)

# ── phase 5: the proxy dies with turns queued ────────────────────────────────
p = phase(5, f"proxy SIGKILL with queued turns x{N_PROXY_KILL} — the disk queue replays exactly-once")
rounds, heal_s, all_queued = [], [], []
for i in range(N_PROXY_KILL):
    hold = f"Run exactly this bash command: sleep 3. Then reply: hold-{i}"
    send(SID, hold)
    poll(lambda: call("GET", f"{APP}/api/session/{SID}/messages?limit=1",
                      headers={"X-Session-Pin": SID})[1].get("x-run-live") == "1", 10)
    queued = [f"Reply with exactly: queued-{i}-{j}" for j in range(2)]
    for q in queued:
        send(SID, q)
    all_queued += queued
    old = unit_pid(PWA_UNIT)
    sigkill(PWA_UNIT)
    heal_s.append(healed(PWA_UNIT, f"{APP}/api/build", old, 60))

    def drained():
        m, _ = transcript(SID)
        if m is None:
            return None
        got = users_and_replies(m, [hold] + queued)
        return got if all(v[1] for v in got.values()) and not any(x.get("queued") for x in m) else None
    got = poll(drained, 90, 1) or users_and_replies(transcript(SID)[0] or [], [hold] + queued)
    rounds.append({k[-12:]: v for k, v in got.items()})
exact = all(all(v == (1, True) for v in r.values()) for r in rounds)
check(p, f"{N_PROXY_KILL}/{N_PROXY_KILL} proxy kills healed by systemd", all(heal_s), f"heal s: {heal_s}")
check(p, "every queued turn replayed exactly once and replied; no hold turn doubled", exact,
      [r for r in rounds if not all(v == (1, True) for v in r.values())][:3] or f"{len(all_queued)} queued turns, all (1, replied)")
qfile = SIM_DIR / "pwa/.oc-queue.json"
check(p, "the disk queue is empty after the drain", not qfile.exists() or qfile.read_text().strip() in ("", "{}"),
      qfile.read_text()[:120] if qfile.exists() else "no file")
finish(p)

# ── phase 6: the memory soak ─────────────────────────────────────────────────
# Two soaks, two questions. The MARATHON (the life's shape: a day in one session) asks
# "does a day fit?" — the brain holds the store in RAM and each run sends the full history
# upstream, so its RSS tracks the transcript by design (bounded in production by the
# roll-up threshold); the proxy must stay flat. The FLAT-DATA soak asks "does anything
# leak?" — the same turn volume over short sessions that are deleted, so the data stays
# bounded: any RSS that still climbs is a leak.
BRAIN_DAY_BUDGET_KB = 128 * 1024
p = phase(6, f"memory soak — a {N_SOAK}-turn marathon + a {N_SOAK}-turn flat-data leak detector")


def soak(turns, sid_for, label):
    samples, unsettled, reads = [], [], 0
    for i in range(1, turns + 1):
        sid = sid_for(i)
        if turn(sid, f"Use the bash tool to run `echo {label}-{i}` and tell me what it printed.") is None:
            unsettled.append(i)
        for _ in range(3):
            reads += transcript(sid)[0] is not None
        if i % 50 == 0:
            pw, br = proc_stat(PWA_UNIT), proc_stat(BRAIN_UNIT)
            samples.append({"turn": i, "proxy_rss": pw[0], "proxy_fds": pw[1], "brain_rss": br[0], "brain_fds": br[1]})
            print(f"   {label} {i}: proxy {pw} brain {br}", flush=True)
    return samples, unsettled, reads


def drift(samples, key):  # turn 100 → the end
    a, b = (samples[1] if len(samples) > 2 else samples[0])[key], samples[-1][key]
    return a, b, b / a - 1


m_samples, m_unsettled, m_reads = soak(N_SOAK, lambda i: SID, "soak")
msgs, _ = transcript(SID)
n_msgs = len(msgs or [])
flat_sid = {}


def flat_session(i):
    k = (i - 1) // 10  # 10 turns per session, then it dies
    if k not in flat_sid:
        for old in list(flat_sid.values()):
            call("DELETE", f"{APP}/api/session/{old}")
        flat_sid.clear()
        flat_sid[k] = mk_session(f"churn-flat-{RUN.lower()}-{k}")
    return flat_sid[k]


f_samples, f_unsettled, f_reads = soak(N_SOAK, flat_session, "flat")
for old in flat_sid.values():
    call("DELETE", f"{APP}/api/session/{old}")
pa, pb, pd = drift(m_samples, "proxy_rss")
check(p, f"marathon: {N_SOAK}/{N_SOAK} turns ran and settled, {m_reads}/{3 * N_SOAK} reads answered",
      not m_unsettled and m_reads == 3 * N_SOAK, f"unsettled: {m_unsettled[:10]}")
check(p, "marathon: the transcript holds the whole day", n_msgs >= 2 * N_SOAK, f"{n_msgs} messages")
check(p, "marathon: proxy RSS flat (turn 100 → end ≤ +25%)", pd <= 0.25, f"{pa} → {pb} KB ({pd:+.1%})")
ba, bb, bd = drift(m_samples, "brain_rss")
check(p, "marathon: a day fits the brain (RSS ≤ 128 MB; tracks the transcript by design)",
      bb <= BRAIN_DAY_BUDGET_KB, f"{ba} → {bb} KB ({bd:+.1%}) for {n_msgs} messages")
check(p, "marathon: no fd leak in either process",
      m_samples[-1]["proxy_fds"] <= m_samples[0]["proxy_fds"] + 10 and m_samples[-1]["brain_fds"] <= m_samples[0]["brain_fds"] + 10,
      f"proxy {m_samples[0]['proxy_fds']}→{m_samples[-1]['proxy_fds']} brain {m_samples[0]['brain_fds']}→{m_samples[-1]['brain_fds']}")
check(p, f"flat-data: {N_SOAK}/{N_SOAK} turns over {N_SOAK // 10} short sessions ran and settled",
      not f_unsettled and f_reads == 3 * N_SOAK, f"unsettled: {f_unsettled[:10]}")
fa, fb, fd = drift(f_samples, "brain_rss")
check(p, "flat-data: brain RSS flat — nothing leaks (turn 100 → end ≤ +10%)", fd <= 0.10, f"{fa} → {fb} KB ({fd:+.1%})")
qa, qb, qd = drift(f_samples, "proxy_rss")
check(p, "flat-data: proxy RSS flat — nothing leaks (turn 100 → end ≤ +25%)", qd <= 0.25, f"{qa} → {qb} KB ({qd:+.1%})")
samples = {"marathon": m_samples, "flat": f_samples}
finish(p)

# ── phase 7: end state ───────────────────────────────────────────────────────
p = phase(7, "end state: nothing stuck, nothing leaked, the user's stacks untouched")
_, _, lst = call("GET", f"{APP}/api/session")
stuck = [s["title"] for s in lst if s.get("state") == "working"] if isinstance(lst, list) else ["list down"]
check(p, "no session reads working on the list", not stuck, stuck)
check(p, "the brain's busy map is empty", call("GET", f"{BRAIN}/session/status")[2] == {})
msgs, _ = transcript(SID)
ghost = [m for m in (msgs or []) if m.get("role") == "assistant" and m.get("done") is False]
check(p, "no assistant step left open in the marathon", not ghost, f"{len(ghost)} open")
moved = {u: (pid, unit_pid(u)) for u, pid in USER_STACKS.items() if unit_pid(u) != pid}
check(p, "the user's stacks never restarted (sandbox :8090/:4100, live :8080/:4096)", not moved, moved or "same pids")
main_after = json.dumps(call("GET", f"http://127.0.0.1:4100/session/{MAIN_ID}/message")[2])
check(p, "the sandbox MAIN transcript is byte-identical", main_after == MAIN_BEFORE)
finish(p)

subprocess.run([str(ROOT / "scripts/sim-stack.sh"), "down"], capture_output=True)
total = round(sum(r["dur_s"] for r in results), 1)
green = all(r["ok"] for r in results)
report = {
    "suite": "accelerated-stability-v2 (sim stack)",
    "gate": "v0.7 item 4 — Rule 10-09: only simulation is proof",
    "run": RUN,
    "build": want,
    "stack": {"app": APP, "brain": BRAIN, "llm": "yggdrasil mock (anthropic dialect)",
              "units": "transient systemd, production restart policies"},
    "budget_24h_equivalent": {"reconnects": N_RECONNECT, "rekeys": N_REKEY, "brain_kills": N_BRAIN_KILL,
                              "provider_deaths": N_PROVIDER_DEATH, "proxy_kills": N_PROXY_KILL,
                              "soak_turns": f"{N_SOAK} marathon + {N_SOAK} flat-data", "measured_day": "64 visibility flips, 155 voice-connect "
                              "lines (live diag peak), ~64 user turns/day (LIFE.md)"},
    "wall_clock_s": total,
    "soak_samples": samples,
    "phases": results,
    "verdict": "PASS — 24h-equivalent churn proven in simulation" if green else "FAIL",
}
report_path.parent.mkdir(exist_ok=True)
report_path.write_text(json.dumps(report, indent=1))
print(f"\n{'PASS' if green else 'FAIL'} — {report_path}  (wall {total}s)")
sys.exit(0 if green else 1)
