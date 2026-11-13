#!/usr/bin/env python3
"""root-dial.py — the ROOT-side dial-in client (stdlib only).

This is the program a root machine (e.g. a Mac Studio, anywhere on the
internet) runs to dial the trunk. The root machine opens NO inbound port:
it dials out, and everything — turns, health, brain-to-brain calls —
rides that one link. It proves the AGENT loop, not just a socket:

  HEALTH LAW (v4c, sim3 GAP-B fix): the trunk's `root.ping` op is a
  probe of the root's AGENT PROCESS, not of this dial script — so the
  `root.pong` is EARNED: with --brain, by `GET <brain>/root` answering
  200; else by a trivial exec of the agent binary (`<first token of
  --exec> --version`, own thread, never queued behind a long job). If
  the probe fails or times out, NO pong is sent and the trunk counts a
  probe failure (3 → auto-unlink). A bare pong would prove only the
  dial script.

  JOB LAW: `root.job` frames run in a WORKER THREAD — the read loop keeps
  answering probes during multi-minute runs. Replies ride
  `root.result{tid,ok,text}`.
    --brain URL  the job runs on this root's own brain (yggdrasil /
                 opencode HTTP API): ONE session per device (the job's
                 `dev`), titled `trunk · <dev>`, found or created on first
                 use and reused after; POST /session/<id>/message; the
                 reply text → root.result (as {"text","session","dev"}).
    --exec CMD   fallback when --brain is absent (default `opencode run`):
                 the turn text is appended, stdout is the reply.

  SWITCHBOARD LAW (brain-to-brain, via the trunk — trunk/src/switch.rs):
    {op:"http", id, to, method, path, headers, body_b64}  → the trunk
    {op:"http.reply", id, status, headers, body_b64}      ← the trunk
  --peer-port P   a LOCAL HTTP server on 127.0.0.1:P: `ANY /<target>/<rest>`
                  becomes an `http` frame to root <target> (`local` = the
                  hub's own brain) and its reply is the response. So this
                  root's brain peers with YGG_PEERS home=http://127.0.0.1:P/local.
  Incoming `http` frames (another brain calling THIS root) are performed
  against --brain and answered with `http.reply`. Only `content-type` and
  `x-ygg-peer` cross, either way; browser/proxied requests are refused.

  RECONNECT LAW: on ws close it reconnects with a FRESH token from
  --token-file (burn-as-read; single-use tokens never block a
  reconnect; takeover law makes the newest conn win).

  GUARD LAW: plaintext ws carries link tokens and turn text — dialing
  outside private ranges (RFC1918/CGNAT/ULA/loopback/link-local) is
  REFUSED unless --allow-plaintext is passed explicitly. TLS (--tls)
  always passes the guard: public wss is the SANCTIONED dial path.

  TLS LAW: --tls wraps the socket with client-side TLS BEFORE the ws
  handshake, SNI = --host. Verify against the system trust store, or a
  given CA bundle (--cafile: a test CA / self-signed cert — tests only),
  or skip verification with --insecure-skip (self-signed lab certs only).

Through an access point (no tailnet): --host <ap host> --port 443 --tls
--path /rootlink — the edge forwards that stream to the box's root-link
listener (bifrost-net bridge [ap] dial-out).
"""
import base64, ipaddress, json, os, queue, socket, ssl, struct, subprocess, sys, threading, time
import urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

PASS_HEADERS = ("content-type", "x-ygg-peer")   # the only headers that cross
HTTP_WAIT = 125                                 # the trunk 504s at 120 s
MAX_BODY = 4 << 20
# the brain is local: never through an environment proxy, never redirected away
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

USAGE = f"""usage: {os.path.basename(sys.argv[0])} --host HOST --port PORT --token-file FILE
       [--brain URL] [--peer-port P] [--exec "opencode run"] [--probe-exec CMD]
       [--tls] [--cafile PEM] [--insecure-skip] [--allow-plaintext] [--path /rootlink]

  --host/--port     trunk [bridge.root-link] listen address (default 127.0.0.1:8473),
                    or an access point (with --tls --path /rootlink)
  --path            ws resource path (default /; /rootlink through an access point)
  --token-file      one single-use link token per line (burn-as-read on each dial)
  --brain URL       run turns on this root's own brain (one session per device);
                    incoming switchboard calls are performed against it
  --peer-port P     local switchboard door on 127.0.0.1:P: ANY /<root>/<path>
                    reaches root <root> through the trunk (`local` = the hub brain)
  --exec            agent command run per root.job when --brain is absent
                    (the turn text is appended)
  --probe-exec      trivial agent exec that must SUCCEED to earn each root.pong
                    (default: GET <brain>/root with --brain, else
                    "<first token of --exec> --version"); a failed probe sends
                    NO pong — the trunk counts the failure
  --tls             wrap the socket in client TLS before the ws handshake
                    (SNI = --host; verified against the system trust store)
  --cafile PEM      with --tls: trust this CA bundle / self-signed cert instead
                    of the system store (tests and private CAs)
  --insecure-skip   with --tls: skip cert verification (self-signed lab certs
                    ONLY — never on the open internet)
  --allow-plaintext REQUIRED escape hatch to dial over PLAINTEXT ws (link
                    tokens + turn text ride the wire unencrypted). Private
                    ranges are always allowed without it: RFC1918, CGNAT
                    100.64/10, ULA fc00::/7, loopback, link-local."""

def private_host(host):
    """True iff EVERY resolved address of `host` is private/loopback/link-
    local/CGNAT — the only ranges plaintext root-link may ever touch."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    addrs = [ipaddress.ip_address(i[4][0]) for i in infos]
    return all(a.is_private or a.is_loopback or a.is_link_local
               or a in ipaddress.ip_network("100.64.0.0/10") for a in addrs)

def pass_headers(h):
    out = {}
    for k, v in (h or {}).items():
        k = str(k).lower()
        if k in PASS_HEADERS and isinstance(v, str) and len(v) < 1024 and not any(c in v for c in "\r\n\0"):
            out[k] = v
    return out

# ---- the root's own brain (yggdrasil / opencode HTTP API) ---------------------

class Brain:
    def __init__(self, url):
        self.url = url.rstrip("/")
        self.sessions = {}                  # dev → brain session id
        self.lock = threading.Lock()

    def request(self, method, path, body=b"", headers=None, timeout=HTTP_WAIT):
        """(status, pass-headers, body bytes) — HTTP errors are answers too."""
        req = urllib.request.Request(self.url + path, data=body if (body or method not in ("GET", "DELETE")) else None,
                                     method=method, headers=pass_headers(headers))
        try:
            with _OPENER.open(req, timeout=timeout) as r:
                return r.status, pass_headers(dict(r.headers)), r.read(MAX_BODY + 1)[:MAX_BODY]
        except urllib.error.HTTPError as e:
            return e.code, pass_headers(dict(e.headers or {})), e.read()[:MAX_BODY]

    def call(self, method, path, obj=None, timeout=HTTP_WAIT):
        body = json.dumps(obj).encode() if obj is not None else b""
        st, _, raw = self.request(method, path, body, {"content-type": "application/json"}, timeout)
        if st >= 300:
            raise RuntimeError(f"brain {method} {path}: {st} {raw[:200].decode(errors='replace')}")
        return json.loads(raw) if raw.strip() else None

    def healthy(self):
        try:
            st, _, _ = self.request("GET", "/root", timeout=5)
            return st == 200, None if st == 200 else f"GET /root answered {st}"
        except Exception as e:
            return False, repr(e)

    def session_for(self, dev):
        """ONE session per device: found by its title, else created; reused after."""
        title = f"trunk · {dev}"
        with self.lock:
            sid = self.sessions.get(dev)
            if sid:
                return sid
            for s in self.call("GET", "/session") or []:
                if s.get("title") == title and not s.get("archived"):
                    sid = s["id"]
                    break
            else:
                sid = self.call("POST", "/session", {"title": title})["id"]
            self.sessions[dev] = sid
            return sid

    def job(self, v):
        """One root.job on the brain → (ok, result text)."""
        kind, body = v.get("kind", "prompt"), v.get("body") or {}
        dev = str(body.get("dev") or "anon")
        try:
            if kind == "sessions":
                ss = self.call("GET", "/session") or []
                return True, json.dumps({"sessions": [{"id": s.get("id"), "title": s.get("title")} for s in ss]})
            if kind == "create":
                s = self.call("POST", "/session", {"title": str(body.get("name") or f"trunk · {dev}")})
                return True, json.dumps({"id": s.get("id"), "title": s.get("title")})
            sid = self.session_for(dev)
            if kind == "transcript":
                return True, json.dumps({"id": sid, "messages": self.call("GET", f"/session/{sid}/message")})
            if kind == "prompt":
                msg = self.call("POST", f"/session/{sid}/message",
                                {"parts": [{"type": "text", "text": str(body.get("text", ""))}]}, timeout=900)
                parts = (msg or {}).get("parts") or []
                reply = "".join(p.get("text", "") for p in parts if p.get("type") == "text")
                return True, json.dumps({"text": reply, "session": sid, "dev": dev})
            return False, f"job kind '{kind}' is not served by this root"
        except Exception as e:
            if kind != "sessions":
                with self.lock:
                    self.sessions.pop(dev, None)   # a vanished session is re-found next turn
            return False, str(e)

# ---- the switchboard: calls out (peer port) and calls in (http frames) -------

class Link:
    """The live ws to the trunk (None between reconnects) + calls waiting on it."""
    def __init__(self):
        self.send = None
        self.pending = {}
        self.lock = threading.Lock()
        self.seq = 0

    def attach(self, send):
        with self.lock:
            self.send = send

    def detach(self):
        with self.lock:
            self.send, dead, self.pending = None, self.pending, {}
        for q in dead.values():
            q.put((502, {"content-type": "application/json"}, b'{"error":"trunk link went down mid-call"}'))

    def call(self, to, method, path, headers, body):
        with self.lock:
            send = self.send
            if send is None:
                return 503, {"content-type": "application/json"}, b'{"error":"not linked to the trunk right now"}'
            self.seq += 1
            cid = f"d{self.seq}"
            q = self.pending[cid] = queue.Queue(1)
        try:
            send(json.dumps({"op": "http", "id": cid, "to": to, "method": method, "path": path,
                             "headers": pass_headers(headers), "body_b64": base64.b64encode(body).decode()}))
            return q.get(timeout=HTTP_WAIT)
        except queue.Empty:
            return 504, {"content-type": "application/json"}, b'{"error":"no answer through the trunk"}'
        except OSError as e:
            return 502, {"content-type": "application/json"}, json.dumps({"error": f"trunk link: {e}"}).encode()
        finally:
            with self.lock:
                self.pending.pop(cid, None)

    def on_reply(self, v):
        with self.lock:
            q = self.pending.pop(str(v.get("id")), None)
        if q is not None:
            try:
                body = base64.b64decode(v.get("body_b64") or "")
            except Exception:
                body = b""
            q.put((int(v.get("status") or 502), pass_headers(v.get("headers")), body))

def peer_server(port, link):
    """127.0.0.1:P — ANY /<target>/<rest> → an `http` frame to <target>."""
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *a): pass
        def answer(self, st, hdrs, body):
            self.send_response(st)
            for k, v in pass_headers(hdrs).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        def refuse(self, st, msg):
            self.answer(st, {"content-type": "application/json"}, json.dumps({"error": msg}).encode())
        def any(self):
            self.close_connection = True
            for k in self.headers.keys():
                k = k.lower()
                if k in ("origin", "forwarded", "x-forwarded-for", "x-real-ip") or k.startswith("sec-fetch-"):
                    return self.refuse(403, "the peer port serves this root's own brain only (no browsers, no proxies)")
            if self.headers.get("upgrade") or self.headers.get("transfer-encoding"):
                return self.refuse(400, "plain HTTP with a Content-Length only")
            tail = self.path[1:] if self.path.startswith("/") else ""
            cut = min([i for i in (tail.find("/"), tail.find("?")) if i >= 0], default=len(tail))
            target, rest = tail[:cut], tail[cut:]
            if not target:
                return self.refuse(404, "use /<root>/<path> (local = the hub's brain)")
            rest = rest if rest.startswith("/") else "/" + rest
            n = int(self.headers.get("content-length") or 0)
            if n > MAX_BODY:
                return self.refuse(413, "body too large for the switchboard")
            body = self.rfile.read(n) if n else b""
            self.answer(*link.call(target, self.command, rest, dict(self.headers), body))
        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = any
    class Srv(ThreadingHTTPServer):
        daemon_threads = True
    srv = Srv(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"peer port 127.0.0.1:{port} — /<root>/<path> rides the trunk (local = the hub brain)", flush=True)
    return srv

# ---- the dial loop ------------------------------------------------------------

def main():
    a = sys.argv[1:]
    def arg(n, d=None):
        return a[a.index(n) + 1] if n in a else d
    if "--help" in a or "-h" in a:
        print(USAGE)
        return
    host, port = arg("--host", "127.0.0.1"), int(arg("--port", "8473"))
    wpath = arg("--path", "/")          # ws resource path (/rootlink through an access point)
    tfile, default_exec = arg("--token-file"), arg("--exec", "opencode run")
    if not tfile:
        raise SystemExit("usage: root-dial.py --host HOST --port PORT --token-file FILE "
                         "[--brain URL] [--peer-port P] [--exec ...] [--tls] [--cafile PEM] "
                         "[--insecure-skip] [--allow-plaintext] [--path /rootlink]")
    use_tls = "--tls" in a
    insecure_skip = "--insecure-skip" in a
    cafile = arg("--cafile")
    allow_plaintext = "--allow-plaintext" in a
    if insecure_skip and not use_tls:
        raise SystemExit("--insecure-skip is meaningless without --tls")
    if cafile and not use_tls:
        raise SystemExit("--cafile is meaningless without --tls")
    if allow_plaintext and use_tls:
        print("note: --allow-plaintext ignored — --tls already encrypts", file=sys.stderr)

    if not use_tls and not allow_plaintext and not private_host(host):
        raise SystemExit(f"refusing plaintext ws to non-private host {host!r} "
                         f"(link tokens ride the wire) — use --tls, a private "
                         f"address, or pass --allow-plaintext")

    def fresh_token():
        with open(tfile) as f:
            toks = [l.strip() for l in f if l.strip()]
        if not toks:
            raise SystemExit("token file exhausted — mint more (rootlink mint)")
        token, rest = toks[0], toks[1:]
        with open(tfile, "w") as f:          # fresh-token law: burn-as-read
            f.write("\n".join(rest) + ("\n" if rest else ""))
        return token, len(rest)

    brain = Brain(arg("--brain")) if arg("--brain") else None
    exec_cmd = default_exec.split()
    probe_cmd = arg("--probe-exec")
    probe_cmd = probe_cmd.split() if probe_cmd else (None if brain else [exec_cmd[0], "--version"])
    link = Link()
    if arg("--peer-port"):
        peer_server(int(arg("--peer-port")), link)
    while True:                               # reconnect-on-close loop
        token, left = fresh_token()
        try:
            s = socket.create_connection((host, port), timeout=10)
            s.settimeout(None)          # READ LAW: block forever — the trunk's
                                        # heartbeat (ping_secs) keeps the path
                                        # alive; a fixed timeout kills the conn
                                        # mid-job during long runs
            if use_tls:
                if insecure_skip:
                    ctx = ssl._create_unverified_context()
                else:
                    ctx = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
                s = ctx.wrap_socket(s, server_hostname=host)   # SNI = --host
                print(f"tls ok: {s.version()} cipher={s.cipher()[0]}"
                      f"{' (UNVERIFIED)' if insecure_skip else ''}", flush=True)
        except OSError as e:
            raise SystemExit(f"connect failed: {e}")
        s.sendall((f"GET {wpath} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
                   f"Connection: Upgrade\r\nSec-WebSocket-Key: {b64u(os.urandom(16))}\r\n"
                   f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            c = s.recv(4096)
            if not c: raise SystemExit("trunk died mid-handshake")
            buf += c
        if b"101" not in buf.split(b"\r\n", 1)[0]:
            raise SystemExit(f"ws refused: {buf[:120]!r}")
        print(f"dial ok ({left} token(s) left in file)", flush=True)
        try: run_ws(s, token, exec_cmd, probe_cmd, brain, link, buf.split(b"\r\n\r\n", 1)[1])
        except (SystemExit, KeyboardInterrupt): raise
        except Exception as e:
            print(f"conn lost ({e!r}) — reconnecting with a fresh token", flush=True)
        finally:
            link.detach()
            s.close()
        time.sleep(1)

def run_ws(s, token, exec_cmd, probe_cmd, brain, link, leftover=b""):
    lock = threading.Lock()                   # one writer at a time on the wire
    def send_text(t):
        p = t.encode(); m = os.urandom(4)
        mk = _mask(p, m)
        n = len(p)
        h = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else
                             bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else
                             bytes([0x80 | 127]) + struct.pack(">Q", n))
        with lock:
            s.sendall(h + m + mk)
    def send_op(op, payload=b""):
        m = os.urandom(4)
        with lock:
            s.sendall(bytes([0x80 | op, 0x80 | len(payload)]) + m + _mask(payload, m))
    buf = leftover                             # leftover bytes across frames
    def raw(n):
        nonlocal buf
        while len(buf) < n:
            c = s.recv(65536)
            if not c: raise ConnectionError("EOF mid-frame")
            buf += c
        out, buf = buf[:n], buf[n:]
        return out
    def frame():
        h = raw(2)
        op, ln = h[0] & 0x0F, h[1] & 0x7F
        if ln == 126: ln = struct.unpack(">H", raw(2))[0]
        elif ln == 127: ln = struct.unpack(">Q", raw(8))[0]
        m = raw(4) if h[1] & 0x80 else b""
        p = raw(ln)
        if m:  # a masked frame on the server side is protocol error — unmask anyway
            p = _mask(p, m)
        return op, p

    send_text(json.dumps({"op": "root-link", "token": token}))
    op, p = frame()
    ack = json.loads(p) if op == 1 else None
    if not ack or ack.get("op") != "root-link.ok":
        raise SystemExit(f"link refused: {p[:160]!r}")
    print(f"linked: {ack.get('root')} gen_no={ack.get('gen_no')}", flush=True)
    link.attach(send_text)

    jobs, probes = queue.Queue(), queue.Queue()

    def job_worker():                          # JOB LAW: runs OFF the read loop
        while True:
            v = jobs.get()
            if v is None:
                return
            if brain is not None:
                ok, text = brain.job(v)
            else:
                body = v.get("body", {})
                try:
                    r = subprocess.run(exec_cmd + [str(body.get("text", ""))],
                                       capture_output=True, text=True, timeout=300)
                    ok, text = r.returncode == 0, r.stdout.strip() or r.stderr.strip()
                except Exception as e:
                    ok, text = False, str(e)
            try:
                send_text(json.dumps({"op": "root.result", "tid": v["tid"], "ok": ok, "text": text}))
            except OSError:
                return

    def probe_worker():                        # HEALTH LAW: the pong is EARNED
        while True:
            v = probes.get()
            if v is None:
                return
            err = None
            if probe_cmd is None:              # --brain: the brain itself answers
                earned, err = brain.healthy()
            else:
                try:
                    r = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=5)
                    earned = r.returncode == 0
                    if not earned:
                        err = f"exit {r.returncode}: {(r.stderr or r.stdout).strip()[:120]}"
                except Exception as e:
                    earned, err = False, repr(e)
            if earned:
                try:
                    send_text(json.dumps({"op": "root.pong"}))
                except OSError:
                    return
            else:
                print(f"probe failed ({err}) — no pong sent, trunk "
                      f"counts the failure", file=sys.stderr)

    calls_in = threading.Semaphore(16)
    def serve_call(v):                         # another brain calls THIS root's brain
        with calls_in:
            if brain is None:
                st, hdrs, body = 501, {"content-type": "application/json"}, b'{"error":"this root runs no --brain"}'
            else:
                try:
                    raw_body = base64.b64decode(v.get("body_b64") or "")
                    st, hdrs, body = brain.request(str(v.get("method") or "GET").upper(), str(v.get("path") or "/"),
                                                   raw_body, v.get("headers"))
                except Exception as e:
                    st, hdrs, body = 502, {"content-type": "application/json"}, json.dumps({"error": f"brain: {e}"}).encode()
            try:
                send_text(json.dumps({"op": "http.reply", "id": v.get("id"), "status": st,
                                      "headers": pass_headers(hdrs), "body_b64": base64.b64encode(body).decode()}))
            except OSError:
                pass

    threading.Thread(target=job_worker, daemon=True).start()
    threading.Thread(target=probe_worker, daemon=True).start()

    while True:                               # the agent loop: ALWAYS reading
        op, p = frame()
        if op == 0x9: send_op(0xA, p[:125])                     # ws ping → ws pong
        elif op == 0x8: raise ConnectionError("trunk sent CLOSE")
        elif op == 0xA: pass                                    # unsolicited pong
        elif op == 0x1:
            v = json.loads(p)
            o = v.get("op")
            if o == "root.ping":
                probes.put(v)                                  # earn the pong
            elif o == "root.job":
                jobs.put(v)                                    # never blocks this loop
            elif o == "http":
                threading.Thread(target=serve_call, args=(v,), daemon=True).start()
            elif o == "http.reply":
                link.on_reply(v)

def _mask(p, m):
    """XOR-mask p with the 4-byte key m (fast path for large bodies)."""
    if not p:
        return b""
    n = len(p)
    key = int.from_bytes((m * (n // 4 + 1))[:n], "big")
    return (int.from_bytes(p, "big") ^ key).to_bytes(n, "big")

if __name__ == "__main__":
    main()
