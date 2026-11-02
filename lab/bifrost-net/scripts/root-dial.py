#!/usr/bin/env python3
"""root-dial.py — the ROOT-side dial-in client (stdlib only, ~60 lines).

This is the program a root machine (e.g. the Mac Studio over tailnet)
runs to dial the trunk. It proves the AGENT loop, not just a socket:
it answers ws pings, answers the trunk's `root.ping` health probes with
`root.pong`, executes `root.job` frames via a local subprocess, and
replies `root.result{tid,ok,text}`. On ws close it reconnects with a
FRESH token from --token-file (single-use spent tokens never block a
reconnect; takeover law makes the newest conn win).

Trunk config note (--listen law): [bridge.root-link].listen must be
settable to a non-loopback addr for Mac-over-tailnet dial-ins
(e.g. listen = "100.100.x.x:8473"); the default stays 127.0.0.1:port+1.
"""
import base64, hashlib, hmac, json, os, socket, struct, subprocess, sys, time

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def main():
    a = sys.argv[1:]
    def arg(n, d=None):
        return a[a.index(n) + 1] if n in a else d
    host, port = arg("--host", "127.0.0.1"), int(arg("--port", "8473"))
    tfile, default_exec = arg("--token-file"), arg("--exec", "opencode run")

    def fresh_token():
        with open(tfile) as f:
            toks = [l.strip() for l in f if l.strip()]
        token, rest = toks[0], toks[1:]
        with open(tfile, "w") as f:          # fresh-token law: burn-as-read
            f.write("\n".join(rest) + ("\n" if rest else ""))
        return token, len(rest)

    exec_cmd = default_exec.split()
    while True:                               # reconnect-on-close loop
        token, left = fresh_token()
        s = socket.create_connection((host, port), timeout=10)
        s.sendall((f"GET / HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
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
        try: run_ws(s, token, exec_cmd)
        except (SystemExit, KeyboardInterrupt): raise
        except Exception as e:
            print(f"conn lost ({e!r}) — reconnecting with a fresh token", flush=True)
        finally:
            s.close()
        time.sleep(1)

def run_ws(s, token, exec_cmd):
    def send_text(t):
        p = t.encode(); m = os.urandom(4)
        mk = bytes(b ^ m[i % 4] for i, b in enumerate(p))
        h = bytes([0x81]); n = len(p)
        h += (bytes([0x80 | n]) if n < 126 else
              bytes([0x80 | 126]) + struct.pack(">H", n)) if n < 65536 else \
             bytes([0x80 | 127]) + struct.pack(">Q", n)
        s.sendall(h + m + mk)
    def send_op(op, ln):
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
    while True:                               # the agent loop
        op, p = frame()
        if op == 0x9: send_op(0xA, len(p))                     # ws ping → ws pong
        elif op == 0x8: raise ConnectionError("trunk sent CLOSE")
        elif op == 0xA: pass                                    # unsolicited pong
        elif op == 0x1:
            v = json.loads(p)
            o = v.get("op")
            if o == "root.ping":
                send_text(json.dumps({"op": "root.pong"}))     # HEALTH LAW answer
            elif o == "root.job":
                body = v.get("body", {})
                try:
                    r = subprocess.run(exec_cmd + [str(body.get("text", ""))],
                                       capture_output=True, text=True, timeout=300)
                    ok, text = r.returncode == 0, r.stdout.strip() or r.stderr.strip()
                except Exception as e:
                    ok, text = False, str(e)
                send_text(json.dumps({"op": "root.result", "tid": v["tid"],
                                      "ok": ok, "text": text}))

if __name__ == "__main__":
    main()
