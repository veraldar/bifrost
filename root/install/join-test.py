#!/usr/bin/env python3
"""join-test.py — join.sh end to end against a FAKE hub + a FAKE trunk (stdlib only).

The fake hub speaks the join contract over HTTPS with its own test CA (join.sh --cacert):
  POST /api/roots/join · GET <poll_url> (x-join-secret) · POST /api/roots/<id>/tokens (x-root-secret)
It learns the machine's WireGuard key (wg_pub) and grants the tunnel (`wg`: its key + addresses), so
join.sh writes and runs this root's `bifrost-net wg` node; and it serves a fake GitHub release
(/releases/latest/download/SHA256SUMS + bifrost-net-<ver>-linux-x86_64) for the download path.
and serves the trunk's root link on wss://localhost:<port>/rootlink: it checks the single-use link
token, answers root-link.ok, sends root.ping and waits for root.pong — which the REAL root-dial.py only
sends after its probe exec reached this root's brain. So a recorded pong = brain up + dialer linked.

  join-test.py --brain-bin PATH [--keep]      (needs: bash, python3, openssl, zbarimg; qrencode optional)

Nothing outside a fresh temp dir is touched: every join.sh run gets its own HOME; the systemd and
launchd paths run against recording shims of systemctl/loginctl/launchctl (never the real managers);
the live runs use the nohup supervisor on random loopback ports and are stopped at the end.
"""
import base64, collections, hashlib, http.server, json, os, plistlib, random, re, secrets, shutil, signal, socket
import ssl, stat, subprocess, sys, tempfile, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
JOIN = os.path.join(HERE, "join.sh")
HELPER = os.path.join(HERE, "rootjoin.py")
KEY = "sk-test-NEVER-PRINT-4242"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", name, ("  — " + detail) if detail and not ok else ""), flush=True)
    return ok


def wait_for(pred, secs, step=0.2):
    end = time.time() + secs
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    return pred()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


# ------------------------------------------------------------------------------------ fake hub
class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.joins = collections.OrderedDict()   # req -> dict
        self.roots = {}                           # root_id -> {secret, issued, used}
        self.counts = collections.Counter()
        self.links = []                           # {root, token, path, pong}
        self.auto = None                          # None | "approve" | "refuse"
        self.ttl = 120
        self.approve_tokens = 4
        self.refill_tokens = 8
        self.refill_status = 200
        self.hub_name = "home-box"                # the hub brain's root name, sent as `hub` (None = not sent)
        self.wg = True                            # grant the WireGuard tunnel to a join that sent a key
        self.wg_pub = base64.b64encode(os.urandom(32)).decode()   # the hub node's public key
        self.wg_ips = 1
        self.release = {}                         # the fake GitHub release: asset name -> bytes
        self.base = ""
        self.stopping = False

    def mint(self, n):
        return ["lt_%s" % secrets.token_urlsafe(18) for _ in range(n)]

    def last_req(self):
        with self.lock:
            return next(reversed(self.joins)) if self.joins else None

    def approve(self, req, hub_name=...):
        with self.lock:
            j = self.joins[req]
            root_id = "%s-%d" % (j["name"], len(self.roots) + 1)
            toks = self.mint(self.approve_tokens)
            self.roots[root_id] = {"secret": secrets.token_hex(16), "issued": set(toks), "used": set()}
            j.update(status="approved", root_id=root_id, tokens=toks, peer_token=secrets.token_hex(12),
                     hub=self.hub_name if hub_name is ... else hub_name)
            if j.get("wg_pub") and self.wg:
                self.wg_ips += 1
                j["wg"] = {"public_key": self.wg_pub, "hub_ip": "10.99.5.1", "ip": "10.99.5.%d" % self.wg_ips,
                           "net": "10.99.5.0/24"}
            return root_id

    def refuse(self, req):
        with self.lock:
            self.joins[req]["status"] = "refused"


def make_handler(hub):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def reply(self, code, obj):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def body(self):
            n = int(self.headers.get("content-length") or 0)
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return None

        def do_POST(self):
            if self.path == "/api/roots/join":
                b = self.body()
                if not isinstance(b, dict) or not all(isinstance(b.get(k), str) and b.get(k) for k in ("name", "os", "host")):
                    return self.reply(400, {"error": "name, os, host required"})
                wg_pub = b.get("wg_pub")
                if wg_pub is not None and not (isinstance(wg_pub, str) and re.match(r"^[A-Za-z0-9+/]{43}=$", wg_pub)
                                               and len(base64.b64decode(wg_pub)) == 32):
                    return self.reply(400, {"error": "wg_pub must be a base64 WireGuard public key"})
                with hub.lock:
                    hub.counts["join"] += 1
                    req = "jr%d" % (len(hub.joins) + 1)
                    j = {"secret": secrets.token_hex(16), "code": "%06d" % random.randrange(10 ** 6), "status": "pending",
                         "name": b["name"], "os": b["os"], "host": b["host"], "deadline": time.time() + hub.ttl,
                         "delivered": False, "wg_pub": wg_pub}
                    hub.joins[req] = j
                if hub.auto == "approve":
                    hub.approve(req)
                elif hub.auto == "refuse":
                    hub.refuse(req)
                return self.reply(201, {"req": req, "secret": j["secret"], "code": j["code"],
                                        "approve_url": "%s/join/%s" % (hub.base, req),
                                        "poll_url": "/api/roots/join/%s" % req,     # relative on purpose
                                        "expires_in": hub.ttl})
            m = re.match(r"^/api/roots/([^/]+)/tokens$", self.path)
            if m:
                self.body()
                with hub.lock:
                    hub.counts["refill"] += 1
                    r = hub.roots.get(m.group(1))
                    if not r or self.headers.get("x-root-secret") != r["secret"]:
                        return self.reply(401, {"error": "root secret"})
                    if hub.refill_status != 200:
                        return self.reply(hub.refill_status, {"error": "test: refill down"})
                    toks = hub.mint(hub.refill_tokens)
                    r["issued"].update(toks)
                return self.reply(200, {"link_tokens": toks})
            self.reply(404, {"error": "no route"})

        def do_GET(self):
            if self.path.startswith("/rootlink"):
                return self.rootlink()
            if self.path.startswith("/releases/latest/download/"):
                name = self.path.rsplit("/", 1)[1]
                with hub.lock:
                    hub.counts["release"] += 1
                    data = hub.release.get(name)
                if data is None:
                    return self.reply(404, {"error": "no asset"})
                self.send_response(200)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            m = re.match(r"^/api/roots/join/([^/?]+)$", self.path)
            if not m:
                return self.reply(404, {"error": "no route"})
            with hub.lock:
                hub.counts["poll"] += 1
                j = hub.joins.get(m.group(1))
                if not j:
                    return self.reply(404, {"error": "unknown request"})
                if self.headers.get("x-join-secret") != j["secret"]:
                    return self.reply(401, {"error": "join secret"})
                if j["status"] == "refused":
                    return self.reply(410, {"status": "refused"})
                if j["status"] == "approved" and not j["delivered"]:
                    j["delivered"] = True
                    r = hub.roots[j["root_id"]]
                    ans = {"status": "approved", "root_id": j["root_id"], "root_secret": r["secret"],
                           "link_tokens": j["tokens"], "peer_token": j["peer_token"],
                           "rootlink_url": hub.base.replace("https://", "wss://") + "/rootlink"}
                    if j["hub"] is not None:
                        ans["hub"] = j["hub"]
                    if j.get("wg"):
                        ans["wg"] = j["wg"]
                    return self.reply(200, ans)
                if time.time() > j["deadline"] or j["delivered"]:
                    return self.reply(410, {"status": "expired"})
                return self.reply(202, {"status": "pending"})

        # ---- the trunk's root link (RFC 6455, server side)
        def rootlink(self):
            if self.headers.get("upgrade", "").lower() != "websocket":
                return self.reply(400, {"error": "websocket only"})
            acc = base64.b64encode(hashlib.sha1((self.headers["sec-websocket-key"] + WS_GUID).encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", acc)
            self.end_headers()
            self.wfile.flush()
            self.close_connection = True
            self.connection.settimeout(1.0)
            ev = {"root": None, "token": None, "path": self.path, "pong": False, "refused": False}
            try:
                op, p = self.frame(30)
                msg = json.loads(p)
                tok = msg.get("token")
                with hub.lock:
                    rid = next((r for r, v in hub.roots.items() if tok in v["issued"] and tok not in v["used"]), None)
                    if rid:
                        hub.roots[rid]["used"].add(tok)
                    ev.update(root=rid, token=tok, refused=rid is None)
                    hub.links.append(ev)
                if not rid:
                    self.send_text({"op": "root-link.err", "error": "bad or used token"})
                    return
                self.send_text({"op": "root-link.ok", "root": rid, "gen_no": len(hub.links)})
                self.send_text({"op": "root.ping"})
                end = time.time() + 30
                while time.time() < end and not hub.stopping:
                    op, p = self.frame(end - time.time())
                    if op == 1 and json.loads(p).get("op") == "root.pong":
                        ev["pong"] = True
                        break
                while True:                              # hold the link like the trunk does
                    op, _ = self.frame(10 ** 6)
                    if op == 8:
                        return
            except (OSError, ValueError, ConnectionError):
                return

        def raw(self, n, deadline):
            out = b""
            while len(out) < n:
                if time.time() > deadline:
                    raise socket.timeout()
                if hub.stopping:
                    raise ConnectionError("hub stopping")
                try:                      # the raw socket: a socket FILE is dead after one timeout
                    c = self.connection.recv(n - len(out))
                except socket.timeout:
                    continue
                if not c:
                    raise ConnectionError("eof")
                out += c
            return out

        def frame(self, secs):
            d = time.time() + secs
            h = self.raw(2, d)
            ln = h[1] & 0x7F
            if ln == 126:
                ln = int.from_bytes(self.raw(2, d), "big")
            elif ln == 127:
                ln = int.from_bytes(self.raw(8, d), "big")
            mk = self.raw(4, d) if h[1] & 0x80 else b""
            p = self.raw(ln, d)
            if mk:
                p = bytes(b ^ mk[i % 4] for i, b in enumerate(p))
            return h[0] & 0x0F, p

        def send_text(self, obj):
            p = json.dumps(obj).encode()
            hdr = bytes([0x81, len(p)]) if len(p) < 126 else bytes([0x81, 126]) + len(p).to_bytes(2, "big")
            self.connection.sendall(hdr + p)
    return H


def start_hub(tmp):
    ca_key, ca, key, crt = (os.path.join(tmp, n) for n in ("ca.key", "ca.pem", "srv.key", "srv.pem"))
    ext = os.path.join(tmp, "ext.cnf")
    with open(ext, "w") as f:
        f.write("basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n"
                "subjectAltName=DNS:localhost,IP:127.0.0.1\nauthorityKeyIdentifier=keyid\nsubjectKeyIdentifier=hash\n")
    q = dict(check=True, capture_output=True)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                    "-keyout", ca_key, "-out", ca, "-days", "2", "-subj", "/CN=join-test-ca",
                    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], **q)
    csr = os.path.join(tmp, "srv.csr")
    subprocess.run(["openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                    "-keyout", key, "-out", csr, "-subj", "/CN=localhost"], **q)
    subprocess.run(["openssl", "x509", "-req", "-in", csr, "-CA", ca, "-CAkey", ca_key, "-CAcreateserial",
                    "-CAserial", os.path.join(tmp, "ca.srl"), "-out", crt, "-days", "2", "-extfile", ext], **q)
    hub = Hub()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), make_handler(hub))
    srv.daemon_threads = True
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    hub.base = "https://localhost:%d" % srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return hub, srv, ca


# ------------------------------------------------------------------------------------ helpers
class Env:
    def __init__(self, tmp, name, brain_bin, cacert, hub):
        self.name = name
        self.home = os.path.join(tmp, name, "home")
        self.dir = os.path.join(self.home, ".local", "share", "yggdrasil-root")
        os.makedirs(self.home)
        self.brain_port, self.peer_port = free_port(), free_port()
        self.up = os.path.join(tmp, name, "upstream.env")
        with open(self.up, "w") as f:
            f.write("# test upstream\nYGG_UPSTREAM_BASE_URL=http://127.0.0.1:9/v1\nexport YGG_UPSTREAM_API_KEY=\"%s\"\n"
                    "YGG_UPSTREAM_MODEL=test-model\n" % KEY)
        self.brain_bin, self.cacert, self.hub = brain_bin, cacert, hub
        self.shim = None
        self.log = os.path.join(tmp, name, "out.log")
        self.procs = []

    def env(self, **extra):
        e = {k: v for k, v in os.environ.items() if not k.startswith("YGG_") and k not in ("XDG_CONFIG_HOME", "XDG_DATA_HOME")}
        e.update(HOME=self.home, JOIN_POLL_SECS="0.3", JOIN_BRAIN_WAIT="40")
        if self.shim:
            e["PATH"] = self.shim + os.pathsep + e["PATH"]
        e.update(extra)
        return e

    def first_args(self, sup="nohup"):
        return ["--hub", self.hub.base, "--name", self.name, "--upstream-env", self.up, "--cacert", self.cacert,
                "--brain-bin", self.brain_bin, "--supervisor", sup, "--brain-port", str(self.brain_port),
                "--peer-port", str(self.peer_port)]

    def popen(self, args, **extra):
        f = open(self.log, "a")
        f.write("\n$ join.sh %s\n" % " ".join(args))
        f.flush()
        p = subprocess.Popen(["bash", JOIN] + args, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             env=self.env(**extra), start_new_session=True)
        self.procs.append(p)
        return p

    def run(self, args, timeout=120, **extra):
        p = self.popen(args, **extra)
        try:
            rc = p.wait(timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            rc = "timeout"
        return rc

    def out(self):
        with open(self.log) as f:
            return f.read()

    def tokens(self):
        with open(os.path.join(self.dir, "link-tokens")) as f:
            return [l.strip() for l in f if l.strip()]

    def root(self):
        with open(os.path.join(self.dir, "root.json")) as f:
            return json.load(f)

    def sup_pid(self):
        try:
            p = int(open(os.path.join(self.dir, "run", "supervise.pid")).read())
            os.kill(p, 0)
            return p
        except (OSError, ValueError):
            return None

    def make_shims(self):
        self.shim = os.path.join(os.path.dirname(self.home), "shim")
        os.makedirs(self.shim)
        rec = os.path.join(self.shim, "calls.log")
        for tool, body in (("systemctl", 'case "$*" in "--user show-environment") exit 0;; esac'),
                           ("loginctl", 'case "$*" in *show-user*) echo no;; esac'),
                           ("launchctl", 'case "$1" in print) [ -f "%s/loaded.$2" ] || exit 113;; bootstrap) : >"%s/loaded.gui-$(basename "$3")";; esac'
                            % (self.shim, self.shim))):
            p = os.path.join(self.shim, tool)
            with open(p, "w") as f:
                f.write('#!/bin/sh\nprintf "%%s\\n" "%s $*" >> "%s"\n%s\nexit 0\n' % (tool, rec, body))
            os.chmod(p, 0o755)
        return rec


def decode_png(path):
    r = subprocess.run(["zbarimg", "-q", "--raw", path], capture_output=True, text=True)
    return r.stdout.strip()


def brain_root(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/root" % port, timeout=3) as r:
            return json.load(r)
    except Exception:  # noqa: BLE001
        return None


def http_json(port, path):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=5) as r:
            return json.load(r)
    except Exception:  # noqa: BLE001
        return None


def procs_with(text):
    out = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            cmd = open("/proc/%s/cmdline" % pid, "rb").read().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue
        if text in cmd and int(pid) != os.getpid():
            out.append((int(pid), cmd.strip()))
    return out


# --------------------------------------------------------------------------------------- tests
def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain-bin", required=True)
    ap.add_argument("--keep", action="store_true")
    o = ap.parse_args()
    brain_bin = os.path.abspath(o.brain_bin)
    for tool in ("openssl", "zbarimg", "bash"):
        if not shutil.which(tool):
            sys.exit("join-test: %s is required" % tool)
    tmp = tempfile.mkdtemp(prefix="join-test-")
    hub, srv, ca = start_hub(tmp)
    print("fake hub + trunk: %s (qrencode %s)" % (hub.base, "present" if shutil.which("qrencode") else "absent"), flush=True)
    envs = []

    def new_env(name):
        e = Env(tmp, name, brain_bin, ca, hub)
        envs.append(e)
        return e
    try:
        run_tests(hub, new_env, tmp)
    except Exception as e:  # noqa: BLE001 — a crashed step is a failed check, teardown still runs
        import traceback
        traceback.print_exc()
        check("the test ran to the end", False, repr(e))
    finally:
        hub.stopping = True
        for e in envs:
            for p in e.procs:
                if p.poll() is None:
                    os.killpg(p.pid, signal.SIGKILL)
        for e in envs:
            if os.path.exists(os.path.join(e.dir, "root.conf")):
                e.run(["--stop", "--dir", e.dir], timeout=30)
        left = wait_for(lambda: not procs_with(tmp), 10) or procs_with(tmp)
        check("teardown: no process of the test left running", left is True, str(left))
        for pid, _ in procs_with(tmp) if left is not True else []:
            os.kill(pid, signal.SIGKILL)
        srv.shutdown()
        if o.keep:
            print("kept: %s" % tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    n_ok = sum(1 for _, ok in RESULTS if ok)
    print("\n%d/%d checks passed" % (n_ok, len(RESULTS)))
    sys.exit(0 if n_ok == len(RESULTS) else 1)


def run_tests(hub, new_env, tmp):
    # --- QR encoder (pure Python fallback) against zbarimg
    print("\n[qr] pure-Python encoder -> PNG -> zbarimg", flush=True)
    sys.path.insert(0, HERE)
    import rootjoin
    bad = []
    for n in list(range(1, 80)) + list(range(80, 420, 13)):
        t = ("https://hub.example.org/join/" + secrets.token_urlsafe(n))[:max(n, 1)]
        p = os.path.join(tmp, "q.png")
        rootjoin.qr_png(rootjoin.qr_matrix(t), p)
        if decode_png(p) != t:
            bad.append(n)
    check("qr: 105 payload lengths (1..400 bytes, QR versions 1-15) decode exactly", not bad, "failed lengths %s" % bad)
    names = [rootjoin.hub_name_of(a) for a in ({"hub": "home-box"}, {}, {"hub": ""}, {"hub": "local"})]
    check("hub name: the approval's `hub` is the name; none / empty / an older hub's \"local\" -> \"hub\"",
          names == ["home-box", "hub", "hub", "hub"], str(names))

    # --- T1 join + approve, live (nohup supervisor): brain up, dialer linked through wss /rootlink
    print("\n[join] first join, approve on the (fake) phone, live services", flush=True)
    a = new_env("alpha")
    p = a.popen(a.first_args())
    req = wait_for(lambda: hub.last_req() if hub.counts["join"] >= 1 else None, 30)
    png = os.path.join(a.dir, "join-qr.png")
    wait_for(lambda: os.path.exists(png) and "waiting for your approval" in a.out(), 20)
    j = hub.joins[req]
    check("join: one POST /api/roots/join with name/os/host", hub.counts["join"] == 1 and j["name"] == "alpha"
          and j["os"] in ("linux", "wsl", "macos") and j["host"], str(j))
    keyf = os.path.join(a.dir, "wg.key")
    check("join: the request carries this machine's WireGuard public key; the private half stays in DIR/wg.key (mode 600)",
          j.get("wg_pub") and os.path.exists(keyf) and mode(keyf) == 0o600
          and open(keyf + ".pub").read().strip() == j["wg_pub"] and open(keyf).read().strip() != j["wg_pub"], str(j.get("wg_pub")))
    approve_url = "%s/join/%s" % (hub.base, req)
    check("join: QR PNG decodes (zbarimg) to approve_url", decode_png(png) == approve_url, decode_png(png))
    out = a.out()
    check("join: terminal shows the QR, the code and the approve URL",
          j["code"] in out and approve_url in out and ("▀" in out or "▄" in out or "█" in out))
    fp = rootjoin.wg_fingerprint(j["wg_pub"])
    check("join: next to the code, the tunnel key's fingerprint the phone shows (%s)" % fp,
          "Tunnel key (the phone shows it too): %s" % fp in out, out[-600:])
    time.sleep(1.0)
    check("join: still pending (polling) before approval", p.poll() is None and hub.counts["poll"] >= 2)
    root_id = hub.approve(req)
    rc = p.wait(90)
    check("join: exit 0 after approval", rc == 0, "rc=%s\n%s" % (rc, a.out()[-2000:]))
    r = a.root()
    check("state: root.json has root_id, root_secret, rootlink_url, peer_token",
          r["root_id"] == root_id and r["root_secret"] == hub.roots[root_id]["secret"]
          and r["rootlink_url"] == hub.base.replace("https", "wss") + "/rootlink" and r["peer_token"] == j["peer_token"])
    check("state: root.json keeps the key it sent and the hub's tunnel grant (the hub's key, the addresses)",
          r.get("wg_pub") == j["wg_pub"] and r.get("wg") == j["wg"], str(r.get("wg")))
    modes = {n: oct(mode(os.path.join(a.dir, n))) for n in ("root.json", "link-tokens", "brain.env", "root.conf", "wg.key", "wg.toml")}
    check("state: root.json, link-tokens, brain.env, root.conf, wg.key, wg.toml are mode 600; the dir 700",
          set(modes.values()) == {"0o600"} and mode(a.dir) == 0o700, "%s dir=%s" % (modes, oct(mode(a.dir))))
    check("state: no pending.json left", not os.path.exists(os.path.join(a.dir, "pending.json")))
    env_lines = [l for l in open(os.path.join(a.dir, "brain.env")).read().splitlines() if l and not l.startswith("#")]
    want = ["YGG_UPSTREAM_BASE_URL=http://127.0.0.1:9/v1", "YGG_UPSTREAM_API_KEY=" + KEY, "YGG_UPSTREAM_MODEL=test-model",
            "YGG_LISTEN=127.0.0.1:%d" % a.brain_port, "YGG_DATA_DIR=%s/data" % a.dir, "YGG_PROJECT_DIR=%s" % a.home,
            "YGG_ROOT_NAME=%s" % root_id, "YGG_PEERS=home-box=http://127.0.0.1:%d/_wg/local" % a.peer_port,
            "YGG_PEERS_FROM=http://127.0.0.1:%d/_wg/_roots" % a.peer_port, "YGG_PEERS_VIA=http://127.0.0.1:%d/_wg/{id}" % a.peer_port,
            "YGG_PEER_TOKEN=%s" % j["peer_token"]]
    check("brain.env: exactly upstream + listen/data/project/root name/peers (the hub brain by its name, inside the "
          "tunnel; the other roots from the node's list)/peer token", env_lines == want, "\n".join(env_lines))
    g = j["wg"]
    want_wg = ('[wg]\nkey_file = "{d}/wg.key"\nudp = "127.0.0.1:{pp}"\nrelay = "127.0.0.1:{bp}"\nhttp = "127.0.0.1:{pp}"\n'
               'brain = "http://127.0.0.1:{bp}"\naddress = "{ip}/24"\n\n[[wg.peer]]\nid = "local"\npublic_key = "{k}"\n'
               'ip = "10.99.5.1"\n').format(d=a.dir, pp=a.peer_port, bp=a.brain_port, ip=g["ip"], k=hub.wg_pub)
    wgt = open(os.path.join(a.dir, "wg.toml")).read()
    check("wg.toml: the node's key, loopback ports (door + udp = peer port, relay = the dialer's udp on the brain "
          "port), this root's address, one peer: local = the hub's key", wgt.split("\n", 1)[1] == want_wg, wgt)
    check("state: root.json keeps the hub brain's name", r.get("hub_name") == "home-box", str(r.get("hub_name")))
    py = shutil.which("python3")
    dial = [l for l in open(os.path.join(a.dir, "bin", "run-dialer")).read().splitlines() if l.startswith("exec ")]
    want_dial = ("exec '{py}' '{d}/bin/root-dial.py' --tls --host 'localhost' --port {hp} --path '/rootlink' "
                 "--token-file '{d}/link-tokens' --brain 'http://127.0.0.1:{bp}' --wg-udp 127.0.0.1:{bp} --wg-node 127.0.0.1:{pp} "
                 "--probe-exec '{py} {d}/bin/rootjoin.py probe http://127.0.0.1:{bp}/root'").format(
        py=py, d=a.dir, hp=hub.base.rsplit(":", 1)[1], bp=a.brain_port, pp=a.peer_port)
    check("dialer: exact command line (--tls --host --port --path --token-file --brain --wg-udp --wg-node)",
          dial == [want_dial], "%s\n!=\n%s" % (dial, want_dial))
    link = wait_for(lambda: next((l for l in hub.links if l["root"] == root_id and l["pong"]), None), 40)
    check("live: the dialer linked to the trunk on /rootlink with a valid token and EARNED a pong (brain probe)",
          link and link["path"] == "/rootlink", str(hub.links))
    br = brain_root(a.brain_port)
    check("live: the brain answers GET /root as this root, peer 'home-box' (the hub brain) configured",
          br and br.get("name") == root_id and br.get("peers") == ["home-box"], str(br))
    node = wait_for(lambda: http_json(a.peer_port, "/_wg"), 20)
    check("live: this root's WireGuard node runs (supervised): its one peer is `local`, the hub's key; no other root yet",
          node and [p["id"] for p in node] == ["local"] and node[0]["fingerprint"] == rootjoin.wg_fingerprint(hub.wg_pub)
          and http_json(a.peer_port, "/_wg/_roots") == [], str(node))
    toks = a.tokens()
    check("refill: before the first dial 4 < 5 tokens -> one refill (+8), the dial burned 1 -> 11 left",
          hub.counts["refill"] == 1 and len(toks) == 11 and link["token"] not in toks and len(set(toks)) == 11,
          "refills=%d tokens=%d" % (hub.counts["refill"], len(toks)))
    check("refill: link-tokens still mode 600 after the dialer burned one", mode(os.path.join(a.dir, "link-tokens")) == 0o600)
    logs = "".join(open(os.path.join(a.dir, "log", n)).read() for n in os.listdir(os.path.join(a.dir, "log")))
    check("secrets: the upstream key and root secret never appear in join.sh output or the logs",
          KEY not in a.out() + logs and r["root_secret"] not in a.out() + logs)
    check("supervisor: nohup supervisor running", a.sup_pid() is not None)

    # --- refill directly
    print("\n[refill] the refill step on its own", flush=True)
    h = [sys.executable, os.path.join(a.dir, "bin", "rootjoin.py"), "refill", "--state", a.dir]
    n0 = hub.counts["refill"]
    rr = subprocess.run(h, capture_output=True, text=True)
    check("refill: >= 5 tokens left -> no call to the hub", rr.returncode == 0 and hub.counts["refill"] == n0, rr.stdout + rr.stderr)
    with open(os.path.join(a.dir, "link-tokens"), "w") as f:
        f.write("\n".join(toks[:2]) + "\n")
    rr = subprocess.run(h, capture_output=True, text=True)
    check("refill: 2 left -> POST tokens with x-root-secret -> 10", rr.returncode == 0 and hub.counts["refill"] == n0 + 1
          and len(a.tokens()) == 10 and mode(os.path.join(a.dir, "link-tokens")) == 0o600, rr.stdout + rr.stderr)
    with open(os.path.join(a.dir, "link-tokens"), "w") as f:
        f.write(toks[0] + "\n")
    hub.refill_status = 503
    rr = subprocess.run(h, capture_output=True, text=True)
    hub.refill_status = 200
    check("refill: hub error -> exit 1, tokens untouched", rr.returncode == 1 and a.tokens() == [toks[0]], rr.stderr)
    subprocess.run(h, capture_output=True)

    # --- T2 re-run is idempotent
    print("\n[idempotent] re-run with no options", flush=True)
    sup0, env0, joins0 = a.sup_pid(), open(os.path.join(a.dir, "brain.env")).read(), hub.counts["join"]
    rc = a.run(["--dir", a.dir])
    out = a.out().rsplit("$ join.sh", 1)[1]
    check("re-run: exit 0, no new join request, same root", rc == 0 and hub.counts["join"] == joins0
          and "already joined" in out and a.root()["root_id"] == root_id, "rc=%s %s" % (rc, out[-800:]))
    check("re-run: nothing changed -> the running supervisor is kept (auto picked nohup again)",
          a.sup_pid() == sup0 and "supervisor already running" in out, out[-600:])
    check("re-run: brain.env byte-identical (upstream kept without --upstream-env)",
          open(os.path.join(a.dir, "brain.env")).read() == env0)
    rc = a.run(["--dir", a.dir, "--hub", "https://other.example"])
    check("re-run: a different --hub without --rejoin is refused (exit 64)", rc == 64)

    # --- T3 pending join survives Ctrl-C; re-run resumes it (no new request); --no-start; QR fallback
    print("\n[resume] Ctrl-C while waiting, re-run resumes the same request (pure-Python QR)", flush=True)
    b = new_env("bravo")
    p = b.popen(b.first_args() + ["--no-start"], JOIN_NO_QRENCODE="1")
    wait_for(lambda: "waiting for your approval" in b.out(), 30)
    breq, joins0 = hub.last_req(), hub.counts["join"]
    check("fallback QR: PNG from the pure-Python encoder decodes to approve_url",
          decode_png(os.path.join(b.dir, "join-qr.png")) == "%s/join/%s" % (hub.base, breq))
    check("fallback QR: terminal QR drawn with half blocks", "\x1b[" in b.out() and "▀" in b.out())
    os.killpg(p.pid, signal.SIGINT)
    rc = p.wait(20)
    check("resume: Ctrl-C stops the wait, the pending request is kept (mode 600)", rc != 0
          and mode(os.path.join(b.dir, "pending.json")) == 0o600, "rc=%s" % rc)
    p = b.popen(["--dir", b.dir, "--no-start"])
    wait_for(lambda: b.out().count("waiting for your approval") >= 2, 30)
    check("resume: re-run without --hub resumes the same request (same name, CA), no new POST",
          hub.counts["join"] == joins0 and "resuming the join request" in b.out()
          and b.out().count("asking %s" % hub.base) == 1)
    hub.wg = False                     # an older hub: no `hub` in its answer, no tunnel
    hub.approve(breq, hub_name=None)
    hub.wg = True
    rc = p.wait(60)
    check("resume: approved -> exit 0 as 'bravo'; --no-start started nothing", rc == 0 and b.sup_pid() is None
          and b.root()["name"] == "bravo" and hub.joins[breq]["root_id"] == b.root()["root_id"]
          and not os.path.exists(os.path.join(b.dir, "run", "supervise.pid")), "rc=%s" % rc)
    check("older hub (no name in the answer): the hub brain's peer is called 'hub', as before",
          "YGG_PEERS=hub=http://127.0.0.1:%d/local\n" % b.peer_port in open(os.path.join(b.dir, "brain.env")).read())
    check("older hub (no tunnel granted): the old plaintext peer port, no node, said so",
          "--peer-port %d " % b.peer_port in open(os.path.join(b.dir, "bin", "run-dialer")).read()
          and not os.path.exists(os.path.join(b.dir, "wg.toml")) and not os.path.exists(os.path.join(b.dir, "bin", "run-wg"))
          and "granted no WireGuard tunnel" in b.out())

    # --- a root that joined before the tunnel (no key in root.json): a re-run joins again, with a key
    print("\n[tunnel] a root joined before the tunnel joins again with a key", flush=True)
    r0 = b.root()
    r0.pop("wg_pub", None)
    r0.pop("wg", None)
    with open(os.path.join(b.dir, "root.json"), "w") as fh:
        json.dump(r0, fh)
    joins0 = hub.counts["join"]
    p = b.popen(["--dir", b.dir, "--no-start"])
    wait_for(lambda: hub.counts["join"] > joins0, 30)
    nreq = hub.last_req()
    hub.approve(nreq)
    rc = p.wait(60)
    nj = hub.joins[nreq]
    check("keyless root: re-run -> a new join request WITH a key (said so), approved -> root.json has the tunnel",
          rc == 0 and hub.counts["join"] == joins0 + 1 and nj.get("wg_pub") and "joined before the tunnel" in b.out()
          and b.root().get("wg") == nj["wg"] and b.root()["root_id"] == nj["root_id"]
          and open(os.path.join(b.dir, "wg.key.pub")).read().strip() == nj["wg_pub"]
          and os.path.exists(os.path.join(b.dir, "bin", "run-wg")), "rc=%s\n%s" % (rc, b.out()[-800:]))

    # --- T4 refused / expired / unreachable exit cleanly
    print("\n[refused / expired / unreachable]", flush=True)
    c = new_env("charlie")
    hub.auto = "refuse"
    rc = c.run(c.first_args())
    hub.auto = None
    files = sorted(os.listdir(c.dir))
    benv = open(os.path.join(c.dir, "brain.env")).read() if "brain.env" in files else ""
    check("refused: exit 3, 'refused' said, no root.json / pending.json / tokens, nothing started "
          "(brain.env keeps only the upstream for a retry)",
          rc == 3 and "refused" in c.out() and not {"root.json", "pending.json", "link-tokens"} & set(files)
          and "YGG_ROOT_NAME" not in benv and c.sup_pid() is None, "rc=%s files=%s" % (rc, files))
    d = new_env("delta")
    hub.ttl = 1
    rc = d.run(d.first_args())
    hub.ttl = 120
    check("expired: exit 4, 'expired' said, no root.json / pending.json, nothing started",
          rc == 4 and "expired" in d.out() and not {"root.json", "pending.json"} & set(os.listdir(d.dir))
          and d.sup_pid() is None, "rc=%s" % rc)
    e = new_env("echo")
    args = e.first_args()
    args[args.index("--hub") + 1] = "https://localhost:%d" % free_port()
    rc = e.run(args)
    check("unreachable hub: exit 1 with 'cannot reach the hub', no state",
          rc == 1 and "cannot reach the hub" in e.out() and not os.path.exists(os.path.join(e.dir, "root.json")), "rc=%s" % rc)
    g = new_env("golf")
    hub.auto, hub.hub_name = "approve", "bad name/../x"
    rc = g.run(g.first_args())
    hub.auto, hub.hub_name = None, "home-box"
    check("bad hub name: exit 1, 'not a plain name' said, no root.json, nothing started",
          rc == 1 and "not a plain name" in g.out() and not os.path.exists(os.path.join(g.dir, "root.json"))
          and g.sup_pid() is None, "rc=%s" % rc)
    f = new_env("foxtrot")
    rc = f.run(["--hub", hub.base, "--cacert", f.cacert, "--brain-bin", f.brain_bin, "--supervisor", "nohup"])
    check("no upstream (non-interactive): exit 64 BEFORE any join request", rc == 64 and "no model upstream" in f.out()
          and not any(jj["name"] == "foxtrot" for jj in hub.joins.values()), "rc=%s" % rc)

    # --- T5 systemd --user units (recording shims, never the real manager)
    print("\n[systemd] units + systemctl calls (shim)", flush=True)
    s = new_env("sierra")
    rec = s.make_shims()
    hub.auto = "approve"
    rc = s.run(s.first_args("systemd"), JOIN_BRAIN_WAIT="1")
    ud = os.path.join(s.home, ".config", "systemd", "user")
    units = sorted(os.listdir(ud)) if os.path.isdir(ud) else []
    check("systemd: exit 0; brain + dial services, refill service + timer written",
          rc == 0 and units == ["yggdrasil-root-brain.service", "yggdrasil-root-dial.service",
                                "yggdrasil-root-refill.service", "yggdrasil-root-refill.timer",
                                "yggdrasil-root-wg.service"], "rc=%s %s" % (rc, units))
    u = {n: open(os.path.join(ud, n)).read() for n in units}
    check("systemd: ExecStart lines", "ExecStart=%s/bin/run-brain\n" % s.dir in u.get(units[0], "")
          and "ExecStart=%s/bin/run-dialer\n" % s.dir in u.get(units[1], "") and "Restart=always" in u.get(units[1], "")
          and "ExecStart=%s %s/bin/rootjoin.py refill --state %s\n" % (shutil.which("python3"), s.dir, s.dir) in u.get(units[2], "")
          and "OnUnitActiveSec=5min" in u.get(units[3], "")
          and "ExecStart=%s/bin/run-wg\n" % s.dir in u.get("yggdrasil-root-wg.service", "")
          and "Restart=always" in u.get("yggdrasil-root-wg.service", ""))
    calls = open(rec).read().splitlines()
    want = ["systemctl --user daemon-reload",
            "systemctl --user enable yggdrasil-root-brain.service yggdrasil-root-dial.service yggdrasil-root-wg.service "
            "yggdrasil-root-refill.timer",
            "systemctl --user restart yggdrasil-root-brain.service yggdrasil-root-dial.service yggdrasil-root-wg.service",
            "systemctl --user start yggdrasil-root-refill.timer"]
    check("systemd: daemon-reload, enable, restart, timer start, linger", all(w in calls for w in want)
          and any(c.startswith("loginctl enable-linger") for c in calls), "\n".join(calls))
    if shutil.which("systemd-analyze"):
        va = subprocess.run(["systemd-analyze", "verify"] + [os.path.join(ud, n) for n in units], capture_output=True, text=True)
        check("systemd: systemd-analyze verify accepts the units", va.returncode == 0, va.stdout + va.stderr)
    open(rec, "w").close()
    rc = s.run(["--dir", s.dir, "--supervisor", "systemd"], JOIN_BRAIN_WAIT="1")
    calls = open(rec).read().splitlines()
    check("systemd: re-run -> start (not restart), no new join",
          rc == 0 and "systemctl --user start yggdrasil-root-brain.service yggdrasil-root-dial.service yggdrasil-root-wg.service" in calls
          and not any("restart" in c for c in calls), "\n".join(calls))
    rc = s.run(["--stop", "--dir", s.dir])
    check("systemd: --stop disables + stops the units (the node's too)", rc == 0 and any(
        c.startswith("systemctl --user disable --now yggdrasil-root-brain.service yggdrasil-root-dial.service "
                     "yggdrasil-root-wg.service") for c in open(rec).read().splitlines()))

    # --- T6 launchd agents (shim): what macOS gets
    print("\n[launchd] LaunchAgents plists + launchctl calls (shim)", flush=True)
    m = new_env("mike")
    rec = m.make_shims()
    rc = m.run(m.first_args("launchd"), JOIN_BRAIN_WAIT="1")
    hub.auto = None
    ad = os.path.join(m.home, "Library", "LaunchAgents")
    names = sorted(os.listdir(ad)) if os.path.isdir(ad) else []
    pl = {}
    for n in names:
        with open(os.path.join(ad, n), "rb") as fh:
            pl[n] = plistlib.load(fh)
    lb = "org.veraldar.yggdrasil-root."
    check("launchd: exit 0; brain, dial, refill, wg plists parse", rc == 0 and names == [lb + "brain.plist", lb + "dial.plist", lb + "refill.plist", lb + "wg.plist"],
          "rc=%s %s" % (rc, names))
    check("launchd: ProgramArguments / KeepAlive / StartInterval",
          pl.get(lb + "brain.plist", {}).get("ProgramArguments") == [m.dir + "/bin/run-brain"]
          and pl[lb + "dial.plist"]["ProgramArguments"] == [m.dir + "/bin/run-dialer"] and pl[lb + "dial.plist"]["KeepAlive"] is True
          and pl[lb + "refill.plist"]["ProgramArguments"] == [shutil.which("python3"), m.dir + "/bin/rootjoin.py", "refill", "--state", m.dir]
          and pl[lb + "refill.plist"]["StartInterval"] == 300
          and pl[lb + "wg.plist"]["ProgramArguments"] == [m.dir + "/bin/run-wg"] and pl[lb + "wg.plist"]["KeepAlive"] is True, str(pl)[:600])
    calls = open(rec).read().splitlines()
    check("launchd: bootstrap gui/<uid> for each agent",
          sum(1 for c in calls if c.startswith("launchctl bootstrap gui/%d " % os.getuid())) == 4, "\n".join(calls))

    # --- T7 --rejoin on the live root
    print("\n[rejoin] --rejoin replaces the join and restarts the services", flush=True)
    sup0, joins0, key0 = a.sup_pid(), hub.counts["join"], open(os.path.join(a.dir, "wg.key.pub")).read().strip()
    p = a.popen(["--dir", a.dir, "--rejoin"])
    wait_for(lambda: hub.counts["join"] > joins0, 30)
    rreq = hub.last_req()
    pending_key = open(os.path.join(a.dir, "wg.key.pub")).read().strip()
    rid2 = hub.approve(rreq)
    rc = p.wait(90)
    check("rejoin: a fresh WireGuard key for the new join; the old one kept until the approval, then replaced",
          hub.joins[rreq]["wg_pub"] not in (None, key0) and pending_key == key0
          and open(os.path.join(a.dir, "wg.key.pub")).read().strip() == hub.joins[rreq]["wg_pub"]
          and not os.path.exists(os.path.join(a.dir, "wg-next.key")) and mode(os.path.join(a.dir, "wg.key")) == 0o600)
    check("rejoin: exit 0, one new request, new root id in root.json and brain.env",
          rc == 0 and hub.counts["join"] == joins0 + 1 and a.root()["root_id"] == rid2
          and "YGG_ROOT_NAME=%s\n" % rid2 in open(os.path.join(a.dir, "brain.env")).read(), "rc=%s" % rc)
    link = wait_for(lambda: next((l for l in hub.links if l["root"] == rid2 and l["pong"]), None), 40)
    check("rejoin: supervisor restarted, the new root linked + ponged", a.sup_pid() not in (None, sup0) and link)
    br = wait_for(lambda: (brain_root(a.brain_port) or {}).get("name") == rid2, 20)
    check("rejoin: the brain now answers as the new root", br)

    # --- the release download (Linux/WSL x86_64): bifrost-net-<ver>-linux-x86_64 checked against SHA256SUMS
    print("\n[release] bifrost-net from the (fake) GitHub release, checked against SHA256SUMS", flush=True)
    trunk = os.path.join(os.path.dirname(os.path.dirname(HERE)), "trunk", "target")
    full = open(os.path.join(trunk, "release", "bifrost-net"), "rb").read()
    full_asset = "bifrost-net-0.9.9-test-linux-x86_64"
    root_path = os.path.join(trunk, "root", "release", "bifrost-net")     # where join.sh builds the root build
    sums = lambda d: "".join("%s  %s\n" % (hashlib.sha256(v).hexdigest(), k) for k, v in d.items()).encode()
    hub.release = {full_asset: full}
    hub.release["SHA256SUMS"] = sums(hub.release)
    out = os.path.join(tmp, "fetched")
    fetch = lambda o: subprocess.run([sys.executable, HELPER, "fetch-net", "--base", hub.base + "/releases/latest/download",
                                      "--arch", "x86_64", "--out", o, "--cacert", hub_ca(tmp)], capture_output=True, text=True)
    fr = fetch(out)
    check("release: fetch-net takes the asset SHA256SUMS names, checks it, installs it mode 755",
          fr.returncode == 0 and fr.stdout.strip() == full_asset and open(out, "rb").read() == full and mode(out) == 0o755,
          fr.stdout + fr.stderr)
    asset, data = full_asset, full
    if os.path.exists(root_path):   # a release that also ships the root build: joined roots take that one
        asset, data = "bifrost-net-root-0.9.9-test-linux-x86_64", open(root_path, "rb").read()
        hub.release = {asset: data, full_asset: full}
        hub.release["SHA256SUMS"] = sums(hub.release)
        fr = fetch(out)
        check("release: with a root build in it (bifrost-net-root-…), fetch-net takes that one (no libopus needed)",
              fr.returncode == 0 and fr.stdout.strip() == asset and open(out, "rb").read() == data, fr.stdout + fr.stderr)
    hub.release[asset] = data[:-1] + bytes([data[-1] ^ 1])
    fr = subprocess.run([sys.executable, HELPER, "fetch-net", "--base", hub.base + "/releases/latest/download",
                         "--arch", "x86_64", "--out", out + "2", "--cacert", hub_ca(tmp)], capture_output=True, text=True)
    check("release: a tampered asset is refused (does not match SHA256SUMS), nothing installed",
          fr.returncode == 1 and "does not match SHA256SUMS" in fr.stderr and not os.path.exists(out + "2"), fr.stderr)
    hub.release[asset] = data
    z = new_env("zulu")
    fake = os.path.join(tmp, "zulu", "bifrost-net")
    with open(fake, "w") as fh:
        fh.write("#!/bin/sh\necho '%s: error while loading shared libraries: libopus.so.0: cannot open shared object "
                 "file: No such file or directory' >&2\nexit 127\n" % fake)
    os.chmod(fake, 0o755)
    joins0 = hub.counts["join"]
    rc = z.run(z.first_args() + ["--net-bin", fake])
    check("a bifrost-net that cannot load (no libopus): exit 1, the package named, no join request",
          rc == 1 and "cannot start" in z.out() and "libopus0" in z.out() and hub.counts["join"] == joins0, "rc=%s" % rc)

    bootstrap_test(hub, new_env, tmp)

    # --- T8 --stop
    print("\n[stop]", flush=True)
    rc = a.run(["--stop", "--dir", a.dir])
    gone = wait_for(lambda: brain_root(a.brain_port) is None and a.sup_pid() is None and not procs_with(a.dir), 15)
    check("stop: exit 0, supervisor, brain and dialer gone", rc == 0 and gone, str(procs_with(a.dir)))


def hub_ca(tmp):
    return os.path.join(tmp, "ca.pem")


def bootstrap_test(hub, new_env, tmp):
    """win/wsl-bootstrap.sh — what launcher.bat runs inside WSL2 — with wslpath/explorer.exe shims and a
    local clone source, so clone (sparse), update, join with os=wsl and the Desktop QR are all exercised."""
    print("\n[windows, inside WSL] wsl-bootstrap.sh: clone, join, QR to the Desktop via wslpath", flush=True)
    repo = os.path.dirname(os.path.dirname(HERE))
    boot = os.path.join(repo, "win", "wsl-bootstrap.sh")
    if not shutil.which("git"):
        return check("bootstrap: git present (WSL's Ubuntu has it)", False)
    src, bare = os.path.join(tmp, "src"), os.path.join(tmp, "yggdrasil.git")
    for rel in ("root/install/join.sh", "root/install/rootjoin.py", "trunk/scripts/root-dial.py"):
        os.makedirs(os.path.join(src, os.path.dirname(rel)), exist_ok=True)
        shutil.copy2(os.path.join(repo, rel), os.path.join(src, rel))
    os.makedirs(os.path.join(src, "branch"))
    open(os.path.join(src, "branch", "big.txt"), "w").write("not needed by a root\n")
    g = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"]
    q = dict(cwd=src, check=True, capture_output=True)
    subprocess.run(g + ["init", "-q"], **q)
    subprocess.run(g + ["add", "-A"], **q)
    subprocess.run(g + ["commit", "-qm", "tree"], **q)
    subprocess.run(g + ["checkout", "-qb", "old"], **q)
    subprocess.run(g + ["rm", "-rq", "root"], **q)
    subprocess.run(g + ["commit", "-qm", "old layout"], **q)
    subprocess.run(["git", "clone", "-q", "--bare", src, bare], check=True, capture_output=True)

    w = new_env("whiskey")
    w.make_shims()
    mnt = os.path.join(os.path.dirname(w.home), "mnt")
    rec = os.path.join(w.shim, "calls.log")
    shims = {
        "wslpath": 'case $1 in\n  -u) p=$(printf "%%s" "$2" | tr "\\\\134" "/" | sed "s|^C:|c|"); printf "%%s\\n" "%s/$p" ;;\n'
                   '  -w) printf "%%s\\n" "C:\\\\fake$2" ;;\nesac' % mnt,
        "explorer.exe": ":",
    }
    for tool, body in shims.items():
        with open(os.path.join(w.shim, tool), "w") as f:
            f.write('#!/bin/sh\nprintf "%%s\\n" "%s $*" >> "%s"\n%s\n' % (tool, rec, body))
        os.chmod(os.path.join(w.shim, tool), 0o755)
    qr_win = "C:\\Users\\me\\Desktop\\Veraldar-Join-QR.png"
    qr_png = os.path.join(mnt, "c", "Users", "me", "Desktop", "Veraldar-Join-QR.png")
    tail = ["--", "--upstream-env", w.up, "--cacert", w.cacert, "--brain-bin", w.brain_bin, "--supervisor", "nohup",
            "--no-start", "--brain-port", str(w.brain_port), "--peer-port", str(w.peer_port)]

    def boot_run(args, home=None):
        # the sparse clone has no trunk/target: join.sh downloads bifrost-net from the (fake) release
        e = w.env(WSL_DISTRO_NAME="Ubuntu", JOIN_RELEASES=hub.base + "/releases")
        if home:
            e["HOME"] = home
        with open(w.log, "a") as f:
            f.write("\n$ wsl-bootstrap.sh %s\n" % " ".join(args))
            f.flush()
            return subprocess.run(["bash", boot] + args, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                  env=e, timeout=120).returncode

    url = "file://" + bare
    joins0 = hub.counts["join"]
    hub.auto = "approve"
    rc = boot_run(["--hub", hub.base, "--branch", "main", "--repo", url, "--qr-win", qr_win] + tail)
    hub.auto = None
    co = os.path.join(w.home, "veraldar", "yggdrasil")
    j = list(hub.joins.values())[-1]
    check("bootstrap: exit 0; one join request, sent as os=wsl", rc == 0 and hub.counts["join"] == joins0 + 1
          and j["os"] == "wsl", "rc=%s os=%s\n%s" % (rc, j.get("os"), w.out()[-1500:]))
    wbin = os.path.join(w.dir, "bin", "bifrost-net")
    check("bootstrap: bifrost-net downloaded from the release (SHA256SUMS checked), the key made, the tunnel granted",
          "downloading bifrost-net" in w.out() and os.path.exists(wbin) and mode(wbin) == 0o755
          and open(wbin, "rb").read() == hub.release[next(iter(hub.release))]
          and j.get("wg_pub") and w.root().get("wg") == j.get("wg"), w.out()[-800:])
    check("bootstrap: sparse clone into ~/veraldar/yggdrasil (root/ + trunk/scripts, not branch/)",
          os.path.isfile(os.path.join(co, "root", "install", "join.sh")) and os.path.isfile(os.path.join(co, "trunk", "scripts", "root-dial.py"))
          and not os.path.exists(os.path.join(co, "branch")))
    check("bootstrap: QR PNG on the 'Windows Desktop' (wslpath -u) decodes to approve_url",
          os.path.exists(qr_png) and decode_png(qr_png) == "%s/join/%s" % (hub.base, next(reversed(hub.joins))))
    opened = wait_for(lambda: [l for l in open(rec).read().splitlines() if l.startswith("explorer.exe ")], 10)
    check("bootstrap: the PNG is opened on Windows (explorer.exe <wslpath -w path>)",
          opened and opened[0] == "explorer.exe C:\\fake" + qr_png, str(opened))
    blog = os.path.join(w.home, ".local", "state", "veraldar", "bootstrap.log")
    check("bootstrap: everything also lands in ~/.local/state/veraldar/bootstrap.log",
          os.path.exists(blog) and "downloading" in open(blog).read() and "approved" in open(blog).read())
    joins0 = hub.counts["join"]
    rc = boot_run(["--hub", hub.base + "\r\n", "--branch", "main", "--repo", url, "--qr-win", qr_win] + tail)
    check("bootstrap: second double-click (hub arriving with a stray CR/LF from cmd) -> updates the clone, "
          "keeps the join (no new request)",
          rc == 0 and hub.counts["join"] == joins0 and "updating" in open(blog).read()
          and "already joined" in w.out().rsplit("$ wsl-bootstrap.sh", 1)[1], "rc=%s" % rc)
    home2 = os.path.join(os.path.dirname(w.home), "home2")
    os.makedirs(home2)
    rc = boot_run(["--hub", hub.base, "--branch", "old", "--repo", url] + tail, home=home2)
    check("bootstrap: a branch without root/install/join.sh fails clearly (set BRANCH in launcher.bat)",
          rc == 1 and "has no root/install/join.sh" in w.out(), "rc=%s" % rc)


if __name__ == "__main__":
    main()
