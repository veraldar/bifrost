#!/usr/bin/env python3
"""trunk-roots-e2e.py — two REAL brains (yggdrasil) peering THROUGH the trunk, no tailnet,
no inbound port on the joined root. Deterministic on root/mock/mock_upstream.py.

    hub box ─────────────────────────────────────────────┐        joined root ("mac")
    home brain  YGG_PEERS mac=http://127.0.0.1:<bridge>/_root/mac   mac brain  YGG_PEERS home=http://127.0.0.1:<P>/local
      ▲  (`local`)                                       │          ▲
    bifrost-net bridge (root-link + switchboard) ──dial OUT──▶ ap (TLS edge) ◀──wss /rootlink── root-dial.py --brain --peer-port P

Walks the paths a deployment needs:
  * the joined root dials the ACCESS POINT (wss, test CA) at /rootlink — the box only dials out
  * the switchboard: home → mac (/_root/mac/…) and mac → home (peer port /local/…), x-ygg-peer kept
  * MAIN on home runs `session_start … root=mac` → the session runs on the mac brain → its report
    comes home → home's GET /tree shows the proxy on root mac, status done; MAIN's inbox has it
  * a phone-style turn (POST /branch, device token whose roots include mac) answered by the mac
    brain — one session per device, reused; a device without mac in its roots is refused

    trunk-roots-e2e.py [--bin-root PATH] [--bin-trunk PATH] [--direct]   exit 0 = all green
    --direct: the root dials the root-link listener itself (no access point leg)
"""
import argparse, hashlib, json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.realpath(os.path.join(HERE, ".."))
YGG = os.path.join(REPO, "root")
TRUNK = os.path.join(REPO, "trunk")
DIAL = os.path.join(TRUNK, "scripts", "root-dial.py")
NEVER = {4100, 4101, 4191, 8080, 8090, 8101, 8191, 4310, 4096} | set(range(7880, 7892))
FAILS = []
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def free_port():
    while True:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            p = s.getsockname()[1]
        if p not in NEVER and p + 1 not in NEVER:
            return p


def call(port, method, path, body=None, headers=None, timeout=30):
    """(status, parsed json or raw text)"""
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json", **(headers or {})}
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers=h)
    try:
        with OPENER.open(r, timeout=timeout) as resp:
            raw = resp.read()
            st = resp.status
    except urllib.error.HTTPError as e:
        raw, st = e.read(), e.code
    try:
        return st, json.loads(raw) if raw else None
    except ValueError:
        return st, raw.decode(errors="replace")


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin-root", default=os.path.join(YGG, "target", "release", "yggdrasil"))
    ap.add_argument("--bin-trunk", default=os.path.join(TRUNK, "target", "release", "bifrost-net"))
    ap.add_argument("--direct", action="store_true", help="dial the root-link listener directly (no access point)")
    ap.add_argument("--keep", action="store_true", help="keep the scratch dir")
    a = ap.parse_args()
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

    mock_p, home_p, mac_p, br_p, rl_p, peer_p, ap_p = (free_port() for _ in range(7))
    secret, peer_tok = os.urandom(16).hex(), "e2e-peer-" + os.urandom(6).hex()
    raw_phone, raw_other = "bfnd-" + os.urandom(18).hex(), "bfnd-" + os.urandom(18).hex()
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
        sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
        with open(os.path.join(tmp, "devices.json"), "w") as f:
            json.dump({"devices": [
                {"id": "dev_phone", "name": "phone", "tokenHash": sha(raw_phone), "created": "now", "revoked": False, "roots": ["mac"]},
                {"id": "dev_other", "name": "other", "tokenHash": sha(raw_other), "created": "now", "revoked": False, "roots": []},
            ]}, f)

        # ---- two brains: home (the hub's) and mac (the joined root's) ----
        base = {"YGG_UPSTREAM_BASE_URL": f"http://127.0.0.1:{mock_p}", "YGG_UPSTREAM_STYLE": "anthropic",
                "YGG_UPSTREAM_API_KEY": "mock", "YGG_UPSTREAM_MODEL": "mock", "YGG_WAKE_DEBOUNCE_MS": "400",
                "YGG_PEER_TOKEN": peer_tok, "YGG_PROVIDERS": os.path.join(tmp, "no-providers.json"),
                "YGG_ARTIFACTS_DIR": os.path.join(tmp, "artifacts")}
        peers = {"home": f"mac=http://127.0.0.1:{br_p}/_root/mac", "mac": f"home=http://127.0.0.1:{peer_p}/local"}
        for name, port in (("home", home_p), ("mac", mac_p)):
            d = os.path.join(tmp, name)
            os.makedirs(os.path.join(d, "work"))
            spawn(name, [a.bin_root], dict(base, YGG_LISTEN=f"127.0.0.1:{port}", YGG_DATA_DIR=os.path.join(d, "data"),
                                           YGG_PROFILES=os.path.join(d, "agents.json"), YGG_PROJECT_DIR=os.path.join(d, "work"),
                                           YGG_ROOT_NAME=name, YGG_PEERS=peers[name]))
        check("brains up", wait(lambda: req(home_p, "GET", "/root") and req(mac_p, "GET", "/root"), 15))

        # ---- the hub box: bridge (root-link + switchboard, local = home brain) dialing OUT to the ap ----
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
        if not a.direct:
            cfg += f'''
[ap]
url = "wss://127.0.0.1:{ap_p}/ap"
pin = "{pin}"
token = "{ap_tok}"
upstream = "127.0.0.1:{home_p}"
'''
        with open(os.path.join(tmp, "bridge.toml"), "w") as f:
            f.write(cfg)
        spawn("bridge", [a.bin_trunk, "bridge", "-c", os.path.join(tmp, "bridge.toml")])
        check("bridge up", wait(lambda: call(br_p, "GET", "/identity")[0] == 200, 10))
        if not a.direct:
            check("the box dialed OUT to the access point", wait(lambda: "channel up" in open(logs["bridge"]).read(), 15),
                  open(logs["bridge"]).read()[-400:])

        # ---- the joined root: a link token (minted on the hub) + root-dial with its brain ----
        tf = os.path.join(tmp, "mac.tokens")
        m = subprocess.run([a.bin_trunk, "rootlink", "mint", "--root", "mac", "--dev", "dev_phone", "--ttl", "3600",
                            "--secret", secret, "--out", tf], capture_output=True, text=True)
        check("link token minted for root mac", m.returncode == 0, m.stderr)
        dial = ["--token-file", tf, "--brain", f"http://127.0.0.1:{mac_p}", "--peer-port", str(peer_p)]
        if a.direct:
            dial = ["--host", "127.0.0.1", "--port", str(rl_p)] + dial
        else:
            dial = ["--host", "localhost", "--port", str(ap_p), "--tls", "--cafile", f"{tmp}/tls/cert.pem",
                    "--path", "/rootlink"] + dial
        spawn("dial", [sys.executable, DIAL] + dial)
        linked = wait(lambda: "linked: mac" in open(logs["dial"]).read(), 20)
        check(f"root mac linked {'directly' if a.direct else 'through the access point (wss /rootlink, verified TLS)'}",
              linked, open(logs["dial"]).read()[-400:])

        # ---- the switchboard both ways ----
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
        check("reading the proxy reads the mac brain (through the switchboard)", any("MAC-DONE" in json.dumps(x.get("parts")) for x in msgs or []),
              (msgs or [])[-1:])

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
    finally:
        for name, p in reversed(list(procs.items())):
            p.terminate()
        for p in procs.values():
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        if FAILS:
            for name in ("bridge", "dial", "home", "mac", "ap"):
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
