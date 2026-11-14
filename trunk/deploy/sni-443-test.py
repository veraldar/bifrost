#!/usr/bin/env python3
"""sni-443-test.py — sni-443.py against real TLS clients, on loopback, no root, ~10 s.

Fake backends: a 'website' and a 'coturn' that record the first bytes and answer their name, and a real TLS
'access point' that requires the PROXY v1 line first (like `bifrost-net ap` with proxy_protocol = true).
Checks every route, byte-exact passthrough, case and trailing-dot names, a wildcard route, STUN, garbage,
an idle connection that outlives the 5 s connect timeout, IPv6 (when this machine has it) and config errors.
    python3 trunk/deploy/sni-443-test.py        exit 0 = GREEN
"""
import importlib.util
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sni", os.path.join(HERE, "sni-443.py"))
sni = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sni)
TMP = tempfile.mkdtemp(prefix="sni-443-test.")
CRT, KEY = os.path.join(TMP, "t.crt"), os.path.join(TMP, "t.key")
subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                "-keyout", KEY, "-out", CRT, "-days", "1", "-subj", "/CN=trunk.example.org",
                "-addext", "subjectAltName=DNS:trunk.example.org,DNS:x.apps.example.org,DNS:www.example.org"],
               check=True, capture_output=True)
got = {}


def listener(host="127.0.0.1"):
    s = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, 0))
    s.listen(16)
    return s


def fake(name, s):
    """records the first bytes, answers its own name"""
    while True:
        c, _ = s.accept()
        c.settimeout(3)
        try:
            got.setdefault(name, []).append(c.recv(65536))
        except OSError:
            pass
        try:
            c.sendall(name.encode())
        except OSError:
            pass
        c.close()


def tls_backend(name, s, want_proxy):
    """a real TLS server; with want_proxy it requires the PROXY v1 line first. Echoes NAME:<data>, twice."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CRT, KEY)
    while True:
        c, _ = s.accept()

        def one(c=c):
            c.settimeout(20)
            if want_proxy:
                line = b""
                while not line.endswith(b"\r\n") and len(line) < 108:
                    line += c.recv(1)
                got.setdefault(name + "-proxy", []).append(line.decode(errors="replace"))
            try:
                t = ctx.wrap_socket(c, server_side=True)
                for _ in range(2):
                    data = t.recv(1000)
                    if not data:
                        break
                    t.sendall(name.encode() + b":" + data)
                t.close()
            except Exception as e:  # noqa: BLE001
                got.setdefault(name + "-err", []).append(repr(e))
        threading.Thread(target=one, daemon=True).start()


website, coturn, ap, apps = listener(), listener(), listener(), listener()
threading.Thread(target=fake, args=("website", website), daemon=True).start()
threading.Thread(target=fake, args=("coturn", coturn), daemon=True).start()
threading.Thread(target=tls_backend, args=("AP", ap, True), daemon=True).start()
threading.Thread(target=tls_backend, args=("APPS", apps, False), daemon=True).start()

have6 = socket.has_ipv6
try:
    socket.socket(socket.AF_INET6).bind(("::1", 0))
except OSError:
    have6 = False
conf = os.path.join(TMP, "sni-443.conf")
with open(conf, "w") as f:
    f.write(f"""# test config
listen  127.0.0.1:0
{'listen  [::]:0' if have6 else ''}
route   Trunk.Example.Org.  127.0.0.1:{ap.getsockname()[1]}  proxy   # case + trailing dot in the config too
route   *.apps.example.org  127.0.0.1:{apps.getsockname()[1]}
default 127.0.0.1:{website.getsockname()[1]}
stun    127.0.0.1:{coturn.getsockname()[1]}
""")
cfg = sni.load(conf)
ports = []
ready = threading.Event()
threading.Thread(target=sni.serve, args=(cfg, lambda p: (ports.extend(p), ready.set())), daemon=True).start()
ready.wait(5)
port = ports[0]

ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def tls(sni_name, host="127.0.0.1", p=None, idle=0.0):
    ctx = ssl.create_default_context(cafile=CRT)
    ctx.check_hostname = bool(sni_name)
    if not sni_name:
        ctx.verify_mode = ssl.CERT_NONE
    c = socket.create_connection((host, p or port))
    try:
        t = ctx.wrap_socket(c, server_hostname=sni_name)
        t.sendall(b"hello-trunk")
        r = t.recv(100)
        if idle:
            time.sleep(idle)
            t.sendall(b"still-here")
            r += b"|" + t.recv(100)
        t.close()
        return r
    except Exception as e:  # noqa: BLE001
        return repr(e)


# 1. the trunk: TLS end to end through the router, the PROXY line first, naming the client
r = tls("trunk.example.org")
check("trunk.example.org → the access point, TLS end to end, bytes exact", r == b"AP:hello-trunk", r)
pl = got.get("AP-proxy", [""])[-1]
check("PROXY v1 line names the client", pl.startswith("PROXY TCP4 127.0.0.1 127.0.0.1 ") and pl.endswith(f" {port}\r\n"), pl)
# 2. the website and everything else: byte-exact ClientHello, no PROXY line
n = len(got.get("website", []))
tls("www.example.org")
time.sleep(0.2)
first = got["website"][-1] if len(got.get("website", [])) > n else b""
check("www.example.org → website, unchanged (starts with its ClientHello, no PROXY)",
      first[:1] == b"\x16" and sni.sni_of(first) == "www.example.org")
n = len(got.get("website", []))
tls(None)
time.sleep(0.2)
check("TLS without a name (an IP) → website", len(got.get("website", [])) == n + 1)
c = socket.create_connection(("127.0.0.1", port))
c.sendall(b"GET / HTTP/1.1\r\nHost: www.example.org\r\n\r\n")
r = c.recv(100)
c.close()
check("plain http → website", r == b"website", r)
# 3. a wildcard route, and a name merely ending like it
check("x.apps.example.org → the wildcard route (no PROXY)", tls("x.apps.example.org") == b"APPS:hello-trunk")
check("apps.example.org itself is not below *.apps.example.org", sni.route_of(cfg, "apps.example.org")[0] == cfg["default"])
check("evilapps.example.org does not match *.apps.example.org", sni.route_of(cfg, "evilapps.example.org")[0] == cfg["default"])
# 4. STUN / TURN over TCP
stun = (0x0001).to_bytes(2, "big") + (0).to_bytes(2, "big") + b"\x21\x12\xa4\x42" + os.urandom(12)
c = socket.create_connection(("127.0.0.1", port))
c.sendall(stun)
r = c.recv(100)
c.close()
check("STUN/TURN → coturn", r == b"coturn", r)
# 5. a real openssl client (OpenSSL 3: a big ClientHello), the name in another case + trailing dot
n = len(got.get("AP-proxy", []))
subprocess.run(["openssl", "s_client", "-connect", f"127.0.0.1:{port}", "-servername", "TRUNK.Example.Org."],
               input=b"", capture_output=True, timeout=10)
time.sleep(0.3)
check("openssl s_client, 'TRUNK.Example.Org.' → the access point", len(got.get("AP-proxy", [])) == n + 1)
# 6. an idle link outlives the 5 s connect timeout (the upstream-timeout law)
r = tls("trunk.example.org", idle=6)
check("an idle trunk link (6 s) keeps going", r == b"AP:hello-trunk|AP:still-here", r)
# 7. garbage, truncated and slow hellos never crash it
for junk in (b"\x16\x03\x01\x00\x05\x01\x00", b"\x16\x03\x01\xff\xff" + b"\x01" * 50, os.urandom(40), b"\x16"):
    c = socket.create_connection(("127.0.0.1", port))
    c.sendall(junk)
    c.shutdown(socket.SHUT_WR)
    c.settimeout(3)
    try:
        c.recv(10)
    except OSError:
        pass
    c.close()
for sample in (b"", b"\x16", b"\x16\x03\x01\x00\x02\x01\x00", bytes(range(256))):
    sni.sni_of(sample)
got.pop("AP-err", None)  # s_client hangs up after the handshake: the fake ap's reply hits a closed pipe
check("garbage and truncated hellos: no crash, still serving", tls("trunk.example.org") == b"AP:hello-trunk")
check("no TLS errors at the access point after that", not got.get("AP-err"), got.get("AP-err"))
# 8. IPv6: a v6 client gets PROXY TCP6, a v4 client on the dual-stack socket gets TCP4
if have6:
    r = tls("trunk.example.org", host="::1", p=ports[1])
    pl = got.get("AP-proxy", [""])[-1]
    check("IPv6 client → access point, PROXY TCP6 ::1", r == b"AP:hello-trunk" and pl.startswith("PROXY TCP6 ::1 ::1 "), pl)
    r = tls("trunk.example.org", host="127.0.0.1", p=ports[1])
    pl = got.get("AP-proxy", [""])[-1]
    check("IPv4 client on the dual-stack [::] socket → PROXY TCP4 (not ::ffff:)", pl.startswith("PROXY TCP4 127.0.0.1 127.0.0.1 "), pl)
else:
    print("SKIP IPv6 (this machine has none)")
# 9. config errors are named
for bad, why in (("route x\n", "cannot read"), ("listen 0.0.0.0:443\n", "no 'default"), ("default nowhere\n", "not host:port")):
    p = os.path.join(TMP, "bad.conf")
    with open(p, "w") as f:
        f.write(bad)
    try:
        sni.load(p)
        check(f"config error refused: {bad.strip()!r}", False)
    except ValueError as e:
        check(f"config error refused: {bad.strip()!r} ({why})", why in str(e), str(e))
print("VERDICT:", "GREEN" if ok else "RED")
sys.exit(0 if ok else 1)
