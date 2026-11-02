#!/usr/bin/env python3
"""rootlink-sim — loopback proof for the v4 root-link dial-in plane.

NO VPS, NO deploy. Spawns the release bridge with [bridge.root-link] ON,
dials two fake roots over raw-RFC6455 ws (stdlib only — no deps), and
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
"""
import base64, hashlib, hmac, json, os, socket, struct, subprocess, sys, tempfile, time
import http.client

BIN = os.path.join(os.path.dirname(__file__), "..", "target", "release", "bifrost-net")
HTTP_PORT, WS_PORT = 8471, 8472

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

def branch(body, token=None):
    c = http.client.HTTPConnection("127.0.0.1", HTTP_PORT, timeout=25)
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
    def run(): out["res"] = branch(body, token)
    import threading
    threading.Thread(target=run, daemon=True).start()
    return out

def wait_res(out, timeout=25):
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
        BIN = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "artifacts", "bifrost-net-v4"))
    BIN = os.path.abspath(BIN)
    dir_ = tempfile.mkdtemp(prefix="rootlink-sim-")
    raw_a, raw_b, raw_anon = ("bfnd-" + b64url(os.urandom(18)) for _ in range(3))
    tok_b2_seed = os.urandom(18)
    devices = [
        {"id": "dev_a", "name": "a", "tokenHash": hashlib.sha256(raw_a.encode()).hexdigest(), "created": "now", "revoked": False, "roots": ["mac-a", "mac-b"]},
        {"id": "dev_b", "name": "b", "tokenHash": hashlib.sha256(raw_b.encode()).hexdigest(), "created": "now", "revoked": False, "roots": ["mac-b"]},
        {"id": "dev_anon", "name": "anon", "tokenHash": hashlib.sha256(raw_anon.encode()).hexdigest(), "created": "now", "revoked": False, "roots": []},
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
'''
    with open(os.path.join(dir_, "sim.toml"), "w") as f: f.write(cfg)
    log = open(os.path.join(dir_, "bridge.log"), "w")
    proc = subprocess.Popen([BIN, "bridge", "-c", os.path.join(dir_, "sim.toml")],
                            stdout=log, stderr=subprocess.STDOUT)

    tok_a = mint_link_token(secret, "mac-a", "dev_a")
    tok_b = mint_link_token(secret, "mac-b", "dev_b")
    tok_b2 = mint_link_token(secret, "mac-b", "dev_b")

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
        a, b = Ws(WS_PORT), Ws(WS_PORT)
        a.send_text(json.dumps({"op": "root-link", "token": tok_a}))
        b.send_text(json.dumps({"op": "root-link", "token": tok_b}))
        ack_a, ack_b = json.loads(a.recv_msg()), json.loads(b.recv_msg())
        expect(ack_a.get("op") == "root-link.ok" and ack_a["root"] == "mac-a", f"root A linked {ack_a}")
        expect(ack_b.get("op") == "root-link.ok" and ack_b["root"] == "mac-b", f"root B linked {ack_b}")

        def turn(sock, root, text, token):
            h = branch_async({"op": "prompt", "id": "sess", "text": text, "root": root}, token)
            job = json.loads(sock.recv_msg())
            sock.send_text(json.dumps({"op": "root.result", "tid": job["tid"], "ok": True,
                                       "text": json.dumps({"echo": text})}))
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
        jt = json.loads(a.recv_msg())
        a.send_text(json.dumps({"op": "root.result", "tid": jt["tid"], "ok": True, "text": "{}"}))
        st, out = wait_res(h)
        expect(st == 200, "surviving conn still serves turns after a refused double-dial")

        # ---- T3: takeover — fresh token, same root id replaces the conn ----
        b2 = Ws(WS_PORT)
        b2.send_text(json.dumps({"op": "root-link", "token": tok_b2}))
        ack_b2 = json.loads(b2.recv_msg())
        expect(ack_b2.get("op") == "root-link.ok" and ack_b2["root"] == "mac-b", f"takeover dial linked {ack_b2.get('root')}")
        expect(b.recv_msg(timeout=6) is None, "OLD root-B conn killed by takeover")
        h = branch_async({"op": "prompt", "id": "s", "text": "post-takeover", "root": "mac-b"}, raw_a)
        job_b2 = json.loads(b2.recv_msg())
        b2.send_text(json.dumps({"op": "root.result", "tid": job_b2["tid"], "ok": True,
                                 "text": json.dumps({"echo": "post-takeover"})}))
        st, out = wait_res(h)
        expect(st == 200 and out.get("echo") == "post-takeover",
               "post-takeover turn rides the NEW conn")

        # ---- T4: anonymous + root=  REFUSED (allowlist law) ----
        st, out = branch({"op": "prompt", "id": "s", "text": "x", "root": "mac-a"}, raw_anon)
        expect(st == 403 and "not allowed" in out.get("err", ""), f"anonymous device naming a root: {st} {out.get('err')}")
        st, out = branch({"op": "prompt", "id": "s", "text": "x", "root": "mac-a"})
        expect(st == 401, f"missing device token: {st}")
        st, out = branch({"op": "prompt", "id": "s", "text": "x", "root": "mac-b"}, raw_b)
        # unknown root id: dev_a's claim does NOT cover mac-ghost → 403
        # (allowlist is checked FIRST — refusals never leak which ids exist;
        # an id inside the claim but never dialed is what 404s "not linked",
        # as T5 proves after the close-reap)
        st, out = branch({"op": "prompt", "id": "s", "text": "x", "root": "mac-ghost"}, raw_a)
        expect(st == 403 and "not allowed" in out.get("err", ""),
               f"root outside the claim = 403, never a registry probe: {st} {out.get('err')}")

        # ---- T5: close = reap ----
        a.s.close()
        time.sleep(0.8)
        st, out = branch({"op": "transcript", "id": "s", "root": "mac-a"}, raw_a)
        expect(st == 404 and out.get("err") == "root not linked", f"closed root reaped: {st} {out.get('err')}")

        print("ROOTLINK-SIM: ALL 5 GREEN (routing, single-use, takeover, anonymous-refused, close-reap)")
        return 0
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except Exception: proc.kill()

if __name__ == "__main__":
    sys.exit(main())
