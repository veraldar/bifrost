#!/usr/bin/env python3
"""trunk-roots-e2e.py — two REAL brains (yggdrasil) peering THROUGH the trunk, no tailnet,
no inbound port on the joined root. Deterministic on root/mock/mock_upstream.py.

Default: the root <-> root leg rides WireGuard end to end (trunk/src/wg.rs). Each root runs a
`bifrost-net wg` node; the brains only get URLs into it:

    hub box ──────────────────────────────────────────────────────┐        joined root ("mac")
    home brain  YGG_PEERS mac=http://127.0.0.1:<hub node>/_wg/mac   │        mac brain  YGG_PEERS home=http://127.0.0.1:<mac node>/_wg/local
      ▲ in-tunnel :80        hub node (key, roots.json pins mac)   │          ▲ in-tunnel :80   mac node (key; peer local = the hub's key)
      └── udp wg_local ⇄ wg_relay ── bifrost-net bridge ──dial OUT──▶ ap ◀──wss /rootlink── root-dial.py --wg-udp/--wg-node (binary frames)
                                         ▲ TAP: every byte of mac's link as the VPS hands it to the bridge ([ap] rootlink = the tap)

Walks the paths a deployment needs:
  * the joined root dials the ACCESS POINT (wss, test CA) at /rootlink — the box only dials out
  * MAIN on home runs `session_start … root=mac` → the session runs on the mac brain → its report
    comes home → home's GET /tree shows the proxy on root mac, status done; MAIN's inbox has it
  * the TAP: what the hub's bridge relays for root <-> root is WireGuard only — binary relay
    frames whose datagrams are WireGuard-shaped, no `http` op, no HTTP or brief/report text
  * the plaintext switchboard is refused (/_root/ on the bridge, a root's `local` peer port)
  * a root with a valid link but an UNAPPROVED key gets nothing; a stolen key on another link
    neither; a replayed and a tampered datagram are dropped while the calls go on
  * a phone-style turn (POST /branch, device token whose roots include mac) answered by the mac
    brain — one session per device, reused; a device without mac in its roots is refused
  * a second joined root ("lab"): mac and lab learn each other from the hub's directory (inside
    their tunnels), their brains learn each other (YGG_PEERS_FROM = their node's list), MAIN on
    mac runs a session on lab and the report comes back — through the hub's relay, which sees
    WireGuard only for the pair; a rogue that knows mac's key gets nothing; revoking lab drops it
  * revoking the approving device cuts the tunnel (both ways); restoring it brings it back;
    revoking the root (roots.json) cuts it again
  * --rekey: calls every 10 s for 200 s keep working across WireGuard's 120 s rekey timer
  * a bench: latency of GET /root and 1 MB each way, hub → mac

    trunk-roots-e2e.py [--bin-root PATH] [--bin-trunk PATH] [--direct] [--rekey] [--plaintext]
    --direct:    the root dials the root-link listener itself (no access point leg; the tap stays)
    --plaintext: the OLD path (switchboard http ops, bridge plaintext_http = true) — old roots,
                 and the bench's baseline
"""
import argparse, base64, hashlib, json, os, shutil, socket, statistics, struct, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.request
from rootlink_tap import Tap, relay_parts, wg_kind

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.realpath(os.path.join(HERE, ".."))
YGG = os.path.join(REPO, "root")
TRUNK = os.path.join(REPO, "trunk")
DIAL = os.path.join(TRUNK, "scripts", "root-dial.py")
NEVER = {4100, 4101, 4191, 8080, 8090, 8101, 8191, 4310, 4096, 8447} | set(range(7880, 7892))
FAILS = []
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
NET = "10.66.7"


def free_port(udp=False):
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM if udp else socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            p = s.getsockname()[1]
        if p not in NEVER and p + 1 not in NEVER:
            return p


def call(port, method, path, body=None, headers=None, timeout=30, raw=None):
    """(status, parsed json or raw text)"""
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"content-type": "application/json", **(headers or {})}
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers=h)
    try:
        with OPENER.open(r, timeout=timeout) as resp:
            raw_, st = resp.read(), resp.status
    except urllib.error.HTTPError as e:
        raw_, st = e.read(), e.code
    try:
        return st, json.loads(raw_) if raw_ else None
    except ValueError:
        return st, raw_.decode(errors="replace")


def req(port, method, path, body=None, timeout=30):
    st, v = call(port, method, path, body, timeout=timeout)
    if st >= 300:
        raise RuntimeError(f"{method} {path}: {st} {str(v)[:200]}")
    return v


def check(name, ok, detail=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else ' — ' + str(detail)[:400]}", flush=True)
    if not ok:
        FAILS.append(name)
    return ok


def wait(pred, timeout=30, step=0.3):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = pred()
            if v:
                return v
        except Exception:  # noqa: BLE001
            pass
        time.sleep(step)
    return None


def tool(calls):
    """A one-step tool script for the mock: [[name, args], ...] (tree-e2e.py's helper)."""
    return "tool:" + json.dumps([calls])


def bench(port, prefix, n=30):
    """(median ms, p90 ms) of GET <prefix>/root, then MB/s for 1 MB up (PUT) and down (GET)."""
    lat = []
    for _ in range(n):
        t = time.perf_counter()
        st, v = call(port, "GET", f"{prefix}/root")
        lat.append((time.perf_counter() - t) * 1000)
        if st != 200:
            return None
    lat.sort()
    blob = "x" * (1 << 20)
    t = time.perf_counter()
    st, v = call(port, "PUT", f"{prefix}/shared-prompt", {"prompt": blob}, timeout=120)
    up = (1 / (time.perf_counter() - t)) if st == 200 else 0
    t = time.perf_counter()
    st2, v2 = call(port, "GET", f"{prefix}/shared-prompt", timeout=120)
    down = (1 / (time.perf_counter() - t)) if st2 == 200 and isinstance(v2, dict) and len(v2.get("prompt", "")) == len(blob) else 0
    call(port, "PUT", f"{prefix}/shared-prompt", {"prompt": ""})
    return statistics.median(lat), lat[int(len(lat) * 0.9) - 1], up, down


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin-root", default=os.path.join(YGG, "target", "release", "yggdrasil"))
    ap.add_argument("--bin-trunk", default=os.path.join(TRUNK, "target", "release", "bifrost-net"))
    ap.add_argument("--direct", action="store_true", help="dial the root-link listener directly (no access point)")
    ap.add_argument("--rekey", action="store_true", help="also hold the tunnel across WireGuard's 120 s rekey (≈200 s)")
    ap.add_argument("--plaintext", action="store_true", help="the OLD path: switchboard http ops (plaintext_http = true)")
    ap.add_argument("--keep", action="store_true", help="keep the scratch dir")
    a = ap.parse_args()
    wg = not a.plaintext
    for b, d in ((a.bin_root, YGG), (a.bin_trunk, TRUNK)):
        if not os.path.exists(b):
            print(f"building {d} …", flush=True)
            subprocess.run(["cargo", "build", "--release"], cwd=d, check=True)
    tmp = tempfile.mkdtemp(prefix="trunk-roots-e2e-")
    procs, logs = {}, {}

    def spawn(name, cmd, env=None):
        logs[name] = os.path.join(tmp, f"{name}.log")
        procs[name] = subprocess.Popen(cmd, stdout=open(logs[name], "w"), stderr=subprocess.STDOUT,
                                       env={**os.environ, **(env or {})}, cwd=tmp)

    def log(name):
        return open(logs[name]).read() if name in logs and os.path.exists(logs[name]) else ""

    def keygen(name):
        out = subprocess.run([a.bin_trunk, "wg-key", os.path.join(tmp, f"{name}.key")], capture_output=True, text=True, check=True).stdout
        return {l.split(" = ")[0]: l.split('"')[1] for l in out.splitlines() if " = " in l}

    def node(name, udp, relay, http, brain, address=None, hub_pub=None, roots=False, key=None, extra=()):
        cfg = (f'[wg]\nkey_file = "{os.path.join(tmp, (key or name) + ".key")}"\nudp = "127.0.0.1:{udp}"\n'
               f'relay = "127.0.0.1:{relay}"\nhttp = "127.0.0.1:{http}"\n')
        if brain:
            cfg += f'brain = "http://127.0.0.1:{brain}"\n'
        if roots:
            cfg += f'roots_file = "{tmp}/roots.json"\ndevices_file = "{tmp}/devices.json"\n'
        if address:
            cfg += f'address = "{address}/24"\n\n[[wg.peer]]\nid = "local"\npublic_key = "{hub_pub}"\nip = "{NET}.1"\n'
        for pid, pub, ip in extra:
            cfg += f'\n[[wg.peer]]\nid = "{pid}"\npublic_key = "{pub}"\nip = "{ip}"\n'
        with open(os.path.join(tmp, f"wg-{name}.toml"), "w") as f:
            f.write(cfg)
        spawn(f"wg-{name}", [a.bin_trunk, "wg", "-c", os.path.join(tmp, f"wg-{name}.toml")])

    mock_p, home_p, mac_p, br_p, rl_p, peer_p, ap_p = (free_port() for _ in range(7))
    hub_wg, mac_wg, rogue_wg, thief_wg, lab_wg, lab_p = (free_port() for _ in range(6))
    hub_udp, relay_udp, mac_udp, mac_pipe, rogue_udp, rogue_pipe, thief_udp, thief_pipe, lab_udp, lab_pipe = (free_port(True) for _ in range(10))
    secret, peer_tok = os.urandom(16).hex(), "e2e-peer-" + os.urandom(6).hex()
    raw_phone, raw_other = "bfnd-" + os.urandom(18).hex(), "bfnd-" + os.urandom(18).hex()
    sha = lambda s: hashlib.sha256(s.encode()).hexdigest()

    def write_devices(phone_revoked=False):
        with open(os.path.join(tmp, "devices.json.tmp"), "w") as f:
            json.dump({"devices": [
                {"id": "dev_phone", "name": "phone", "tokenHash": sha(raw_phone), "created": "now", "revoked": phone_revoked, "roots": ["mac"]},
                {"id": "dev_other", "name": "other", "tokenHash": sha(raw_other), "created": "now", "revoked": False, "roots": []},
            ]}, f)
        os.replace(os.path.join(tmp, "devices.json.tmp"), os.path.join(tmp, "devices.json"))

    def write_roots(mac_pub, mac_revoked=False, lab_pub=None, lab_revoked=False):
        recs = []
        for rid, pub, ip, revoked in (("mac", mac_pub, 2, mac_revoked), ("lab", lab_pub, 3, lab_revoked)):
            if not pub:
                continue
            rec = {"id": rid, "name": rid, "os": "linux", "host": f"{rid}.local", "joined_at": "now", "dev": "dev_phone",
                   "secretHash": "0" * 64, "delivered_at": "now", "wg_pub": pub, "wg_ip": f"{NET}.{ip}"}
            if revoked:
                rec["revoked"] = True
            recs.append(rec)
        with open(os.path.join(tmp, "roots.json.tmp"), "w") as f:
            json.dump({"version": 1, "wg": {"net": f"{NET}.0/24"}, "roots": recs}, f)
        os.chmod(os.path.join(tmp, "roots.json.tmp"), 0o600)
        os.replace(os.path.join(tmp, "roots.json.tmp"), os.path.join(tmp, "roots.json"))

    try:
        # ---- the fake model, the access point, the device registry ----
        spawn("mock", [sys.executable, os.path.join(YGG, "mock", "mock_upstream.py"), str(mock_p)])
        cert = subprocess.run([a.bin_trunk, "ap-cert", os.path.join(tmp, "tls"), "localhost", "127.0.0.1"],
                              capture_output=True, text=True, check=True).stdout
        pin = [l.split('"')[1] for l in cert.splitlines() if l.startswith("pin =")][0]
        tok = subprocess.run([a.bin_trunk, "ap-token"], capture_output=True, text=True, check=True).stdout
        ap_tok = [l.split('"')[1] for l in tok.splitlines() if l.startswith("token =")][0]
        ap_hash = [l.split('"')[1] for l in tok.splitlines() if l.startswith("bridge_token_sha256 =")][0]
        with open(os.path.join(tmp, "ap.toml"), "w") as f:
            f.write(f'[ap]\nlisten = "127.0.0.1:{ap_p}"\ncert_path = "{tmp}/tls/cert.pem"\n'
                    f'key_path = "{tmp}/tls/key.pem"\nbridge_token_sha256 = "{ap_hash}"\n')
        if not a.direct:
            spawn("ap", [a.bin_trunk, "ap", "-c", os.path.join(tmp, "ap.toml")])
        write_devices()

        # ---- WireGuard keys: each root makes its own; the hub pins mac's (as an approval does) ----
        if wg:
            hub_k, mac_k, rogue_k, lab_k = keygen("hub"), keygen("mac"), keygen("rogue"), keygen("lab")
            shutil.copy(os.path.join(tmp, "mac.key"), os.path.join(tmp, "thief.key"))  # a stolen key
            check("keys are mode 600, the public half beside them",
                  all(os.stat(os.path.join(tmp, f"{n}.key")).st_mode & 0o777 == 0o600 and os.path.exists(os.path.join(tmp, f"{n}.key.pub"))
                      for n in ("hub", "mac", "rogue")), [oct(os.stat(os.path.join(tmp, f"{n}.key")).st_mode) for n in ("hub", "mac")])
            write_roots(mac_k["public_key"])

        # ---- two brains: home (the hub's) and mac (the joined root's) ----
        base = {"YGG_UPSTREAM_BASE_URL": f"http://127.0.0.1:{mock_p}", "YGG_UPSTREAM_STYLE": "anthropic",
                "YGG_UPSTREAM_API_KEY": "mock", "YGG_UPSTREAM_MODEL": "mock", "YGG_WAKE_DEBOUNCE_MS": "400",
                "YGG_PEER_TOKEN": peer_tok, "YGG_PROVIDERS": os.path.join(tmp, "no-providers.json"),
                "YGG_ARTIFACTS_DIR": os.path.join(tmp, "artifacts")}
        if wg:
            peers = {"home": f"mac=http://127.0.0.1:{hub_wg}/_wg/mac", "mac": f"home=http://127.0.0.1:{mac_wg}/_wg/local"}
            # a joined root's brain learns the other roots from its node (the hub's directory)
            learn = {"mac": {"YGG_PEERS_FROM": f"http://127.0.0.1:{mac_wg}/_wg/_roots", "YGG_PEERS_VIA": f"http://127.0.0.1:{mac_wg}/_wg/{{id}}"}}
        else:
            peers = {"home": f"mac=http://127.0.0.1:{br_p}/_root/mac", "mac": f"home=http://127.0.0.1:{peer_p}/local"}
            learn = {}
        for name, port in (("home", home_p), ("mac", mac_p)):
            d = os.path.join(tmp, name)
            os.makedirs(os.path.join(d, "work"))
            spawn(name, [a.bin_root], dict(base, YGG_LISTEN=f"127.0.0.1:{port}", YGG_DATA_DIR=os.path.join(d, "data"),
                                           YGG_PROFILES=os.path.join(d, "agents.json"), YGG_PROJECT_DIR=os.path.join(d, "work"),
                                           YGG_ROOT_NAME=name, YGG_PEERS=peers[name], **learn.get(name, {})))
        check("brains up", wait(lambda: req(home_p, "GET", "/root") and req(mac_p, "GET", "/root"), 15))

        # ---- the hub box: bridge (root-link + relay) dialing OUT to the ap; the hub's own node ----
        tap = Tap(rl_p)
        priv = [l.split('"')[1] for l in subprocess.run([a.bin_trunk, "keygen"], capture_output=True, text=True).stdout.splitlines()
                if "private_key" in l][0]
        cfg = f'''[node]
name = "hub"
private_key = "{priv}"

[bridge]
http = "127.0.0.1:{br_p}"
media = "127.0.0.1:{free_port()}"
tokens_file = "{tmp}/devices.json"
opencode_url = "http://127.0.0.1:{home_p}"
root_link_secret = "{secret}"

[bridge.root-link]
enabled = true
listen = "127.0.0.1:{rl_p}"
ping_secs = 5
result_secs = 120
'''
        cfg += f'wg_relay = "127.0.0.1:{relay_udp}"\nwg_local = "127.0.0.1:{hub_udp}"\n' if wg else "plaintext_http = true\n"
        if not a.direct:
            cfg += f'''
[ap]
url = "wss://127.0.0.1:{ap_p}/ap"
pin = "{pin}"
token = "{ap_tok}"
upstream = "127.0.0.1:{home_p}"
rootlink = "127.0.0.1:{tap.port}"
'''
        with open(os.path.join(tmp, "bridge.toml"), "w") as f:
            f.write(cfg)
        spawn("bridge", [a.bin_trunk, "bridge", "-c", os.path.join(tmp, "bridge.toml")])
        check("bridge up", wait(lambda: call(br_p, "GET", "/identity")[0] == 200, 10))
        if not a.direct:
            check("the box dialed OUT to the access point", wait(lambda: "channel up" in log("bridge"), 15), log("bridge")[-400:])
        if wg:
            node("hub", hub_udp, relay_udp, hub_wg, home_p, roots=True)
            node("mac", mac_udp, mac_pipe, mac_wg, mac_p, address=f"{NET}.2", hub_pub=hub_k["public_key"])
            check("both WireGuard nodes up; the hub pinned mac's key from roots.json",
                  wait(lambda: [p["id"] for p in req(hub_wg, "GET", "/_wg")] == ["mac"] and req(mac_wg, "GET", "/_wg")[0]["id"] == "local", 10)
                  and req(hub_wg, "GET", "/_wg")[0]["fingerprint"] == mac_k["fingerprint"], log("wg-hub")[-300:])

        # ---- the joined root: a link token (minted on the hub) + root-dial with its brain ----
        def dialer(name, root, dev, extra):
            tf = os.path.join(tmp, f"{name}.tokens")
            m = subprocess.run([a.bin_trunk, "rootlink", "mint", "--root", root, "--dev", dev, "--ttl", "3600",
                                "--secret", secret, "--out", tf], capture_output=True, text=True)
            d = ["--token-file", tf] + extra
            if a.direct:
                d = ["--host", "127.0.0.1", "--port", str(tap.port)] + d
            else:
                d = ["--host", "localhost", "--port", str(ap_p), "--tls", "--cafile", f"{tmp}/tls/cert.pem", "--path", "/rootlink"] + d
            spawn(name, [sys.executable, DIAL] + d)
            return m
        extra = ["--brain", f"http://127.0.0.1:{mac_p}", "--peer-port", str(peer_p)]
        if wg:
            extra += ["--wg-udp", f"127.0.0.1:{mac_pipe}", "--wg-node", f"127.0.0.1:{mac_udp}"]
        m = dialer("dial", "mac", "dev_phone", extra)
        check("link token minted for root mac", m.returncode == 0, m.stderr)
        linked = wait(lambda: "linked: mac" in log("dial"), 20)
        check(f"root mac linked {'directly' if a.direct else 'through the access point (wss /rootlink, verified TLS)'}",
              linked, log("dial")[-400:])
        if wg:
            up = wait(lambda: [p for p in req(hub_wg, "GET", "/_wg") if p["id"] == "mac" and p["up"]], 15)
            check("the WireGuard handshake completed through the relay (hub ⇄ mac)", up, log("wg-mac")[-300:])

        # ---- brain calls both ways ----
        if wg:
            st, v = call(hub_wg, "GET", "/_wg/mac/root")
            check("home → mac: /_wg/mac/root answered by the mac brain (inside WireGuard)", st == 200 and isinstance(v, dict) and v.get("name") == "mac", (st, v))
            st, v = call(mac_wg, "GET", "/_wg/local/root")
            check("mac → home: /_wg/local/root answered by the home brain (inside WireGuard)", st == 200 and isinstance(v, dict) and v.get("name") == "home", (st, v))
            st, v = call(mac_wg, "POST", "/_wg/local/tree/report", {"proxy": "nope", "event": {}})
            check("a report without x-ygg-peer is refused by home (the header is not invented)", st == 401, (st, v))
            st, v = call(mac_wg, "POST", "/_wg/local/tree/report", {"proxy": "nope", "event": {}}, {"x-ygg-peer": peer_tok})
            check("…and with it, it passes the token check (unknown proxy → 404)", st == 404, (st, v))
        else:
            st, v = call(br_p, "GET", "/_root/mac/root")
            check("home → mac: /_root/mac/root answered by the mac brain", st == 200 and isinstance(v, dict) and v.get("name") == "mac", (st, v))
            st, v = call(peer_p, "GET", "/local/root")
            check("mac → home: peer port /local/root answered by the home brain", st == 200 and isinstance(v, dict) and v.get("name") == "home", (st, v))
            st, v = call(peer_p, "POST", "/local/tree/report", {"proxy": "nope", "event": {}})
            check("a report without x-ygg-peer is refused by home (the header is not invented)", st == 401, (st, v))
            st, v = call(peer_p, "POST", "/local/tree/report", {"proxy": "nope", "event": {}}, {"x-ygg-peer": peer_tok})
            check("…and with it, it passes the token check (unknown proxy → 404)", st == 404, (st, v))

        # ---- MAIN on home starts a session on root mac ----
        main_id = req(home_p, "POST", "/session", {"title": "[MAIN]"})["id"]
        say = lambda text: req(home_p, "POST", f"/session/{main_id}/message", {"parts": [{"type": "text", "text": text}]}, 90)
        r = say(tool([["session_start", {"title": "on mac", "agent": "build", "brief": "Reply with exactly: MAC-DONE", "root": "mac"}]]))
        out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]["output"]
        check("MAIN's session_start ran on root mac", out.startswith("STARTED") and "on root mac" in out, out)
        t = {x["title"]: x for x in req(home_p, "GET", "/tree")}
        mac_tree = {x["title"]: x for x in req(mac_p, "GET", "/tree")}
        check("proxy on home, real session on mac", (t.get("on mac", {}).get("card") or {}).get("root") == "mac" and "on mac" in mac_tree,
              (t.get("on mac"), list(mac_tree)))
        proxy = t["on mac"]["id"]
        done = wait(lambda: ({x["title"]: x for x in req(home_p, "GET", "/tree")}["on mac"].get("card") or {}).get("status") == "done", 45)
        card = {x["title"]: x for x in req(home_p, "GET", "/tree")}["on mac"].get("card") or {}
        check("home's GET /tree: the proxy on root mac is done with the mac brain's result",
              done and card.get("root") == "mac" and "MAC-DONE" in (card.get("headline") or ""), card)
        inbox = wait(lambda: [e for e in req(home_p, "GET", f"/session/{main_id}/inbox") if e.get("from") == proxy], 20)
        check("MAIN's inbox has the report from root mac", bool(inbox), req(home_p, "GET", f"/session/{main_id}/inbox"))
        msgs = req(home_p, "GET", f"/session/{proxy}/message")
        check(f"reading the proxy reads the mac brain (through the {'tunnel' if wg else 'switchboard'})",
              any("MAC-DONE" in json.dumps(x.get("parts")) for x in msgs or []), (msgs or [])[-1:])

        # ---- the tap: what the hub's bridge relayed for root <-> root ----
        with tap.lock:
            frames = list(tap.frames)
        texts = [json.loads(p) for c, d, op, p in frames if op == 1]
        bins = [p for c, d, op, p in frames if op == 2]
        ops = sorted({v.get("op", "?") for v in texts})
        # what the relay can read: every frame, plus the bodies the old ops carry as base64
        payload = b"".join(p for _, _, _, p in frames) + b"".join(
            base64.b64decode(v.get("body_b64") or "") for v in texts if v.get("op") in ("http", "http.reply"))
        needles = [b"Reply with exactly: MAC-DONE", b"MAC-DONE", b"/tree/report", b"POST /session", b"GET /root",
                   b"x-ygg-peer", peer_tok.encode(), b"on mac"]
        leaked = [n.decode() for n in needles if n in payload]
        if wg:
            kinds = {}
            for p in bins:
                k = wg_kind(relay_parts(p)[1] or b"")
                kinds[k] = kinds.get(k, 0) + 1
            check(f"the tap: mac's link carried {len(bins)} binary frames, all WireGuard ({kinds})",
                  len(bins) > 20 and None not in kinds and kinds.get("data", 0) > 10 and kinds.get("init", 0) >= 1, kinds)
            check(f"the tap: no plaintext brain call crossed the relay (text ops seen: {ops})",
                  not ({"http", "http.reply"} & set(ops)) and not leaked, (ops, leaked))
        else:
            check(f"the tap (old path): brain calls cross the relay in PLAINTEXT ({len(leaked)} of {len(needles)} markers readable)",
                  "http" in ops and len(leaked) >= 4, (ops, leaked))

        # ---- the old plaintext path is refused (after the tap check: these probes are text ops) ----
        if wg:
            st, v = call(br_p, "GET", "/_root/mac/root")
            check("the plaintext switchboard is refused at the bridge (/_root/ → 403)", st == 403 and "WireGuard" in str(v), (st, v))
            st, v = call(peer_p, "GET", "/local/root")
            check("…and a root's plaintext `http` op too (peer port /local → 403)", st == 403 and "WireGuard" in str(v), (st, v))

        # ---- joined root <-> joined root: lab joins, mac and lab talk through the hub's relay ----
        if wg:
            write_roots(mac_k["public_key"], lab_pub=lab_k["public_key"])
            d = os.path.join(tmp, "lab")
            os.makedirs(os.path.join(d, "work"))
            spawn("lab", [a.bin_root], dict(base, YGG_LISTEN=f"127.0.0.1:{lab_p}", YGG_DATA_DIR=os.path.join(d, "data"),
                                            YGG_PROFILES=os.path.join(d, "agents.json"), YGG_PROJECT_DIR=os.path.join(d, "work"),
                                            YGG_ROOT_NAME="lab", YGG_PEERS=f"home=http://127.0.0.1:{lab_wg}/_wg/local",
                                            YGG_PEERS_FROM=f"http://127.0.0.1:{lab_wg}/_wg/_roots",
                                            YGG_PEERS_VIA=f"http://127.0.0.1:{lab_wg}/_wg/{{id}}"))
            node("lab", lab_udp, lab_pipe, lab_wg, lab_p, address=f"{NET}.3", hub_pub=hub_k["public_key"])
            n0 = len(tap.frames)
            dialer("dial-lab", "lab", "dev_phone", ["--brain", f"http://127.0.0.1:{lab_p}", "--wg-udp", f"127.0.0.1:{lab_pipe}",
                                                     "--wg-node", f"127.0.0.1:{lab_udp}"])
            ids = lambda port: [p["id"] for p in req(port, "GET", "/_wg/_roots")]
            check("lab linked; mac and lab learned each other from the hub's directory (inside their tunnels)",
                  wait(lambda: "linked: lab" in log("dial-lab") and ids(mac_wg) == ["lab"] and ids(lab_wg) == ["mac"], 30),
                  (ids(mac_wg), ids(lab_wg), log("wg-mac")[-300:]))
            check("…and their brains learned each other (YGG_PEERS_FROM = the node's list), no restart",
                  wait(lambda: "lab" in req(mac_p, "GET", "/root")["peers"] and "mac" in req(lab_p, "GET", "/root")["peers"], 30),
                  (req(mac_p, "GET", "/root")["peers"], req(lab_p, "GET", "/root")["peers"]))
            st, v = call(mac_wg, "GET", "/_wg/lab/root")
            st2, v2 = call(lab_wg, "GET", "/_wg/mac/root")
            check("mac → lab and lab → mac: brain calls through the hub's relay, inside WireGuard",
                  st == 200 and v.get("name") == "lab" and st2 == 200 and v2.get("name") == "mac", (st, v, st2, v2))
            mac_main = req(mac_p, "POST", "/session", {"title": "[MAIN]"})["id"]
            r = req(mac_p, "POST", f"/session/{mac_main}/message", {"parts": [{"type": "text", "text": tool(
                [["session_start", {"title": "on lab", "agent": "build", "brief": "Reply with exactly: LAB-DONE", "root": "lab"}]])}]}, 90)
            out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]["output"]
            done = wait(lambda: ({x["title"]: x for x in req(mac_p, "GET", "/tree")}.get("on lab", {}).get("card") or {}).get("status") == "done", 45)
            card = {x["title"]: x for x in req(mac_p, "GET", "/tree")}.get("on lab", {}).get("card") or {}
            check("MAIN on mac ran a session on lab; lab's report came back to mac (done, LAB-DONE)",
                  out.startswith("STARTED") and done and "LAB-DONE" in (card.get("headline") or ""), (out, card))
            with tap.lock:
                pair = [(c, d, op, p) for c, d, op, p in tap.frames[n0:] if tap.roots.get(c) in ("mac", "lab")]
            between = [(tap.roots[c], d, relay_parts(p)) for c, d, op, p in pair if op == 2 and relay_parts(p)[0] in ("mac", "lab")]
            kinds = {}
            for _, _, (addr, dg) in between:
                kinds[wg_kind(dg)] = kinds.get(wg_kind(dg), 0) + 1
            seen = b"".join(p for _, _, _, p in pair)
            leaked = [n for n in ("LAB-DONE", "Reply with exactly", "on lab", "/tree/report", "POST /session") if n.encode() in seen]
            text_ops = sorted({json.loads(p).get("op") for _, _, op, p in pair if op == 1})
            check(f"the tap: mac ↔ lab crossed the hub's bridge as {len(between)} WireGuard frames ({kinds}), nothing readable",
                  len(between) > 20 and None not in kinds and kinds.get("data", 0) > 10 and not leaked
                  and not ({"http", "http.reply"} & set(text_ops)), (kinds, leaked, text_ops))

        # ---- keys nobody approved, and a stolen key on another link ----
        if wg:
            # the rogue even knows mac's public key and address (keys are not secret): it still gets nothing
            node("rogue", rogue_udp, rogue_pipe, rogue_wg, None, address=f"{NET}.9", hub_pub=hub_k["public_key"],
                 extra=[("mac", mac_k["public_key"], f"{NET}.2")])
            node("thief", thief_udp, thief_pipe, thief_wg, None, address=f"{NET}.2", hub_pub=hub_k["public_key"], key="thief")
            dialer("dial-rogue", "rogue", "dev_other", ["--brain", f"http://127.0.0.1:{mac_p}", "--wg-udp", f"127.0.0.1:{rogue_pipe}",
                                                        "--wg-node", f"127.0.0.1:{rogue_udp}"])
            dialer("dial-thief", "thief", "dev_other", ["--brain", f"http://127.0.0.1:{mac_p}", "--wg-udp", f"127.0.0.1:{thief_pipe}",
                                                        "--wg-node", f"127.0.0.1:{thief_udp}"])
            check("rogue + thief linked (valid link tokens — the link is not the key)",
                  wait(lambda: "linked: rogue" in log("dial-rogue") and "linked: thief" in log("dial-thief"), 20))
            before = req(hub_wg, "GET", "/_wg/_node")["dropped"]
            st, v = call(rogue_wg, "GET", "/_wg/local/root", timeout=30)
            check("a root whose key was never approved gets nothing (504, its handshake dropped)", st == 504, (st, v))
            st, v = call(thief_wg, "GET", "/_wg/local/root", timeout=30)
            check("mac's key copied onto another link gets nothing either (504)", st == 504, (st, v))
            mac_before = req(mac_wg, "GET", "/_wg/_node")["dropped"]["unknown_key"]
            st, v = call(rogue_wg, "GET", "/_wg/mac/root", timeout=30)
            check("the rogue, knowing mac's key, straight at mac through the relay: refused by mac's node (504)",
                  st == 504 and req(mac_wg, "GET", "/_wg/_node")["dropped"]["unknown_key"] > mac_before, (st, v))
            after = req(hub_wg, "GET", "/_wg/_node")["dropped"]
            check("the hub's node counted them: unknown_key and wrong_link",
                  after["unknown_key"] > before["unknown_key"] and after["wrong_link"] > before["wrong_link"], (before, after))
            st, v = call(hub_wg, "GET", "/_wg/mac/root")
            check("…and mac's own tunnel is untouched", st == 200 and v.get("name") == "mac", (st, v))
            for n in ("dial-rogue", "dial-thief", "wg-rogue", "wg-thief"):
                procs[n].terminate()

            # ---- revoking lab (roots.json): the hub drops it, and so does mac (the directory) ----
            write_roots(mac_k["public_key"], lab_pub=lab_k["public_key"], lab_revoked=True)
            t0 = time.time()
            gone = wait(lambda: ids(mac_wg) == [] and call(mac_wg, "GET", "/_wg/lab/root")[0] == 502, 20)
            check(f"revoking lab: mac's node dropped it within {time.time() - t0:.0f} s (the hub's directory), mac → lab refused",
                  gone, ids(mac_wg))

            # ---- a replayed and a tampered datagram, injected on the relay path ----
            before = req(hub_wg, "GET", "/_wg/_node")["dropped"]
            ok = True
            for mode in ("replay", "tamper"):
                tap.inject = mode
                st, v = call(mac_wg, "PUT", "/_wg/local/shared-prompt", {"prompt": "y" * 200_000}, timeout=60)
                ok = ok and st == 200
            after = req(hub_wg, "GET", "/_wg/_node")["dropped"]
            check(f"replayed + tampered datagrams dropped by the hub's node ({tap.injected}), the calls still answered",
                  ok and tap.injected == ["replay", "tamper"] and after["replay"] > before["replay"] and after["auth_fail"] > before["auth_fail"],
                  (tap.injected, before, after))
            call(mac_wg, "PUT", "/_wg/local/shared-prompt", {"prompt": ""})

        # ---- the bench: hub → mac ----
        b = bench(hub_wg, "/_wg/mac") if wg else bench(br_p, "/_root/mac")
        if check("bench ran", b is not None):
            print(f"BENCH {'tunnel' if wg else 'plaintext switchboard'}{' (direct)' if a.direct else ' (through the ap)'}: "
                  f"GET /root median {b[0]:.1f} ms p90 {b[1]:.1f} ms · 1 MB up {b[2]:.1f} MB/s · 1 MB down {b[3]:.1f} MB/s", flush=True)

        # ---- a phone-style turn naming root mac ----
        bh = lambda raw: {"authorization": f"Bearer {raw}"}
        st, v = call(br_p, "POST", "/branch", {"op": "prompt", "id": "phone", "text": "Reply with exactly: PHONE-ON-MAC", "root": "mac"},
                     bh(raw_phone), timeout=150)
        check("phone turn (/branch, root mac) answered by the mac brain", st == 200 and isinstance(v, dict) and v.get("text") == "PHONE-ON-MAC"
              and v.get("root") == "mac", (st, v))
        st2, v2 = call(br_p, "POST", "/branch", {"op": "prompt", "id": "phone", "text": "Reply with exactly: PHONE-AGAIN", "root": "mac"},
                       bh(raw_phone), timeout=150)
        sessions = [s for s in req(mac_p, "GET", "/session") if s.get("title") == "trunk · dev_phone"]
        check("one session per device on the mac brain, reused", st2 == 200 and v2.get("text") == "PHONE-AGAIN" and len(sessions) == 1
              and v.get("session") == v2.get("session") == sessions[0]["id"], (st2, v2, sessions))
        st, v = call(br_p, "POST", "/branch", {"op": "prompt", "id": "phone", "text": "x", "root": "mac"}, bh(raw_other))
        check("a device whose roots do not include mac is refused", st == 403, (st, v))

        if wg and a.rekey:
            hs0 = req(hub_wg, "GET", "/_wg")[0]["handshakes"] + req(mac_wg, "GET", "/_wg")[0]["handshakes"]
            t0, bad, n = time.time(), [], 0
            while time.time() - t0 < 200:
                for port, path in ((hub_wg, "/_wg/mac/root"), (mac_wg, "/_wg/local/root")):
                    st, v = call(port, "GET", path)
                    n += 1
                    if st != 200:
                        bad.append((round(time.time() - t0), st))
                time.sleep(10)
            hs1 = req(hub_wg, "GET", "/_wg")[0]["handshakes"] + req(mac_wg, "GET", "/_wg")[0]["handshakes"]
            check(f"rekey: {n} calls over 200 s all answered across the 120 s rekey timer (handshakes {hs0} → {hs1})",
                  not bad and hs1 > hs0, bad)

        # ---- the hub's node restarts (a deploy, a crash): the tunnel comes back by itself ----
        if wg:
            procs["wg-hub"].terminate()
            procs["wg-hub"].wait(timeout=5)
            node("hub", hub_udp, relay_udp, hub_wg, home_p, roots=True)
            t0 = time.time()
            back = wait(lambda: call(mac_wg, "GET", "/_wg/local/root", timeout=15)[0] == 200
                        and call(hub_wg, "GET", "/_wg/mac/root", timeout=15)[0] == 200, 60, 1)
            check(f"the hub's node restarted: the tunnel came back by itself in {time.time() - t0:.0f} s (no root restarted)", back,
                  log("wg-hub")[-300:])

        # ---- revocation cuts the tunnel ----
        if wg:
            write_devices(phone_revoked=True)
            cut = wait(lambda: req(hub_wg, "GET", "/_wg") == [], 5)
            st, v = call(hub_wg, "GET", "/_wg/mac/root")
            st2, v2 = call(mac_wg, "GET", "/_wg/local/root", timeout=30)
            check("revoking the approving device cuts the tunnel: the hub drops mac, both directions fail",
                  cut is not None and st == 502 and st2 == 504, (st, v, st2, v2))
            check("…and the hub's log says so", "peer 'mac' REMOVED" in log("wg-hub"), log("wg-hub")[-300:])
            write_devices(phone_revoked=False)
            back = wait(lambda: call(hub_wg, "GET", "/_wg/mac/root")[0] == 200, 20, 1)
            check("restoring the device brings the tunnel back", back, call(hub_wg, "GET", "/_wg/mac/root"))
            write_roots(mac_k["public_key"], mac_revoked=True)
            cut = wait(lambda: req(hub_wg, "GET", "/_wg") == [], 5)
            st2, v2 = call(mac_wg, "GET", "/_wg/local/root", timeout=30)
            check("revoking the root (roots.json) cuts it again", cut is not None and st2 == 504, (st2, v2))
    finally:
        for name, p in reversed(list(procs.items())):
            p.terminate()
        for p in procs.values():
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        if FAILS:
            for name in ("bridge", "dial", "wg-hub", "wg-mac", "home", "mac", "ap"):
                if name in logs and os.path.exists(logs[name]):
                    print(f"--- {name}.log (tail)\n" + open(logs[name]).read()[-1500:])
        if a.keep:
            print(f"scratch kept: {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'GREEN' if not FAILS else 'RED'}: {len(FAILS)} failure(s) {FAILS if FAILS else ''}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
