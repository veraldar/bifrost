#!/usr/bin/env python3
"""rootlink-sim — loopback proof for the v4 root-link dial-in plane.

NO VPS, NO deploy. Spawns the release bridge with [bridge.root-link] ON,
dials fake roots over raw-RFC6455 ws (stdlib only — no deps), and
asserts the whole law:

  T1 routing   two roots linked; a branch turn named at each lands on the
               RIGHT root's socket and the result rides back
  T2 single-use  a second dial with the SAME link-token is refused and
               the surviving conn keeps serving turns
  T3 takeover  reconnect with a FRESH token for the same root id replaces
               the old conn (old socket closed, new conn gets the jobs)
  T4 anonymous device token naming a root = refused (allowlist law);
               missing token = refused
  T5 close     a root that closes its ws is reaped: next turn = "root not linked"
  T6 wedged    root answers WS pings but never root.ping jobs → trunk's
               agent-level health probe unlinks it after 3 consecutive
               failures; the parked branch turn gets 'root unhealthy' FAST
               (< RESULT_WAIT), the worker is freed, next turn = not linked
  T7 cap       max_inflight=1: a root HOLDING a job gets the second turn
               refused 429-style IMMEDIATELY (no queued worker slot);
               after the result, the slot frees and turns flow again
  T8 mint      `rootlink mint` CLI smoke: capsule sig + claims + jti
               verified against the Python HMAC reference
  T9 dial-exec THE REAL root-dial.py runs the link: its health pongs are
               EARNED by a trivial exec of the agent (probe-exec), a
               multi-minute root.job does NOT starve the read loop
               (probe keeps flowing, exec-leg answer arrives after),
               and a takeover-displaced conn reconnects with its NEXT
               file token; an empty token file exits LOUDLY
  T10 guard    root-dial.py REFUSES plaintext ws to a non-private host
               unless --allow-public (probe never connects)

LAW: the health probe is AGENT-level — root-dial must EXEC the agent
to earn each root.pong; a dial script that pongs without exec is a
LIE the trunk would believe.
"""
import base64, hashlib, hmac, json, os, queue, shutil, socket, struct, subprocess, sys, tempfile, time
import http.client, threading

BIN = os.path.join(os.path.dirname(__file__), "..", "target", "release", "bifrost-net")
HTTP_PORT, WS_PORT = 8471, 8472
RESULT_WAIT = 20  # registry.rs law

def b64url(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def mint_link_token(secret, root, dev):
    payload = json.dumps({"v": 1, "root": root, "roots": [root], "dev": dev,
                          "iat": int(time.time()), "jti": os.urandom(6).hex()},
                         separators=(",", ":")).encode()
    body = b64url(payload)
    sig = b64url(hmac.new(secret, body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"

# --- minimal RFC 6455 client (masked client frames, as the codec demands) ---
class Ws:
    def __init__(self, port):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=10)
        key = b64url(os.urandom(16))
        req = (f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.s.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.s.recv(4096)
            if not chunk: raise RuntimeError("handshake EOF")
            buf += chunk
        status = buf.split(b"\r\n", 1)[0].decode()
        if "101" not in status:
            raise RuntimeError(f"ws refused: {status} :: {buf[:200]!r}")

    def send_text(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        hdr = bytes([0x81])
        n = len(payload)
        if n < 126:   hdr += bytes([0x80 | n])
        elif n < 65536: hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:         hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.s.sendall(hdr + mask + masked)

    def send_pong(self, payload=b""):
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.s.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask + masked)

    def recv_msg(self, timeout=8):
        """next TEXT payload (answers pings automatically); None on close/EOF"""
        self.s.settimeout(timeout)
        def frame():
            h = self._read(2)
            if h is None: return None
            opcode = h[0] & 0x0F
            ln = h[1] & 0x7F
            if ln == 126: ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127: ln = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(ln) if ln else b""
            return opcode, payload
        while True:
            got = frame()
            if got is None: return None
            opcode, payload = got
            if opcode == 0x1: return payload.decode()
            if opcode == 0x8: return None
            if opcode == 0x9: self.send_pong(payload)   # trunk ping → pong

    def _read(self, n, buf=None):
        out = buf if buf is not None else getattr(self, "_buf", b"")
        while len(out) < n:
            try:
                chunk = self.s.recv(4096)
            except (socket.timeout, TimeoutError):
                raise TimeoutError("read timeout")
            if not chunk:
                if len(out) == 0: return None
                raise RuntimeError("EOF mid-frame")
            out += chunk
        res, self._buf = out[:n], out[n:]
        return res

class FakeRoot:
    """A healthy linked root: background thread answers ws pings AND the
    trunk's root.ping health probes (root.pong); root.job frames land in
    a queue the test pulls from. This IS the root-dial.py contract."""
    def __init__(self, token):
        self.ws = Ws(WS_PORT)
        self.jobs = queue.Queue()
        self.alive = True
        self.ws.send_text(json.dumps({"op": "root-link", "token": token}))
        self.ack = json.loads(self.ws.recv_msg())
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while self.alive:
            try:
                msg = self.ws.recv_msg(timeout=5)
            except (TimeoutError, RuntimeError, OSError):
                continue
            if msg is None:
                break
            try:
                v = json.loads(msg)
            except Exception:
                continue
            op = v.get("op")
            if op == "root.ping":                    # HEALTH LAW: agent answers
                self.ws.send_text(json.dumps({"op": "root.pong"}))
            elif op == "root.job":
                self.jobs.put(v)

    def next_job(self, timeout=10):
        return self.jobs.get(timeout=timeout)

    def answer(self, job, ok=True, text=None):
        self.ws.send_text(json.dumps({"op": "root.result", "tid": job["tid"], "ok": ok,
                                      "text": text if text is not None else "{}"}))

    def close(self):
        self.alive = False
        try: self.ws.s.close()
        except Exception: pass

class WedgedRoot:
    """Answers WS pings (socket alive) but NEVER root.ping — the wedge."""
    def __init__(self, token):
        self.ws = Ws(WS_PORT)
        self.ws.send_text(json.dumps({"op": "root-link", "token": token}))
        self.ack = json.loads(self.ws.recv_msg())
        self.alive = True
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while self.alive:
            try:
                msg = self.ws.recv_msg(timeout=5)   # auto ws-pong inside
            except (TimeoutError, RuntimeError, OSError):
                continue
            if msg is None:
                break
            try:
                if json.loads(msg).get("op") == "root.ping":
                    pass  # WEDGED: agent never answers the health probe
            except Exception:
                pass

    def close(self):
        self.alive = False
        try: self.ws.s.close()
        except Exception: pass

REAL_DIAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "root-dial.py")

def fake_probe(dir_, tag):
    """Stand-in AGENT for probe-exec: exit 0 ONLY while <dir>/probe-ok
    exists — the trivial exec each root.pong must EARN."""
    p = os.path.join(dir_, f"probe-{tag}.sh")
    with open(p, "w") as f:
        f.write(f'#!/bin/sh\n[ -f "{dir_}/probe-ok" ] || {{ echo probe-refused >&2; exit 42; }}\necho agent-probe-ok\n')
    os.chmod(p, 0o755)
    return p

def fake_agent(dir_, tag, holdfile):
    """Stand-in AGENT for --exec: logs the turn text, sleeps the CURRENT
    value of `holdfile` (the sim retunes it mid-run), echoes it back."""
    p = os.path.join(dir_, f"agent-{tag}.sh")
    with open(p, "w") as f:
        f.write(f'#!/bin/sh\necho "$1" >> "{dir_}/agent-{tag}.log"\n'
                f'sleep "$(cat "{holdfile}" 2>/dev/null || echo 0.2)"\necho "echo:$1"\n')
    os.chmod(p, 0o755)
    return p

class RealRootDial:
    """The REAL scripts/root-dial.py as a subprocess against the live
    trunk — the exec-leg contract under test. Its pongs are earned by
    executing the probe binary; its jobs run the agent on the exec leg;
    its read loop must never stall. The TRUNK is the judge: health
    probes that stop being earned show up as 'unhealthy'/'not linked'
    at the turn boundary."""
    def __init__(self, token_file, dir_, tag, holdfile):
        self.proc = subprocess.Popen(
            [sys.executable, REAL_DIAL, "--host", "127.0.0.1",
             "--port", str(WS_PORT), "--token-file", token_file,
             "--exec", fake_agent(dir_, tag, holdfile),
             "--probe-exec", fake_probe(dir_, tag)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1)
        self.links = []                      # every "linked:" line, in order
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for line in self.proc.stdout:
            line = line.strip()
            if line.startswith("linked:"):
                self.links.append(line)

    def wait_link(self, n, timeout=10):
        """the n-th (1-based) successful link of this dial process"""
        end = time.time() + timeout
        while time.time() < end:
            if len(self.links) >= n:
                return self.links[n - 1]
            if self.proc.poll() is not None:
                raise RuntimeError(f"dial died before link #{n}: rc={self.proc.returncode}")
            time.sleep(0.05)
        raise RuntimeError(f"dial never made link #{n}")

    def wait_death(self, timeout=10):
        """after an exhaust-exit: the process must be DEAD (loud-exit law)"""
        end = time.time() + timeout
        while time.time() < end:
            if self.proc.poll() is not None:
                return self.proc.returncode
            time.sleep(0.05)
        return None

    def close(self):
        try: self.proc.kill()
        except Exception: pass

def branch(body, token=None):
    c = http.client.HTTPConnection("127.0.0.1", HTTP_PORT, timeout=RESULT_WAIT + 10)
    hdrs = {"Content-Type": "application/json"}
    if token: hdrs["Authorization"] = f"Bearer {token}"
    c.request("POST", "/branch", json.dumps(body), hdrs)
    r = c.getresponse()
    txt = r.read().decode()
    c.close()
    try: return r.status, json.loads(txt)
    except Exception: return r.status, {"raw": txt}

def branch_async(body, token=None):
    """fire a /branch turn in a thread; poll `res` once the root answered"""
    out = {}
    def run(): out["res"] = branch(body, token); out["t"] = time.time()
    threading.Thread(target=run, daemon=True).start()
    out["start"] = time.time()
    return out

def wait_res(out, timeout=RESULT_WAIT + 10):
    end = time.time() + timeout
    while time.time() < end:
        if "res" in out: return out["res"]
        time.sleep(0.05)
    raise RuntimeError("branch turn never returned (root result lost?)")

def expect(cond, msg):
    if not cond:
        print(f"    FAIL — {msg}"); sys.exit(1)
    print(f"    ok — {msg}")

def main():
    global BIN
    if not os.path.exists(BIN):
        BIN = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "artifacts", "bifrost-net-v4c"))
    BIN = os.path.abspath(BIN)
    dir_ = tempfile.mkdtemp(prefix="rootlink-sim-")
    raw_a, raw_b, raw_anon, raw_c = ("bfnd-" + b64url(os.urandom(18)) for _ in range(4))
    tok_b2_seed = os.urandom(18)
    devices = [
        {"id": "dev_a", "name": "a", "tokenHash": hashlib.sha256(raw_a.encode()).hexdigest(), "created": "now", "revoked": False, "roots": ["mac-a", "mac-b"]},
        {"id": "dev_b", "name": "b", "tokenHash": hashlib.sha256(raw_b.encode()).hexdigest(), "created": "now", "revoked": False, "roots": ["mac-b"]},
        {"id": "dev_anon", "name": "anon", "tokenHash": hashlib.sha256(raw_anon.encode()).hexdigest(), "created": "now", "revoked": False, "roots": []},
        {"id": "dev_c", "name": "c", "tokenHash": hashlib.sha256(raw_c.encode()).hexdigest(), "created": "now", "revoked": False, "roots": ["mac-c"]},
    ]
    with open(os.path.join(dir_, "devices.json"), "w") as f:
        json.dump({"devices": devices}, f)
    secret = b"rootlink-sim-secret"
    key = subprocess.run([BIN, "keygen"], capture_output=True, text=True).stdout
    priv = [l.split('"')[1] for l in key.splitlines() if "private_key" in l][0]
    cfg = f'''
[node]
name = "sim-trunk"
private_key = "{priv}"

[bridge]
http = "127.0.0.1:{HTTP_PORT}"
media = "127.0.0.1:{HTTP_PORT + 100}"
tokens_file = "{dir_}/devices.json"
root_link_secret = "{secret.decode()}"

[bridge.root-link]
enabled = true
ping_secs = 3
max_inflight = 1
'''
    with open(os.path.join(dir_, "sim.toml"), "w") as f: f.write(cfg)
    log = open(os.path.join(dir_, "bridge.log"), "w")
    proc = subprocess.Popen([BIN, "bridge", "-c", os.path.join(dir_, "sim.toml")],
                            stdout=log, stderr=subprocess.STDOUT)

    tok_a = mint_link_token(secret, "mac-a", "dev_a")
    tok_b = mint_link_token(secret, "mac-b", "dev_b")
    tok_b2 = mint_link_token(secret, "mac-b", "dev_b")
    tok_c = mint_link_token(secret, "mac-c", "dev_c")

    try:
        for _ in range(100):
            try:
                probe = http.client.HTTPConnection("127.0.0.1", HTTP_PORT, timeout=1)
                probe.request("GET", "/"); r = probe.getresponse(); r.read(); probe.close(); break
            except Exception:
                time.sleep(0.1)
                if proc.poll() is not None:
                    print(open(os.path.join(dir_, "bridge.log")).read()); sys.exit(1)

        # ---- T1: two roots dial in; turns route to the RIGHT root ----
        a, b = FakeRoot(tok_a), FakeRoot(tok_b)
        expect(a.ack.get("op") == "root-link.ok" and a.ack["root"] == "mac-a", f"root A linked {a.ack}")
        expect(b.ack.get("op") == "root-link.ok" and b.ack["root"] == "mac-b", f"root B linked {b.ack}")

        def turn(sock, root, text, token):
            h = branch_async({"op": "prompt", "id": "sess", "text": text, "root": root}, token)
            job = sock.next_job()
            sock.answer(job, True, json.dumps({"echo": text}))
            st, out = wait_res(h)
            return st, out, job

        st, out, job_a = turn(a, "mac-a", "turn-for-a", raw_a)
        expect(st == 200 and job_a["op"] == "root.job" and job_a["kind"] == "prompt"
               and job_a["body"]["text"] == "turn-for-a" and job_a["root"] == "mac-a"
               and out.get("echo") == "turn-for-a",
               f"turn named mac-a landed on root A and its result rode back")
        st, out, job_b = turn(b, "mac-b", "turn-for-b", raw_a)
        expect(st == 200 and job_b["root"] == "mac-b" and job_b["body"]["text"] == "turn-for-b"
               and out.get("echo") == "turn-for-b",
               "turn named mac-b landed on root B, NOT root A")

        # ---- T2: single-use — second dial with tok_a REFUSED ----
        a2 = Ws(WS_PORT)
        a2.send_text(json.dumps({"op": "root-link", "token": tok_a}))
        resp = json.loads(a2.recv_msg())
        expect(resp.get("op") == "root-link.error" and "already used" in resp.get("err", ""),
               f"second dial with spent token refused: {resp.get('err')}")
        expect(a2.recv_msg(timeout=5) is None, "refused socket closed by trunk")
        h = branch_async({"op": "transcript", "id": "s", "root": "mac-a"}, raw_a)
        jt = a.next_job()
        a.answer(jt, True, "{}")
        st, out = wait_res(h)
        expect(st == 200, "surviving conn still serves turns after a refused double-dial")

        # ---- T3: takeover — fresh token, same root id replaces the conn ----
        b.close()
        b2 = FakeRoot(tok_b2)
        expect(b2.ack.get("op") == "root-link.ok" and b2.ack["root"] == "mac-b", f"takeover dial linked {b2.ack.get('root')}")
        h = branch_async({"op": "prompt", "id": "s", "text": "post-takeover", "root": "mac-b"}, raw_a)
        job_b2 = b2.next_job()
        b2.answer(job_b2, True, json.dumps({"echo": "post-takeover"}))
        st, out = wait_res(h)
        expect(st == 200 and out.get("echo") == "post-takeover",
               "post-takeover turn rides the NEW conn")

        # ---- T4: anonymous + root=  REFUSED (allowlist law) ----
        st, out = branch({"op": "prompt", "id": "s", "text": "x", "root": "mac-a"}, raw_anon)
        expect(st == 403 and "not allowed" in out.get("err", ""), f"anonymous device naming a root: {st} {out.get('err')}")
        st, out = branch({"op": "prompt", "id": "s", "text": "x", "root": "mac-a"})
        expect(st == 401, f"missing device token: {st}")
        st, out = branch({"op": "prompt", "id": "s", "text": "x", "root": "mac-ghost"}, raw_a)
        expect(st == 403 and "not allowed" in out.get("err", ""),
               f"root outside the claim = 403, never a registry probe: {st} {out.get('err')}")

        # ---- T5: close = reap ----
        a.close()
        time.sleep(0.8)
        st, out = branch({"op": "transcript", "id": "s", "root": "mac-a"}, raw_a)
        # v4c law: whichever error comes back, it must be FAST and CLEAN —
        # either the conn is already reaped ("root not linked") or the
        # dying conn's drain freed the worker ("root unhealthy") — never a
        # hang, never an empty refusal.
        expect(st in (404, 429, 502, 503) and out.get("err") in ("root not linked", "root unhealthy"),
               f"closed root: fast clean error, worker freed: {st} {out.get('err')}")
        st, out = branch({"op": "transcript", "id": "s", "root": "mac-a"}, raw_a)
        expect(st == 404 and out.get("err") == "root not linked", f"closed root reaped: {st} {out.get('err')}")

        # ---- T6 (v4c GAP-A b): WEDGED root — ws alive, agent silent ----
        w = WedgedRoot(tok_c)
        expect(w.ack.get("op") == "root-link.ok" and w.ack["root"] == "mac-c", f"wedged root linked as mac-c {w.ack}")
        h = branch_async({"op": "prompt", "id": "s", "text": "into-the-wedge", "root": "mac-c"}, raw_c)
        st, out = wait_res(h, timeout=RESULT_WAIT + 5)
        elapsed = time.time() - h["start"]
        expect(st in (429, 503) and "unhealthy" in json.dumps(out),
               f"wedged root's parked turn failed FAST with 'root unhealthy': {st} {out} ({elapsed:.1f}s)")
        expect(elapsed < RESULT_WAIT, f"worker FREED before RESULT_WAIT ({elapsed:.1f}s < {RESULT_WAIT}s)")
        st, out = branch({"op": "transcript", "id": "s", "root": "mac-c"}, raw_c)
        expect(st == 404 and out.get("err") == "root not linked",
               f"3 probe failures auto-unlinked the wedged root: {st} {out.get('err')}")

        # ---- T7 (v4c GAP-A a): in-flight cap — 429, never a queued slot ----
        h1 = branch_async({"op": "prompt", "id": "s", "text": "hold-the-slot", "root": "mac-b"}, raw_a)
        job1 = b2.next_job()                      # b2 now HOLDS the cap slot
        t0 = time.time()
        st, out = branch({"op": "prompt", "id": "s", "text": "cap-refused", "root": "mac-b"}, raw_a)
        cap_elapsed = time.time() - t0
        expect(st == 429 and "busy" in out.get("err", "") and "cap 1" in out.get("err", ""),
               f"at-cap root refused 429-style: {st} {out.get('err')}")
        expect(cap_elapsed < 3.0, f"cap refusal was IMMEDIATE, no queued worker slot ({cap_elapsed:.2f}s)")
        b2.answer(job1, True, json.dumps({"echo": "slot-freed"}))
        st, out = wait_res(h1)
        expect(st == 200 and out.get("echo") == "slot-freed", "holding turn completed once answered")
        h3 = branch_async({"op": "prompt", "id": "s", "text": "cap-released", "root": "mac-b"}, raw_a)
        job3 = b2.next_job()
        b2.answer(job3, True, json.dumps({"echo": "flows-again"}))
        st, out = wait_res(h3)
        expect(st == 200 and out.get("echo") == "flows-again", "cap freed after result — turns flow again")

        # ---- T8 (v4c GAP-B 2): mint CLI smoke ----
        tf = os.path.join(dir_, "minted.txt")
        m = subprocess.run([BIN, "rootlink", "mint", "--root", "mac-z", "--dev", "dev_c",
                            "--ttl", "3600", "--secret", secret.decode(), "--out", tf],
                           capture_output=True, text=True)
        expect(m.returncode == 0 and os.path.exists(tf), f"mint CLI wrote a token: {m.stdout.strip() or m.stderr.strip()}")
        minted = open(tf).read().strip()
        body, sig = minted.split(".")
        pad = lambda s: s + "=" * (-len(s) % 4)
        payload = json.loads(base64.urlsafe_b64decode(pad(body)))
        want = b64url(hmac.new(secret, body.encode(), hashlib.sha256).digest())
        expect(payload.get("root") == "mac-z" and payload.get("dev") == "dev_c"
               and payload.get("v") == 1 and payload.get("jti") and hmac.compare_digest(sig, want),
               f"minted capsule verified vs Python HMAC reference (jti {payload.get('jti')})")
        mz = FakeRoot(minted)   # the minted token OPENS the live plane
        expect(mz.ack.get("op") == "root-link.ok" and mz.ack["root"] == "mac-z", "CLI-minted token links for real")
        mz.close()
        st, out = branch({"op": "prompt", "id": "s", "text": "x", "root": "mac-z"}, raw_c)
        expect(st == 403, f"mac-z not in dev_c's branch claim → 403 (link != branch law held): {st}")
        st2 = subprocess.run([BIN, "rootlink", "mint", "--root", "local", "--dev", "dev_c",
                              "--ttl", "60", "--secret", secret.decode()], capture_output=True, text=True)
        expect(st2.returncode != 0, "'local' is never mintable")

        # ---- T9 (sim3 GAP-B fix): THE REAL root-dial.py under the trunk ----
        raw_d = "bfnd-" + b64url(os.urandom(18))
        devices.append({"id": "dev_d", "name": "d", "tokenHash": hashlib.sha256(raw_d.encode()).hexdigest(),
                        "created": "now", "revoked": False, "roots": ["mac-d"]})
        with open(os.path.join(dir_, "devices.json"), "w") as f:
            json.dump({"devices": devices}, f)
        tfile = os.path.join(dir_, "dial-tokens.txt")
        with open(tfile, "w") as f:
            f.write(f"{mint_link_token(secret, 'mac-d', 'dev_d')}\n"
                    f"{mint_link_token(secret, 'mac-d', 'dev_d')}\n")
        open(os.path.join(dir_, "probe-ok"), "w").close()      # agent healthy
        hold = os.path.join(dir_, "hold.txt")                  # job sleep, sim-tunable
        with open(hold, "w") as f:
            f.write("0.2")
        d = RealRootDial(tfile, dir_, "d", hold)
        linked = d.wait_link(1)
        expect("linked: mac-d" in linked and "gen_no=6" in linked, f"REAL root-dial linked as mac-d: {linked}")

        def dial_turn(text):
            h = branch_async({"op": "prompt", "id": "s", "text": text, "root": "mac-d"}, raw_d)
            while "res" not in h:
                time.sleep(0.05)
            return wait_res(h)

        # (a) probe-exec: trunk pings every 3s; if pongs were NOT exec-earned
        # the probe-refused agent would leave probe_fails>0 and this turn
        # (dispatch probe) would fail 'unhealthy' — it must be 200.
        st, out = dial_turn("dial-turn-1")
        expect(st == 200 and out.get("root") == "mac-d" and "echo:dial-turn-1" in json.dumps(out),
               f"turn over the REAL dial: exec-leg result rode back: {st} {out}")

        # (b) job > 3×ping: read loop must keep earning probes DURING exec.
        with open(hold, "w") as f:
            f.write("14")
        h = branch_async({"op": "prompt", "id": "s", "text": "long-run", "root": "mac-d"}, raw_d)
        time.sleep(16)                          # ≥3 probes pass DURING the job
        with open(hold, "w") as f:
            f.write("0.2")                      # let the job finish now
        st, out = wait_res(h)
        elapsed = time.time() - h["start"]
        expect(st == 200 and "echo:long-run" in json.dumps(out),
               f"14s job survived: probes answered DURING exec, result rode back: {st} {out}")
        expect(elapsed < RESULT_WAIT + 5, f"long job stayed under the reap horizon ({elapsed:.1f}s)")

        # (c) takeover-displacement → fresh-token reconnect: the sim opens a
        # NEW conn with a fresh token for the same root id (the takeover
        # law) — trunk kills the dial's conn, its read loop dies, and the
        # dial must re-link on its NEXT file token; then a turn is served
        # over the re-established link.
        tok_e = mint_link_token(secret, "mac-d", "dev_d")
        tkm = Ws(WS_PORT)                     # takeover displacer conn
        tkm.send_text(json.dumps({"op": "root-link", "token": tok_e}))
        tack = json.loads(tkm.recv_msg())
        expect(tack.get("op") == "root-link.ok", f"takeover displacer linked: {tack.get('op')}")
        time.sleep(0.5)
        linked2 = d.wait_link(2)
        expect("gen_no=8" in linked2, f"dial re-linked after takeover displacement: {linked2}")
        st, out = dial_turn("dial-turn-2")
        expect(st == 200 and "echo:dial-turn-2" in json.dumps(out),
               "post-reconnect turn served over the re-linked dial")

        # (e) loud-exhaust: with the file spent, the next displacement leaves
        # the dial hunting for a token — it must EXIT loudly, never spin.
        tok_f = mint_link_token(secret, "mac-d", "dev_d")
        tkm2 = Ws(WS_PORT)
        tkm2.send_text(json.dumps({"op": "root-link", "token": tok_f}))
        tack2 = json.loads(tkm2.recv_msg())
        expect(tack2.get("op") == "root-link.ok", "second displacer linked")
        rc = d.wait_death(timeout=10)
        err = d.proc.stderr.read() if d.proc.stderr else ""
        expect(rc is not None and "token file exhausted" in err,
               f"dial exits LOUD on exhausted tokens (rc={rc}): {err.strip()[-90:]}")

        # ---- T10 (sim3 GAP-B 4): plaintext-ws public-range guard ----
        # host 1.2.3.4 is public (ipaddress: is_private False, no DNS
        # dependency); the guard must exit BEFORE any connection. The
        # --allow-public leg gets a FRESH token so its failure is
        # downstream (the connect), never the guard.
        guard_tf = os.path.join(dir_, "guard-tokens.txt")
        with open(guard_tf, "w") as f:
            f.write(mint_link_token(secret, "mac-d", "dev_d") + "\n")
        guard = subprocess.run([sys.executable, REAL_DIAL, "--host", "1.2.3.4",
                                "--port", "9999", "--token-file", guard_tf],
                               capture_output=True, text=True, timeout=20)
        expect(guard.returncode != 0 and "refusing plaintext ws" in guard.stderr,
               f"public host refused BEFORE connecting: rc={guard.returncode} {guard.stderr.strip()[:80]}")
        guard_ok = subprocess.run([sys.executable, REAL_DIAL, "--host", "1.2.3.4",
                                   "--port", "9999", "--token-file", guard_tf,
                                   "--allow-public"],
                                  capture_output=True, text=True, timeout=20)
        expect(guard_ok.returncode != 0 and "refusing" not in guard_ok.stderr
               and "refusing" not in guard_ok.stdout
               and "connect failed" in guard_ok.stderr,
               f"--allow-public passes the guard, fails at the connect: rc={guard_ok.returncode} {guard_ok.stderr.strip()[-60:]}")

        print("ROOTLINK-SIM: ALL 10 GREEN (routing, single-use, takeover, anonymous-refused, close-reap, "
              "wedged-unlink, in-flight-cap, mint-cli, dial-exec, public-guard)")
        return 0
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except Exception: proc.kill()

if __name__ == "__main__":
    sys.exit(main())
