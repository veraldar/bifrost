#!/usr/bin/env python3
"""root-dial.py — the ROOT-side dial-in client (stdlib only).

This is the program a root machine (e.g. the Mac Studio over tailnet)
runs to dial the trunk. It proves the AGENT loop, not just a socket:

  HEALTH LAW (v4c, sim3 GAP-B fix): the trunk's `root.ping` op is a
  probe of the root's AGENT PROCESS, not of this dial script — so the
  `root.pong` is EARNED by a trivial exec of the agent binary
  (`<first token of --exec> --version`, own thread, never queued behind
  a long job). If that exec fails or times out, NO pong is sent and the
  trunk counts a probe failure (3 → auto-unlink). A bare pong would
  prove only the dial script; an exec proves the agent can still run.

  JOB LAW: `root.job` frames exec the agent command (`--exec`, default
  `opencode run`) in a WORKER THREAD — the read loop keeps answering
  probes during multi-minute runs (the sim3 MEDIUM: inline exec starved
  the read loop, trunk reaped at ~32s). Replies ride
  `root.result{tid,ok,text}`.

  RECONNECT LAW: on ws close it reconnects with a FRESH token from
  --token-file (burn-as-read; single-use tokens never block a
  reconnect; takeover law makes the newest conn win).

  GUARD LAW: plaintext ws carries link tokens and turn text — dialing
  outside private ranges (RFC1918/CGNAT/ULA/loopback/link-local) is
  REFUSED unless --allow-plaintext is passed explicitly. TLS (--tls)
  always passes the guard: public wss is the SANCTIONED dial path.

  TLS LAW: --tls wraps the socket with client-side TLS BEFORE the ws
  handshake, SNI = --host. Verify against the system trust store, or
  skip verification with --insecure-skip (self-signed lab certs only).

Trunk config note (--listen law): [bridge.root-link].listen must be
settable to a non-loopback addr for Mac-over-tailnet dial-ins
(e.g. listen = "100.100.x.x:8473"); the default stays 127.0.0.1:port+1.
"""
import base64, ipaddress, json, os, queue, socket, ssl, struct, subprocess, sys, threading, time

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

USAGE = f"""usage: {os.path.basename(sys.argv[0])} --host HOST --port PORT --token-file FILE
       [--exec "opencode run"] [--probe-exec "opencode --version"]
       [--tls] [--insecure-skip] [--allow-plaintext] [--path /rootlink]

  --host/--port     trunk [bridge.root-link] listen address (default 127.0.0.1:8473)
  --path            ws resource path (default /; e.g. /rootlink behind a router)
  --token-file      one single-use link token per line (burn-as-read on each dial)
  --exec            agent command run per root.job (the turn text is appended)
  --probe-exec      trivial agent exec that must SUCCEED to earn each root.pong
                    (default: "<first token of --exec> --version"; a failed
                    probe exec sends NO pong — the trunk counts the failure)
  --tls             wrap the socket in client TLS before the ws handshake
                    (SNI = --host; verified against the system trust store)
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

def main():
    a = sys.argv[1:]
    def arg(n, d=None):
        return a[a.index(n) + 1] if n in a else d
    if "--help" in a or "-h" in a:
        print(USAGE)
        return
    host, port = arg("--host", "127.0.0.1"), int(arg("--port", "8473"))
    wpath = arg("--path", "/")          # ws resource path (caddy routes /rootlink* → trunk)
    tfile, default_exec = arg("--token-file"), arg("--exec", "opencode run")
    if not tfile:
        raise SystemExit("usage: root-dial.py --host HOST --port PORT --token-file FILE "
                         "[--exec ...] [--tls] [--insecure-skip] [--allow-plaintext]")
    use_tls = "--tls" in a
    insecure_skip = "--insecure-skip" in a
    allow_plaintext = "--allow-plaintext" in a
    if insecure_skip and not use_tls:
        raise SystemExit("--insecure-skip is meaningless without --tls")
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

    exec_cmd = default_exec.split()
    probe_cmd = (arg("--probe-exec") or f"{exec_cmd[0]} --version").split()
    while True:                               # reconnect-on-close loop
        token, left = fresh_token()
        try:
            s = socket.create_connection((host, port), timeout=10)
            s.settimeout(None)          # READ LAW: block forever — the trunk's
                                        # heartbeat (ping_secs) keeps the path
                                        # alive; a fixed timeout kills the conn
                                        # mid-job during long opencode runs
            if use_tls:
                ctx = ssl._create_unverified_context() if insecure_skip else ssl.create_default_context()
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
        try: run_ws(s, token, exec_cmd, probe_cmd)
        except (SystemExit, KeyboardInterrupt): raise
        except Exception as e:
            print(f"conn lost ({e!r}) — reconnecting with a fresh token", flush=True)
        finally:
            s.close()
        time.sleep(1)

def run_ws(s, token, exec_cmd, probe_cmd):
    lock = threading.Lock()                   # one writer at a time on the wire
    def send_text(t):
        with lock:
            p = t.encode(); m = os.urandom(4)
            mk = bytes(b ^ m[i % 4] for i, b in enumerate(p))
            h = bytes([0x81]); n = len(p)
            h += (bytes([0x80 | n]) if n < 126 else
                  bytes([0x80 | 126]) + struct.pack(">H", n)) if n < 65536 else \
                 bytes([0x80 | 127]) + struct.pack(">Q", n)
            s.sendall(h + m + mk)
    def send_op(op, ln):
        with lock:
            s.sendall(bytes([0x80 | op, 0x80 | ln]) + os.urandom(4) + b"\x00" * ln)
    buf = b""                                  # leftover bytes across frames
    def raw(n):
        nonlocal buf
        while len(buf) < n:
            c = s.recv(4096)
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
        if m:  # a masked frame on the server side is protocol error — skip it
            p = bytes(b ^ m[i % 4] for i, b in enumerate(p))
        return op, p

    send_text(json.dumps({"op": "root-link", "token": token}))
    op, p = frame()
    ack = json.loads(p) if op == 1 else None
    if not ack or ack.get("op") != "root-link.ok":
        raise SystemExit(f"link refused: {p[:160]!r}")
    print(f"linked: {ack.get('root')} gen_no={ack.get('gen_no')}", flush=True)

    jobs, probes = queue.Queue(), queue.Queue()

    def job_worker():                          # JOB LAW: exec OFF the read loop
        while True:
            v = jobs.get()
            if v is None:
                return
            body = v.get("body", {})
            try:
                r = subprocess.run(exec_cmd + [str(body.get("text", ""))],
                                   capture_output=True, text=True, timeout=300)
                ok, text = r.returncode == 0, r.stdout.strip() or r.stderr.strip()
            except Exception as e:
                ok, text = False, str(e)
            send_text(json.dumps({"op": "root.result", "tid": v["tid"],
                                  "ok": ok, "text": text}))

    def probe_worker():                        # HEALTH LAW: pong is EXEC-EARNED
        while True:
            v = probes.get()
            if v is None:
                return
            err = None
            try:
                r = subprocess.run(probe_cmd, capture_output=True,
                                   text=True, timeout=5)
                earned = r.returncode == 0
                if not earned:
                    err = f"exit {r.returncode}: {(r.stderr or r.stdout).strip()[:120]}"
            except Exception as e:
                earned, err = False, repr(e)
            if earned:
                send_text(json.dumps({"op": "root.pong"}))
            else:
                print(f"probe exec failed ({err}) — no pong sent, trunk "
                      f"counts the failure", file=sys.stderr)

    threading.Thread(target=job_worker, daemon=True).start()
    threading.Thread(target=probe_worker, daemon=True).start()

    while True:                               # the agent loop: ALWAYS reading
        op, p = frame()
        if op == 0x9: send_op(0xA, len(p))                     # ws ping → ws pong
        elif op == 0x8: raise ConnectionError("trunk sent CLOSE")
        elif op == 0xA: pass                                    # unsolicited pong
        elif op == 0x1:
            v = json.loads(p)
            o = v.get("op")
            if o == "root.ping":
                probes.put(v)                                  # earn the pong
            elif o == "root.job":
                jobs.put(v)                                    # exec never blocks this loop

if __name__ == "__main__":
    main()
