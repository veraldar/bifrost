#!/usr/bin/env python3
"""sni-443.py — one TCP port 443 for your website AND your yggdrasil trunk, shared by TLS name (SNI).

It reads the first bytes of every connection and forwards the connection, bytes untouched:
  * a TLS ClientHello naming a routed name  → that route's backend (with `proxy`: a PROXY v1 line
    first, so the backend learns the client's real address — the trunk's ap.toml proxy_protocol);
  * STUN / TURN over TCP (magic cookie 0x2112A442), when a `stun` backend is set → there;
  * anything else (other names, no name, plain http, garbage)               → the `default` backend.
TLS is never terminated here: every backend keeps its own certificate and key.

    sni-443.py -c /etc/yggdrasil-trunk/sni-443.conf

Config, one directive per line (# starts a comment):
    listen  0.0.0.0:443                  repeatable; [::]:443 listens on IPv6 (and IPv4, dual-stack)
    route   trunk.example.org 127.0.0.1:4443 proxy
    route   *.apps.example.org 127.0.0.1:9443     any name below apps.example.org
    default 127.0.0.1:8443               required
    stun    127.0.0.1:3478               optional
Names match without case and without a trailing dot. trunk/deploy/sni-443-test.py is its test.
"""
import ipaddress
import socket
import sys
import threading

MAGIC = b"\x21\x12\xa4\x42"
PEEK_SECS = 10
MAX_CONNS = 1024


def parse_addr(text):
    """'127.0.0.1:443' / '[::]:443' / 'host:443' → (host, port)."""
    host, sep, port = text.strip().rpartition(":")
    if not sep or not port.isdigit() or not host:
        raise ValueError(f"not host:port: {text!r}")
    return host.strip("[]"), int(port)


def load(path):
    """The config file → dict(listen=[addr], routes=[(name, addr, proxy)], default=addr, stun=addr|None)."""
    cfg = {"listen": [], "routes": [], "default": None, "stun": None}
    with open(path) as f:
        for n, raw in enumerate(f, 1):
            words = raw.split("#", 1)[0].split()
            if not words:
                continue
            try:
                key, args = words[0], words[1:]
                if key == "listen" and len(args) == 1:
                    cfg["listen"].append(parse_addr(args[0]))
                elif key == "route" and len(args) in (2, 3) and (len(args) == 2 or args[2] == "proxy"):
                    cfg["routes"].append((args[0].lower().rstrip("."), parse_addr(args[1]), len(args) == 3))
                elif key in ("default", "stun") and len(args) == 1:
                    cfg[key] = parse_addr(args[0])
                else:
                    raise ValueError(f"cannot read: {raw.strip()!r}")
            except ValueError as e:
                raise ValueError(f"{path}:{n}: {e}") from None
    if not cfg["default"]:
        raise ValueError(f"{path}: no 'default BACKEND' line (where your website's https goes)")
    if not cfg["listen"]:
        cfg["listen"].append(("0.0.0.0", 443))
    return cfg


def route_of(cfg, name):
    """(backend, proxy?) for a TLS server name (None = no name)."""
    if name:
        for pat, addr, proxy in cfg["routes"]:
            if name == pat or (pat.startswith("*.") and name.endswith(pat[1:]) and len(name) > len(pat) - 1):
                return addr, proxy
    return cfg["default"], False


def sni_of(rec):
    """The server name in a TLS record holding a ClientHello, or None."""
    try:
        if rec[0] != 0x16 or rec[5] != 0x01:
            return None
        p = 5 + 4 + 2 + 32  # record header, handshake header, version, random
        p += 1 + rec[p]  # session id
        p += 2 + int.from_bytes(rec[p:p + 2], "big")  # cipher suites
        p += 1 + rec[p]  # compression methods
        end = min(len(rec), p + 2 + int.from_bytes(rec[p:p + 2], "big"))
        p += 2
        while p + 4 <= end:
            kind, size = int.from_bytes(rec[p:p + 2], "big"), int.from_bytes(rec[p + 2:p + 4], "big")
            p += 4
            if kind == 0:  # server_name: list length, then (type, length, name)…
                q = p + 2
                while q + 3 <= min(end, p + size):
                    nt, nl = rec[q], int.from_bytes(rec[q + 1:q + 3], "big")
                    q += 3
                    if nt == 0:
                        return rec[q:q + nl].decode("ascii").lower().rstrip(".")
                    q += nl
                return None
            p += size
    except (IndexError, UnicodeDecodeError):
        pass
    return None


def recv_exact(sock, have, want):
    while len(have) < want:
        d = sock.recv(want - len(have))
        if not d:
            break
        have += d
    return have


def proxy_line(client):
    """PROXY v1 for this connection: the client's address as this router saw it."""
    (src, sport), (dst, dport) = client.getpeername()[:2], client.getsockname()[:2]
    a, b = ipaddress.ip_address(src), ipaddress.ip_address(dst)
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    if b.version == 6 and b.ipv4_mapped:
        b = b.ipv4_mapped
    if a.version != b.version:  # cannot happen on one socket; never send a half-truth
        return b"PROXY UNKNOWN\r\n"
    return f"PROXY TCP{a.version} {a} {b} {sport} {dport}\r\n".encode()


def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    for s in (a, b):
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        s.close()


def handle(cfg, client):
    """One connection: peek, pick the backend, forward both ways until either side closes."""
    client.settimeout(PEEK_SECS)
    try:
        peek = recv_exact(client, b"", 8)
        if not peek:
            client.close()
            return
        prefix = b""
        if len(peek) >= 8 and peek[4:8] == MAGIC and cfg["stun"]:
            backend = cfg["stun"]
        elif peek[0] == 0x16 and len(peek) >= 5:
            peek = recv_exact(client, peek, 5 + min(int.from_bytes(peek[3:5], "big"), 16384))
            backend, proxy = route_of(cfg, sni_of(peek))
            if proxy:
                prefix = proxy_line(client)
        else:
            backend = cfg["default"]
        upstream = socket.create_connection(backend, timeout=5)
    except OSError:
        try:
            client.close()
        except OSError:
            pass
        return
    # no timeout from here on: a websocket may sit idle for minutes (a 5 s connect timeout left on
    # the upstream socket once cut every idle trunk link)
    client.settimeout(None)
    upstream.settimeout(None)
    try:
        upstream.sendall(prefix + peek)
    except OSError:
        upstream.close()
        client.close()
        return
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    pipe(upstream, client)


def serve(cfg, ready=None):
    slots = threading.BoundedSemaphore(MAX_CONNS)
    socks = []
    for host, port in cfg["listen"]:
        fam = socket.AF_INET6 if ":" in host else socket.AF_INET
        s = socket.socket(fam, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if fam == socket.AF_INET6:
            s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        s.bind((host, port))
        s.listen(128)
        socks.append(s)
        print(f"sni-443: listening on {s.getsockname()[0]}:{s.getsockname()[1]}", file=sys.stderr, flush=True)
    for pat, (h, p), proxy in cfg["routes"]:
        print(f"sni-443: {pat} → {h}:{p}{' (PROXY v1)' if proxy else ''}", file=sys.stderr, flush=True)
    print(f"sni-443: everything else → {cfg['default'][0]}:{cfg['default'][1]}", file=sys.stderr, flush=True)
    if ready:
        ready([s.getsockname()[1] for s in socks])

    def accept(s):
        while True:
            try:
                c, _ = s.accept()
            except OSError:
                continue
            if not slots.acquire(blocking=False):
                c.close()
                continue

            def run(c=c):
                try:
                    handle(cfg, c)
                finally:
                    slots.release()
            threading.Thread(target=run, daemon=True).start()

    for s in socks[1:]:
        threading.Thread(target=accept, args=(s,), daemon=True).start()
    accept(socks[0])


def main(argv):
    if len(argv) != 2 or argv[0] != "-c":
        print(__doc__.split("\n\n")[0] + "\nusage: sni-443.py -c CONFIG", file=sys.stderr)
        return 64
    try:
        cfg = load(argv[1])
    except (OSError, ValueError) as e:
        print(f"sni-443: {e}", file=sys.stderr)
        return 1
    serve(cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
