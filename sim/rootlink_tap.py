#!/usr/bin/env python3
"""rootlink_tap.py — a TCP tap on the root links, right where the hub's bridge takes them in.

The access point (the VPS) ends TLS and hands every `/rootlink` stream to the bridge; the bridge's
`[ap] rootlink = "127.0.0.1:<tap>"` sends them through this tap first, so it sees exactly what the
VPS and the bridge see, byte for byte. Every ws frame is recorded both ways, unmasked, per
connection; the root a connection belongs to is the `root` of its `root-link.ok` ack.

  as a module (sim/trunk-roots-e2e.py):  Tap(upstream_port) → .port, .frames [(conn, dir, op, payload)],
                                          .inject = "replay" | "tamper" (the next root → hub data frame)
  as a program (sim/trunk-full-e2e.sh):  rootlink_tap.py --listen PORT --upstream PORT --out DIR
      DIR/frames.jsonl  one line per frame {conn, root, dir, op, len, addr, kind, text_op}
      DIR/payload.bin   every unmasked payload, appended (what a reader of the relay could read)

`addr` / `kind`: a binary frame is a WireGuard relay frame [n][address][datagram] (trunk/src/wg.rs):
the address (towards the bridge: where it goes; from it: where it came from) and the WireGuard
message kind of the datagram (init/response/cookie/data, or null when it is not WireGuard-shaped).
"""
import argparse, json, os, socket, struct, threading


def wg_kind(d):
    if len(d) < 4 or d[1:4] != b"\0\0\0":
        return None
    return {1: "init" if len(d) == 148 else None, 2: "response" if len(d) == 92 else None,
            3: "cookie" if len(d) == 64 else None, 4: "data" if len(d) >= 32 else None}.get(d[0])


def relay_parts(p):
    """(address, datagram) of a relay frame, or (None, None)."""
    if not p or p[0] >= len(p):
        return None, None
    try:
        return p[1:1 + p[0]].decode(), p[1 + p[0]:]
    except UnicodeDecodeError:
        return None, None


class Tap:
    def __init__(self, upstream, listen=0, sink=None):
        self.up = upstream
        self.frames = []          # (conn, direction, opcode, payload)
        self.roots = {}           # conn -> root id (from its root-link.ok)
        self.lock = threading.Lock()
        self.inject = None
        self.injected = []
        self.sink = sink          # callback(conn, root, direction, opcode, payload)
        self.conns = 0
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", listen))
        self.srv.listen(16)
        self.port = self.srv.getsockname()[1]
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            try:
                u = socket.create_connection(("127.0.0.1", self.up))
            except OSError:
                c.close()
                continue
            for x in (c, u):
                x.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            with self.lock:
                self.conns += 1
                conn = self.conns
            threading.Thread(target=self._pump, args=(conn, c, u, "up"), daemon=True).start()
            threading.Thread(target=self._pump, args=(conn, u, c, "down"), daemon=True).start()

    @staticmethod
    def _frame(b):
        if len(b) < 2:
            return None
        op, masked, ln, at = b[0] & 0x0F, b[1] & 0x80, b[1] & 0x7F, 2
        if ln == 126:
            if len(b) < 4:
                return None
            ln, at = struct.unpack(">H", bytes(b[2:4]))[0], 4
        elif ln == 127:
            if len(b) < 10:
                return None
            ln, at = struct.unpack(">Q", bytes(b[2:10]))[0], 10
        mask = bytes(b[at:at + 4]) if masked else b"\0\0\0\0"
        at += 4 if masked else 0
        if len(b) < at + ln:
            return None
        p = bytes(b[at:at + ln])
        if masked and p:
            n = len(p)
            p = (int.from_bytes(p, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")).to_bytes(n, "big")
        return op, p, at + ln

    def _record(self, conn, d, op, p):
        with self.lock:
            if op == 1 and d == "down" and conn not in self.roots:
                try:
                    v = json.loads(p)
                    if v.get("op") == "root-link.ok":
                        self.roots[conn] = v.get("root")
                except ValueError:
                    pass
            self.frames.append((conn, d, op, p))
            root = self.roots.get(conn)
        if self.sink:
            self.sink(conn, root, d, op, p)

    def _pump(self, conn, src, dst, d):
        buf, head = bytearray(), False
        try:
            while True:
                chunk = src.recv(65536)
                if not chunk:
                    break
                buf += chunk
                if not head:
                    i = buf.find(b"\r\n\r\n")
                    if i < 0:
                        continue
                    dst.sendall(bytes(buf[:i + 4]))
                    del buf[:i + 4]
                    head = True
                out = bytearray()
                while True:
                    f = self._frame(buf)
                    if not f:
                        break
                    op, p, n = f
                    raw = bytes(buf[:n])
                    del buf[:n]
                    self._record(conn, d, op, p)
                    with self.lock:
                        mode = self.inject
                    addr, dgram = relay_parts(p) if op == 2 else (None, None)
                    if d == "up" and op == 2 and mode and addr == "local" and wg_kind(dgram) == "data" and len(p) > 120:
                        with self.lock:
                            self.inject = None
                            self.injected.append(mode)
                        if mode == "replay":
                            out += raw + raw
                        else:
                            r = bytearray(raw)
                            r[-5] ^= 0x5A          # inside the AEAD tag (masking is a XOR: it flips the same bit)
                            out += r
                        continue
                    out += raw
                if out:
                    dst.sendall(bytes(out))
        except OSError:
            pass
        finally:
            for s in (src, dst):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", type=int, required=True)
    ap.add_argument("--upstream", type=int, required=True)
    ap.add_argument("--out", required=True)
    o = ap.parse_args()
    os.makedirs(o.out, exist_ok=True)
    lock = threading.Lock()
    frames = open(os.path.join(o.out, "frames.jsonl"), "a", buffering=1)
    payload = open(os.path.join(o.out, "payload.bin"), "ab", buffering=0)

    def sink(conn, root, d, op, p):
        addr, dgram = relay_parts(p) if op == 2 else (None, None)
        text_op = None
        if op == 1:
            try:
                text_op = json.loads(p).get("op")
            except ValueError:
                text_op = "?"
        line = {"conn": conn, "root": root, "dir": d, "op": op, "len": len(p), "addr": addr,
                "kind": wg_kind(dgram) if dgram is not None else None, "text_op": text_op}
        with lock:
            frames.write(json.dumps(line) + "\n")
            payload.write(p)
    Tap(o.upstream, listen=o.listen, sink=sink)
    print(f"rootlink tap 127.0.0.1:{o.listen} → 127.0.0.1:{o.upstream}, frames in {o.out}", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
