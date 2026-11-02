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
"""
import base64, hashlib, hmac, json, os, queue, socket, struct, subprocess, sys, tempfile, time
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

        print("ROOTLINK-SIM: ALL 8 GREEN (routing, single-use, takeover, anonymous-refused, close-reap, "
              "wedged-unlink, in-flight-cap, mint-cli)")
        return 0
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except Exception: proc.kill()

if __name__ == "__main__":
    sys.exit(main())
