#!/usr/bin/env python3
"""trunk-full-joiner.py — the NEW MACHINE of sim/trunk-full-e2e.sh (stdlib only).

Does what root/install/join.sh does on a machine that joins a hub's tree, against the hub's
PUBLIC URL (the access point, https, a self-signed test cert trusted with --cafile), from its
own address (--from):

  0. its WireGuard key: `bifrost-net wg-key wg.key` (mode 600, never leaves this machine)
  1. POST <hub>/api/roots/join {name, os, host, wg_pub} → join.json (req, code, approve_url, …,
     wg_pub, wg_fp — the fingerprint it prints next to the code, as join.sh would)
     + approve-qr.png (qrencode, as join.sh shows it on the machine's screen)
  2. poll <poll_url> with x-join-secret every 2 s    → root.json (root_id, rootlink_url, hub,
     peer_token, wg: the hub's key + the tunnel addresses) + link.tokens (20, mode 600)
  3. start this root's WireGuard node (bifrost-net wg: peer `local` = the hub's key), its brain
     (yggdrasil on the mock: YGG_ROOT_NAME = the root id, YGG_PEERS <hub>=http://127.0.0.1:<wg
     port>/_wg/local — inside the tunnel; `hub` is the hub brain's root name, from the join
     answer) and trunk/scripts/root-dial.py dialing the rootlink_url it was handed (wss through
     the access point, --cafile; --wg-udp/--wg-node carry the tunnel) → `linked` when up.
     An approval without `wg` (a hub without a node) falls back to the old peer port.

Then it stays up, supervising both, until SIGTERM. Every file lands in --state.

    trunk-full-joiner.py --state DIR --hub https://ap.tree.test --cafile cert.pem --from 203.0.113.9
        --name mac --brain-bin yggdrasil --mock-url http://127.0.0.1:P --brain-port P --peer-port P
        --net-bin bifrost-net --wg-port P --wg-udp P --wg-pipe P
"""
import argparse, http.client, json, os, signal, ssl, subprocess, sys, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.realpath(os.path.join(HERE, ".."))
DIAL = os.path.join(REPO, "trunk", "scripts", "root-dial.py")


def log(*a):
    print("joiner:", *a, flush=True)


def write(path, text, mode=0o644):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.rename(tmp, path)


def call(o, method, url, body=None, headers=None):
    """(status, json) — one HTTPS request from this machine's own address."""
    u = urllib.parse.urlsplit(url)
    ctx = ssl.create_default_context(cafile=o.cafile)
    c = http.client.HTTPSConnection(u.hostname, u.port or 443, context=ctx, timeout=30,
                                    source_address=(o.source, 0) if o.source else None)
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json", **(headers or {})} if data else dict(headers or {})
    c.request(method, u.path + (("?" + u.query) if u.query else ""), body=data, headers=h)
    r = c.getresponse()
    raw = r.read()
    c.close()
    try:
        return r.status, json.loads(raw) if raw else {}
    except ValueError:
        return r.status, {"raw": raw.decode(errors="replace")[:300]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True)
    ap.add_argument("--hub", required=True, help="the hub's public URL (the access point)")
    ap.add_argument("--cafile", required=True)
    ap.add_argument("--from", dest="source", default="")
    ap.add_argument("--name", default="mac")
    ap.add_argument("--os", default="macos")
    ap.add_argument("--host", default="mac-studio.local")
    ap.add_argument("--brain-bin", required=True)
    ap.add_argument("--mock-url", required=True)
    ap.add_argument("--brain-port", type=int, required=True)
    ap.add_argument("--peer-port", type=int, required=True)
    ap.add_argument("--net-bin", required=True, help="bifrost-net (the WireGuard node)")
    ap.add_argument("--wg-port", type=int, required=True, help="the node's front door")
    ap.add_argument("--wg-udp", type=int, required=True, help="the node's udp")
    ap.add_argument("--wg-pipe", type=int, required=True, help="the dialer's udp for the node")
    o = ap.parse_args()
    os.makedirs(o.state, exist_ok=True)
    kids = []

    def stop(*_):
        for p in kids:
            p.terminate()
        for p in kids:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    # 0. this root's WireGuard key — made here, only its public half leaves
    key = os.path.join(o.state, "wg.key")
    out = subprocess.run([o.net_bin, "wg-key", key], capture_output=True, text=True, check=True).stdout
    kv = {l.split(" = ")[0]: l.split('"')[1] for l in out.splitlines() if " = " in l}
    wg_pub, wg_fp = kv["public_key"], kv["fingerprint"]

    # 1. ask to join
    st, ans = call(o, "POST", o.hub.rstrip("/") + "/api/roots/join",
                   {"name": o.name, "os": o.os, "host": o.host, "wg_pub": wg_pub})
    if st != 201:
        write(os.path.join(o.state, "error"), f"join answered {st}: {ans}\n")
        log("join refused", st, ans)
        return 1
    write(os.path.join(o.state, "join.json"), json.dumps({**{k: ans[k] for k in ("req", "code", "approve_url", "poll_url", "expires_in")},
                                                          "wg_pub": wg_pub, "wg_fp": wg_fp}))
    qr = os.path.join(o.state, "approve-qr.png")
    subprocess.run(["qrencode", "-s", "6", "-m", "2", "-o", qr, ans["approve_url"]], check=True)
    log(f"asked {o.hub} to join as {o.name!r} — code {ans['code']}, tunnel key {wg_fp}, scan {qr}")

    # 2. wait for the owner's phone (poll no faster than every 2 s — the hub's burst guard)
    deadline = time.time() + float(ans.get("expires_in") or 600)
    got = None
    while time.time() < deadline:
        time.sleep(2)
        st, v = call(o, "GET", ans["poll_url"], headers={"x-join-secret": ans["secret"]})
        if st == 202:
            continue
        if st == 200 and v.get("status") == "approved":
            got = v
            break
        write(os.path.join(o.state, "error"), f"poll answered {st}: {v}\n")
        log("join ended", st, v)
        return 1
    if not got:
        write(os.path.join(o.state, "error"), "join expired while waiting\n")
        return 1
    toks = got.get("link_tokens") or []
    write(os.path.join(o.state, "link.tokens"), "".join(t + "\n" for t in toks), 0o600)
    root = {k: got.get(k) for k in ("root_id", "rootlink_url", "hub", "peer_token", "wg")}
    root["tokens"] = len(toks)
    root["root_secret_len"] = len(got.get("root_secret") or "")
    write(os.path.join(o.state, "root.json"), json.dumps(root), 0o600)
    log(f"approved: root {root['root_id']!r}, {len(toks)} link tokens, dial {root['rootlink_url']}")

    # 3. this root's WireGuard node, its brain + the dial-out to the trunk (through the access point)
    g = root.get("wg")
    if g:
        prefix = g["net"].split("/")[1]
        write(os.path.join(o.state, "wg.toml"),
              f'[wg]\nkey_file = "{key}"\nudp = "127.0.0.1:{o.wg_udp}"\nrelay = "127.0.0.1:{o.wg_pipe}"\n'
              f'http = "127.0.0.1:{o.wg_port}"\nbrain = "http://127.0.0.1:{o.brain_port}"\naddress = "{g["ip"]}/{prefix}"\n\n'
              f'[[wg.peer]]\nid = "local"\npublic_key = "{g["public_key"]}"\nip = "{g["hub_ip"]}"\n')
        kids.append(subprocess.Popen([o.net_bin, "wg", "-c", os.path.join(o.state, "wg.toml")],
                                     stdout=open(os.path.join(o.state, "wg.log"), "w"), stderr=subprocess.STDOUT))
        hub_peer = f"http://127.0.0.1:{o.wg_port}/_wg/local"      # inside the tunnel
    else:
        hub_peer = f"http://127.0.0.1:{o.peer_port}/local"        # the old plaintext switchboard
    data = os.path.join(o.state, "brain")
    os.makedirs(os.path.join(data, "work"), exist_ok=True)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": data,
           "YGG_UPSTREAM_BASE_URL": o.mock_url, "YGG_UPSTREAM_STYLE": "anthropic", "YGG_UPSTREAM_API_KEY": "mock",
           "YGG_UPSTREAM_MODEL": "mock", "YGG_WAKE_DEBOUNCE_MS": "400",
           "YGG_PROVIDERS": os.path.join(data, "no-providers.json"), "YGG_ARTIFACTS_DIR": os.path.join(data, "artifacts"),
           "YGG_LISTEN": f"127.0.0.1:{o.brain_port}", "YGG_DATA_DIR": os.path.join(data, "data"),
           "YGG_PROFILES": os.path.join(data, "agents.json"), "YGG_PROJECT_DIR": os.path.join(data, "work"),
           "YGG_ROOT_NAME": root["root_id"],
           # the hub brain by the name the join answered (reports go to that name), via `local`
           "YGG_PEERS": f"{root['hub'] or 'hub'}={hub_peer}",
           "YGG_PEER_TOKEN": root["peer_token"] or ""}
    kids.append(subprocess.Popen([o.brain_bin], env=env, stdout=open(os.path.join(o.state, "brain.log"), "w"),
                                 stderr=subprocess.STDOUT, cwd=data))
    u = urllib.parse.urlsplit(root["rootlink_url"])
    dial = [sys.executable, DIAL, "--host", u.hostname, "--port", str(u.port or (443 if u.scheme == "wss" else 80)),
            "--path", u.path or "/", "--token-file", os.path.join(o.state, "link.tokens"),
            "--brain", f"http://127.0.0.1:{o.brain_port}"]
    dial += ["--wg-udp", f"127.0.0.1:{o.wg_pipe}", "--wg-node", f"127.0.0.1:{o.wg_udp}"] if g else ["--peer-port", str(o.peer_port)]
    if u.scheme == "wss":
        dial += ["--tls", "--cafile", o.cafile]
    dlog = os.path.join(o.state, "dial.log")
    kids.append(subprocess.Popen(dial, stdout=open(dlog, "w"), stderr=subprocess.STDOUT))
    linked = False
    while True:
        for p in kids:
            if p.poll() is not None:
                write(os.path.join(o.state, "error"), f"{p.args[0]} exited {p.returncode}\n")
                log("a child exited", p.args, p.returncode)
                stop()
        if not linked and f"linked: {root['root_id']}" in open(dlog).read():
            linked = True
            write(os.path.join(o.state, "linked"), root["root_id"] + "\n")
            log(f"root {root['root_id']!r} linked through {o.hub}")
        time.sleep(0.3)


if __name__ == "__main__":
    sys.exit(main() or 0)
