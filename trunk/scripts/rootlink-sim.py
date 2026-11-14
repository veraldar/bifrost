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
               unless --allow-plaintext; --tls (wss) always passes the
               guard (probe never connects on refusal)
  T11 brain    root-dial --brain: turns run on the root's own brain (a fake
               brain HTTP server here) — ONE session per device, created on
               first use (`trunk · <dev>`), reused after; health pongs are
               earned by GET <brain>/root
  T12 switch   http frames through the switchboard: hub→root (/_root/<id>/
               on the bridge, loopback only), root→hub (`local`, via the
               dialer's --peer-port), root→root; only content-type +
               x-ygg-peer cross; status + bodies (300 KB) byte-exact;
               GET /_roots lists the linked roots (loopback, no browser)
  T13 claim    a root whose link-token roots claim excludes the target is
               refused 403 (`*` admits any; `local` always allowed)
  T14 edge     the root-link THROUGH the access point: ap (self-signed test
               cert) ◀ box bridge dials out; root-dial --tls --cafile
               --path /rootlink links, serves a turn and a switchboard call;
               without the test CA the TLS dial is refused
  (T12–T14 run the OLD plaintext switchboard: this bridge opts in with
   [bridge.root-link] plaintext_http = true, as a hub with old roots would)
  T15 wg-relay the root <-> root leg's relay (trunk/src/wg.rs): binary root-link
               frames are WireGuard relay frames [n][addr][datagram]; root→root
               is forwarded with the source REWRITTEN to the sending link's id
               (a root cannot pose as another), under the link-token claim law;
               `local` ↔ the hub's node over loopback UDP (wg_relay/wg_local),
               only from the configured node; anything that is not a
               WireGuard-shaped message is dropped, never relayed

LAW: the health probe is AGENT-level — root-dial must EXEC the agent
to earn each root.pong; a dial script that pongs without exec is a
LIE the trunk would believe.
"""
import base64, hashlib, hmac, json, os, queue, shutil, socket, struct, subprocess, sys, tempfile, time
import http.client, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIN = os.path.join(os.path.dirname(__file__), "..", "target", "release", "bifrost-net")
HTTP_PORT = int(os.environ.get("SIM_HTTP_PORT", "8471"))
WS_PORT = HTTP_PORT + 1
RESULT_WAIT = 20  # registry.rs law

def b64url(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def free_port():
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]

def mint_link_token(secret, root, dev, roots=None):
    payload = json.dumps({"v": 1, "root": root, "roots": roots or [root], "dev": dev,
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

    def send_binary(self, payload):
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        n = len(payload)
        hdr = bytes([0x82]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
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
            if opcode == 0x2:                            # a WireGuard relay frame
                getattr(self, "binq", queue.Queue()).put(payload)
                continue
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

class FakeBrain:
    """A tiny brain HTTP API (the yggdrasil/opencode surface root-dial uses):
    GET /root · GET|POST /session · GET|POST /session/<id>/message ·
    POST /tree/report · ANY /echo… (echoes method, path, headers, body).
    Its responses carry x-ygg-peer AND x-leak — only the first may cross."""
    def __init__(self, name):
        self.name, self.sessions, self.reports, self.root_hits = name, {}, [], 0
        self.lock = threading.Lock()
        brain = self
        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *a): pass
            def reply(self, st, obj, raw=None):
                b = raw if raw is not None else json.dumps(obj).encode()
                self.send_response(st)
                self.send_header("content-type", "application/json")
                self.send_header("x-ygg-peer", f"from-{brain.name}")
                self.send_header("x-leak", "must-not-cross")
                self.send_header("content-length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
            def any(self):
                n = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(n) if n else b""
                p = self.path.split("?")[0].rstrip("/") or "/"
                parts = p.strip("/").split("/")
                with brain.lock:
                    if p.startswith("/echo"):
                        return self.reply(200, {"brain": brain.name, "method": self.command, "path": self.path,
                                                "headers": {k.lower(): v for k, v in self.headers.items()},
                                                "body": body.decode(errors="replace")})
                    if self.command == "GET" and p == "/root":
                        brain.root_hits += 1
                        return self.reply(200, {"name": brain.name})
                    if p == "/session" and self.command == "GET":
                        return self.reply(200, [{"id": k, "title": v["title"]} for k, v in brain.sessions.items()])
                    if p == "/session" and self.command == "POST":
                        sid = f"{brain.name}-s{len(brain.sessions) + 1}"
                        brain.sessions[sid] = {"title": json.loads(body or b"{}").get("title"), "messages": []}
                        return self.reply(200, {"id": sid, "title": brain.sessions[sid]["title"]})
                    if len(parts) == 3 and parts[0] == "session" and parts[2] == "message" and parts[1] in brain.sessions:
                        s = brain.sessions[parts[1]]
                        if self.command == "GET":
                            return self.reply(200, s["messages"])
                        text = "".join(x.get("text", "") for x in json.loads(body).get("parts", []))
                        s["messages"].append(text)
                        return self.reply(200, {"info": {"role": "assistant"},
                                                "parts": [{"type": "text", "text": f"{brain.name} heard: {text}"}]})
                    if p == "/tree/report" and self.command == "POST":
                        brain.reports.append((self.headers.get("x-ygg-peer"), json.loads(body or b"null")))
                        return self.reply(200, True)
                return self.reply(404, {"error": f"no route {self.command} {p}"})
            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = any
        class Srv(ThreadingHTTPServer):
            daemon_threads = True
        self.srv = Srv(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

class Dial:
    """root-dial.py with any flags; `linked:` lines are collected."""
    def __init__(self, args):
        self.proc = subprocess.Popen([sys.executable, REAL_DIAL] + args, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1)
        self.links, self.out = [], []
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for line in self.proc.stdout:
            self.out.append(line.strip())
            if line.startswith("linked:"):
                self.links.append(line.strip())

    def wait_link(self, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            if self.links:
                return self.links[0]
            if self.proc.poll() is not None:
                raise RuntimeError(f"dial died before linking: rc={self.proc.returncode} {self.proc.stderr.read()[-300:]}")
            time.sleep(0.05)
        raise RuntimeError(f"dial never linked: {self.out[-5:]}")

    def close(self):
        try: self.proc.kill()
        except Exception: pass

def http_call(port, method, path, body=b"", headers=None, timeout=30):
    """(status, response headers lowercased, body bytes)"""
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    c.request(method, path, body=body or None, headers=headers or {})
    r = c.getresponse()
    out = r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
    c.close()
    return out

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
    # T11-T14 fixtures: the hub's own brain (`local`) + the access point the
    # box dials out to (self-signed test cert — the VPS uses its real one)
    hub = FakeBrain("H")
    # T15 fixture: the hub's own WireGuard node, played by a bare UDP socket
    hub_node = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    hub_node.bind(("127.0.0.1", 0))
    hub_node.settimeout(3)
    wg_relay_port = free_port()
    ap_port = free_port()
    certout = subprocess.run([BIN, "ap-cert", os.path.join(dir_, "tls"), "localhost", "127.0.0.1"],
                             capture_output=True, text=True).stdout
    pin = [l.split('"')[1] for l in certout.splitlines() if l.startswith("pin =")][0]
    tokout = subprocess.run([BIN, "ap-token"], capture_output=True, text=True).stdout
    ap_tok = [l.split('"')[1] for l in tokout.splitlines() if l.startswith("token =")][0]
    ap_hash = [l.split('"')[1] for l in tokout.splitlines() if l.startswith("bridge_token_sha256 =")][0]
    with open(os.path.join(dir_, "ap.toml"), "w") as f:
        f.write(f'[ap]\nlisten = "127.0.0.1:{ap_port}"\ncert_path = "{dir_}/tls/cert.pem"\n'
                f'key_path = "{dir_}/tls/key.pem"\nbridge_token_sha256 = "{ap_hash}"\n')
    ap_log = open(os.path.join(dir_, "ap.log"), "w")
    ap_proc = subprocess.Popen([BIN, "ap", "-c", os.path.join(dir_, "ap.toml")], stdout=ap_log, stderr=subprocess.STDOUT)
    cfg = f'''
[node]
name = "sim-trunk"
private_key = "{priv}"

[bridge]
http = "127.0.0.1:{HTTP_PORT}"
media = "127.0.0.1:{HTTP_PORT + 100}"
tokens_file = "{dir_}/devices.json"
root_link_secret = "{secret.decode()}"
opencode_url = "{hub.url}"

[bridge.root-link]
enabled = true
ping_secs = 3
max_inflight = 1
plaintext_http = true
wg_relay = "127.0.0.1:{wg_relay_port}"
wg_local = "127.0.0.1:{hub_node.getsockname()[1]}"

[ap]
url = "wss://127.0.0.1:{ap_port}/ap"
pin = "{pin}"
token = "{ap_tok}"
upstream = "127.0.0.1:{hub.srv.server_address[1]}"
'''
    with open(os.path.join(dir_, "sim.toml"), "w") as f: f.write(cfg)
    log = open(os.path.join(dir_, "bridge.log"), "w")
    proc = subprocess.Popen([BIN, "bridge", "-c", os.path.join(dir_, "sim.toml")],
                            stdout=log, stderr=subprocess.STDOUT)
    dials = []

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
        # --allow-plaintext and --tls legs get a FRESH token so their failure
        # is downstream (the connect), never the guard.
        guard_tf = os.path.join(dir_, "guard-tokens.txt")
        with open(guard_tf, "w") as f:
            f.write(mint_link_token(secret, "mac-d", "dev_d") + "\n")
        guard = subprocess.run([sys.executable, REAL_DIAL, "--host", "1.2.3.4",
                                "--port", "9999", "--token-file", guard_tf],
                               capture_output=True, text=True, timeout=20)
        expect(guard.returncode != 0 and "refusing plaintext ws" in guard.stderr,
               f"public host refused BEFORE connecting: rc={guard.returncode} {guard.stderr.strip()[:80]}")
        for flag in ("--allow-plaintext", "--tls"):
            with open(guard_tf, "w") as f:
                f.write(mint_link_token(secret, "mac-d", "dev_d") + "\n")
            guard_ok = subprocess.run([sys.executable, REAL_DIAL, "--host", "1.2.3.4",
                                       "--port", "9999", "--token-file", guard_tf, flag],
                                      capture_output=True, text=True, timeout=20)
            expect(guard_ok.returncode != 0 and "refusing" not in guard_ok.stderr
                   and "refusing" not in guard_ok.stdout
                   and "connect failed" in guard_ok.stderr,
                   f"{flag} passes the guard, fails at the connect: rc={guard_ok.returncode} {guard_ok.stderr.strip()[-60:]}")

        # ---- T11: turns on the root's OWN brain — one session per device ----
        raw_e1, raw_e2, raw_g = ("bfnd-" + b64url(os.urandom(18)) for _ in range(3))
        for did, raw, roots in (("dev_e1", raw_e1, ["mac-e", "mac-f"]), ("dev_e2", raw_e2, ["mac-e"]),
                                ("dev_g", raw_g, ["mac-g"])):
            devices.append({"id": did, "name": did, "tokenHash": hashlib.sha256(raw.encode()).hexdigest(),
                            "created": "now", "revoked": False, "roots": roots})
        with open(os.path.join(dir_, "devices.json"), "w") as f:
            json.dump({"devices": devices}, f)
        brain_e, brain_f = FakeBrain("E"), FakeBrain("F")
        pe, pf = free_port(), free_port()
        tf_e, tf_f = os.path.join(dir_, "tok-e.txt"), os.path.join(dir_, "tok-f.txt")
        with open(tf_e, "w") as f:   # mac-e may address ANY root (`*`)
            f.write(mint_link_token(secret, "mac-e", "dev_e1", ["*"]) + "\n")
        with open(tf_f, "w") as f:   # mac-f may address only itself (+ local)
            f.write(mint_link_token(secret, "mac-f", "dev_e2") + "\n")
        de = Dial(["--host", "127.0.0.1", "--port", str(WS_PORT), "--token-file", tf_e,
                   "--brain", brain_e.url, "--peer-port", str(pe)])
        df = Dial(["--host", "127.0.0.1", "--port", str(WS_PORT), "--token-file", tf_f,
                   "--brain", brain_f.url, "--peer-port", str(pf)])
        dials += [de, df]
        expect("linked: mac-e" in de.wait_link() and "linked: mac-f" in df.wait_link(),
               "two --brain dialers linked (mac-e, mac-f)")
        st, o1 = branch({"op": "prompt", "id": "phone", "text": "e1-first", "root": "mac-e"}, raw_e1)
        expect(st == 200 and o1.get("text") == "E heard: e1-first" and o1.get("root") == "mac-e",
               f"turn ran on mac-e's brain, reply rode back: {st} {o1}")
        st, o2 = branch({"op": "prompt", "id": "phone", "text": "e1-second", "root": "mac-e"}, raw_e1)
        st3, o3 = branch({"op": "prompt", "id": "phone", "text": "e2-first", "root": "mac-e"}, raw_e2)
        titles = sorted(v["title"] for v in brain_e.sessions.values())
        expect(st == 200 and st3 == 200 and o2.get("session") == o1.get("session") != o3.get("session")
               and titles == ["trunk · dev_e1", "trunk · dev_e2"]
               and brain_e.sessions[o1["session"]]["messages"] == ["e1-first", "e1-second"]
               and brain_e.sessions[o3["session"]]["messages"] == ["e2-first"],
               f"one session per device, created on first use and reused: {titles}")
        st, o = branch({"op": "transcript", "id": "phone", "root": "mac-e"}, raw_e1)
        expect(st == 200 and o.get("messages") == ["e1-first", "e1-second"], f"transcript reads the device's session: {st}")
        time.sleep(4)   # ≥1 trunk probe (ping_secs 3)
        expect(brain_e.root_hits >= 1, f"health pongs earned by GET <brain>/root ({brain_e.root_hits} probe(s))")

        # ---- T12: the switchboard — hub→root, root→hub, root→root ----
        st, h, b = http_call(HTTP_PORT, "GET", "/_root/mac-e/root")
        expect(st == 200 and json.loads(b) == {"name": "E"}, f"hub→root: /_root/mac-e/root answered by E's brain: {st} {b[:80]}")
        st, h, b = http_call(HTTP_PORT, "POST", "/_root/mac-e/echo/x?q=1", b'{"k":1}',
                             {"content-type": "application/json", "x-ygg-peer": "peer-tok",
                              "authorization": "Bearer nope", "x-evil": "1", "cookie": "a=b"})
        e = json.loads(b)
        expect(st == 200 and e["method"] == "POST" and e["path"] == "/echo/x?q=1" and e["body"] == '{"k":1}'
               and e["headers"].get("x-ygg-peer") == "peer-tok" and e["headers"].get("content-type") == "application/json"
               and not {"authorization", "x-evil", "cookie"} & set(e["headers"]),
               "hub→root: method, path+query, body exact; only content-type + x-ygg-peer reached the brain")
        expect(h.get("x-ygg-peer") == "from-E" and "x-leak" not in h and h.get("content-type") == "application/json",
               f"…and only content-type + x-ygg-peer came back: {sorted(h)}")
        st, h, b = http_call(HTTP_PORT, "GET", "/_root/mac-e/nope")
        expect(st == 404 and b"no route" in b, f"the brain's own status passes through: {st}")
        st, h, b = http_call(HTTP_PORT, "GET", "/_root/mac-ghost/root")
        expect(st == 502 and b"not linked" in b, f"unlinked root = clean 502: {st} {b[:80]}")
        st, h, b = http_call(HTTP_PORT, "GET", "/_root/mac-e/root", headers={"origin": "https://evil.example"})
        expect(st == 403, f"/_root refuses browser requests (Origin): {st}")
        # the hub brain learns its peers: GET /_roots lists the linked roots (YGG_PEERS_FROM)
        st, h, b = http_call(HTTP_PORT, "GET", "/_roots")
        rl = json.loads(b) if st == 200 else []
        ids = [r.get("id") for r in rl]
        expect(st == 200 and h.get("content-type") == "application/json" and {"mac-e", "mac-f"} <= set(ids)
               and ids == sorted(ids) and all(isinstance(r.get("since"), int) and r["since"] <= time.time() * 1000 for r in rl),
               f"/_roots lists the linked roots [{{id, since}}]: {st} {b[:160]}")
        st, h, b = http_call(HTTP_PORT, "GET", "/_roots", headers={"sec-fetch-mode": "cors"})
        st2, h, b2 = http_call(HTTP_PORT, "GET", "/_roots", headers={"x-forwarded-for": "6.6.6.6"})
        st3, h, b3 = http_call(HTTP_PORT, "POST", "/_roots", b"{}")
        expect(st == 403 and st2 == 403 and st3 == 405, f"/_roots: browser 403, proxied 403, POST 405: {st} {st2} {st3}")
        st, h, b = http_call(pe, "GET", "/local/root")
        expect(st == 200 and json.loads(b) == {"name": "H"}, f"root→hub: mac-e's peer port reached the hub brain (local): {st} {b[:60]}")
        st, h, b = http_call(pe, "POST", "/local/tree/report", b'{"proxy":"p1","event":{"x":1}}',
                             {"content-type": "application/json", "x-ygg-peer": "peer-tok"})
        expect(st == 200 and hub.reports == [("peer-tok", {"proxy": "p1", "event": {"x": 1}})],
               f"root→hub: POST /tree/report arrived with its x-ygg-peer: {hub.reports}")
        big = ("0123456789abcdef" * 20000).encode()          # 320 KB, many TCP segments
        st, h, b = http_call(pe, "POST", "/mac-f/echo", big, {"content-type": "text/plain"})
        expect(st == 200 and json.loads(b)["brain"] == "F" and json.loads(b)["body"].encode() == big,
               "root→root: mac-e → mac-f, a 320 KB body crossed both links byte-exact")
        res = []
        ths = [threading.Thread(target=lambda i=i: res.append(http_call(HTTP_PORT, "GET", f"/_root/mac-{'ef'[i % 2]}/echo/{i}")))
               for i in range(8)]
        [t.start() for t in ths]; [t.join(30) for t in ths]
        expect(len(res) == 8 and all(r[0] == 200 and json.loads(r[2])["path"].startswith("/echo/") for r in res),
               "8 concurrent hub→root calls each got their own answer")

        # ---- T13: the link-token claim gates who may address whom ----
        st, h, b = http_call(pf, "GET", "/mac-e/root")
        expect(st == 403 and b"may not address root 'mac-e'" in b,
               f"mac-f (claim [mac-f]) → mac-e refused: {st} {b[:120]}")
        st, h, b = http_call(pf, "GET", "/local/root")
        expect(st == 200 and json.loads(b) == {"name": "H"}, "mac-f → local still allowed (the trunk's own brain)")
        st, h, b = http_call(pf, "GET", "/mac-f/root")
        expect(st == 400, f"a root cannot address itself through the trunk: {st}")

        # ---- T14: the root-link THROUGH the access point ----
        brain_g = FakeBrain("G")
        tf_g = os.path.join(dir_, "tok-g.txt")
        with open(tf_g, "w") as f:
            f.write(mint_link_token(secret, "mac-g", "dev_g") + "\n")
        bad = subprocess.run([sys.executable, REAL_DIAL, "--host", "localhost", "--port", str(ap_port), "--tls",
                              "--path", "/rootlink", "--token-file", tf_g, "--brain", brain_g.url],
                             capture_output=True, text=True, timeout=20)
        expect(bad.returncode != 0 and "connect failed" in bad.stderr and "CERTIFICATE_VERIFY_FAILED" in bad.stderr,
               f"without the test CA the TLS dial is refused: {bad.stderr.strip()[-90:]}")
        with open(tf_g, "w") as f:
            f.write(mint_link_token(secret, "mac-g", "dev_g") + "\n")
        dg = Dial(["--host", "localhost", "--port", str(ap_port), "--tls", "--cafile", f"{dir_}/tls/cert.pem",
                   "--path", "/rootlink", "--token-file", tf_g, "--brain", brain_g.url])
        dials.append(dg)
        expect("linked: mac-g" in dg.wait_link(20) and any(l.startswith("tls ok") for l in dg.out),
               f"root-dial linked THROUGH the ap edge (wss://localhost:{ap_port}/rootlink, verified TLS)")
        st, o = branch({"op": "prompt", "id": "phone", "text": "via-ap", "root": "mac-g"}, raw_g)
        expect(st == 200 and o.get("text") == "G heard: via-ap", f"a turn crossed the edge to mac-g's brain and back: {st} {o}")
        st, h, b = http_call(HTTP_PORT, "GET", "/_root/mac-g/root")
        expect(st == 200 and json.loads(b) == {"name": "G"}, "a switchboard call crossed the edge too")
        lg, la = open(os.path.join(dir_, "bridge.log")).read(), open(os.path.join(dir_, "ap.log")).read()
        expect("bridge registered from" in la and f"/rootlink → root-link 127.0.0.1:{WS_PORT}" in lg,
               "the box dialed OUT to the ap; the ap's /rootlink stream went to the box's loopback root-link listener")

        # ---- T15: the WireGuard relay — ciphertext by address, never read ----
        def fr(addr, d): return bytes([len(addr)]) + addr.encode() + d
        def unfr(b): n = b[0]; return b[1:1 + n].decode(), b[1 + n:]
        init = bytes([1, 0, 0, 0]) + os.urandom(144)        # handshake-init shaped
        data = bytes([4, 0, 0, 0]) + os.urandom(96)         # transport-data shaped
        class WgRoot(FakeRoot):
            def __init__(self, token):
                self.binq = queue.Queue()
                super().__init__(token)
                self.ws.binq = self.binq
            def got(self, timeout=3):
                try: return unfr(self.binq.get(timeout=timeout))
                except queue.Empty: return None
        rx_ = WgRoot(mint_link_token(secret, "mac-x", "dev_a", ["*"]))
        ry = WgRoot(mint_link_token(secret, "mac-y", "dev_a"))
        expect(rx_.ack.get("op") == "root-link.ok" and ry.ack.get("op") == "root-link.ok", "two roots linked for the relay (mac-x claim *, mac-y claim [mac-y])")
        rx_.ws.send_binary(fr("mac-y", data))
        expect(ry.got() == ("mac-x", data), "root→root: mac-x's datagram reached mac-y byte-exact, source = the sending LINK's id")
        ry.ws.send_binary(fr("mac-x", data))
        expect(rx_.got(1.5) is None, "mac-y (claim [mac-y]) → mac-x: dropped (link-token claim law)")
        rx_.ws.send_binary(fr("mac-y", b"GET /root HTTP/1.1\r\nhost: x\r\n\r\n"))
        rx_.ws.send_binary(fr("mac-y", b'{"op":"http","path":"/root"}'))
        rx_.ws.send_binary(b"\x07mac-y")                   # a frame with no datagram
        expect(ry.got(1.5) is None, "plaintext (HTTP, a JSON op, an empty frame) is never relayed — WireGuard-shaped only")
        ry.ws.send_binary(fr("local", init))
        try:
            got, frm = hub_node.recvfrom(65536)
        except socket.timeout:
            got, frm = b"", None
        expect(frm is not None and frm[1] == wg_relay_port and unfr(got) == ("mac-y", init),
               f"root→local: the hub's node got mac-y's handshake on loopback UDP from the bridge's relay socket {frm}")
        hub_node.sendto(fr("mac-y", data), ("127.0.0.1", wg_relay_port))
        expect(ry.got() == ("local", data), "local→root: the hub's node reached mac-y, source 'local'")
        stranger = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        stranger.sendto(fr("mac-y", data), ("127.0.0.1", wg_relay_port))
        stranger.close()
        expect(ry.got(1.5) is None, "UDP into the relay socket from anyone but the hub's node is dropped")
        rx_.close(); ry.close()
        lg = open(os.path.join(dir_, "bridge.log")).read()
        expect("wg-relay: dropped a frame from 'mac-y': claim does not name 'mac-x'" in lg
               and "not a WireGuard message" in lg, "the bridge logs what it refused to relay")

        print("ROOTLINK-SIM: ALL 15 GREEN (routing, single-use, takeover, anonymous-refused, close-reap, "
              "wedged-unlink, in-flight-cap, mint-cli, dial-exec, public-guard, brain-sessions, switchboard, "
              "claim-refusal, ap-edge, wg-relay)")
        shutil.rmtree(dir_, ignore_errors=True)   # green: no test keys/tokens left behind
        return 0
    finally:
        for d in dials:
            d.close()
        proc.terminate()
        ap_proc.terminate()
        for pr in (proc, ap_proc):
            try: pr.wait(timeout=5)
            except Exception: pr.kill()

if __name__ == "__main__":
    sys.exit(main())
