#!/usr/bin/env python3
"""rootjoin.py — the stdlib half of join.sh: the hub's join API, the QR, link-token refill.

  rootjoin.py join  --state DIR --hub URL --name N --os OS --host H [--wg-pub KEY] [--qr-png P] [--open-qr] [--new]
  rootjoin.py refill --state DIR [--min 5] [--every SECS]
  rootjoin.py brain-env --state DIR --out FILE --listen ADDR --data DIR --project DIR --peer-port P [--upstream FILE]
  rootjoin.py wg-config --state DIR --out FILE --brain-port B --peer-port P   this root's WireGuard node config
                                           (prints changed|unchanged; exit 5 = the approval had no tunnel)
  rootjoin.py fetch-net --base URL --arch A --out FILE   the bifrost-net release asset, checked against SHA256SUMS
  rootjoin.py dial  --state DIR            KEY=value lines for the dialer: TLS HOST PORT PATH
  rootjoin.py get   --state DIR KEY        one non-secret field of root.json (root_id hub name rootlink_url hub_name)
  rootjoin.py qr    TEXT [--png P]         the QR in the terminal (and as a PNG)
  rootjoin.py probe URL                    exit 0 iff GET URL answers 2xx within 4 s (the dialer's health exec)

Every command that talks to the hub takes --cacert FILE (tests with a self-signed hub only; it is
also read from DIR/root.conf). Python >= 3.8, stdlib only (macOS's own python3 works).

The hub's join contract (client side):
  POST <hub>/api/roots/join {name, os, host, wg_pub}  -> 201 {req, secret, code, approve_url, poll_url, expires_in}
  GET  <poll_url>  x-join-secret: <secret>    -> 202 pending | 200 approved {root_id, root_secret,
       link_tokens, rootlink_url, peer_token, hub, wg?} (once) | 410 {status: refused|expired}
       `wg_pub` is this machine's WireGuard public key (bifrost-net wg-key; the private half never
       leaves DIR). The phone shows its fingerprint next to the code; approving pins it, and `wg`
       = {public_key, hub_ip, ip, net} (the hub's key + the tunnel addresses) comes back. Brain calls
       between roots then ride this root's own `bifrost-net wg` node (docs/spec-join.md).
       `hub` is the hub brain's root NAME: this root's brain peers with it as
       YGG_PEERS <hub>=http://127.0.0.1:<peer port>/local, so reports addressed to that name go home.
  POST <hub>/api/roots/<root_id>/tokens  x-root-secret  -> 200 {link_tokens}

Secrets (join secret, root secret, link tokens, peer token, upstream key) only ever go to files of
mode 600 in DIR and are never printed. Exit codes of `join`: 0 approved, 3 refused, 4 expired, 1 error.
"""
import json, os, re, shutil, ssl, struct, subprocess, sys, time, urllib.error, urllib.parse, urllib.request, zlib

EXIT_REFUSED, EXIT_EXPIRED = 3, 4
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SAFE_TOKEN = re.compile(r"^[!-~]{8,4096}$")          # printable, no whitespace: one token per line
MANAGED = ("YGG_LISTEN", "YGG_DATA_DIR", "YGG_PROJECT_DIR", "YGG_ROOT_NAME", "YGG_PEERS", "YGG_PEER_TOKEN",
           "YGG_PEERS_FROM", "YGG_PEERS_VIA")
WG_KEY = re.compile(r"^[A-Za-z0-9+/]{43}=$")


def wg_fingerprint(pub):
    """The fingerprint the phone shows: sha256(raw 32-byte key)[0..6], hex, xxxx-xxxx-xxxx."""
    import base64, hashlib
    h = hashlib.sha256(base64.b64decode(pub)).hexdigest()[:12]
    return "%s-%s-%s" % (h[0:4], h[4:8], h[8:12])


def good_wg(g):
    """The approval's `wg` grant, checked: {public_key, hub_ip, ip, net} or None."""
    import ipaddress
    if not isinstance(g, dict) or not isinstance(g.get("public_key"), str) or not WG_KEY.match(g["public_key"]):
        return None
    try:
        net = ipaddress.ip_network(str(g.get("net")), strict=True)
        ip, hub_ip = ipaddress.ip_address(str(g.get("ip"))), ipaddress.ip_address(str(g.get("hub_ip")))
    except ValueError:
        return None
    if net.version != 4 or not 8 <= net.prefixlen <= 30 or ip not in net or hub_ip not in net or ip == hub_ip:
        return None
    return {"public_key": g["public_key"], "hub_ip": str(hub_ip), "ip": str(ip), "net": str(net)}


def say(msg):
    print(msg, flush=True)


def fail(msg, code=1):
    print("rootjoin: " + msg, file=sys.stderr, flush=True)
    sys.exit(code)


# ------------------------------------------------------------------------------------- files
def write_private(path, text):
    """Atomic write, mode 600 from the first byte."""
    tmp = "%s.%d.tmp" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, text.encode())
    finally:
        os.close(fd)
    os.replace(tmp, path)


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def read_conf(state):
    """root.conf: plain KEY=value lines written by join.sh."""
    out = {}
    try:
        with open(os.path.join(state, "root.conf")) as f:
            for line in f:
                k, sep, v = line.rstrip("\n").partition("=")
                if sep and not k.startswith("#"):
                    out[k.strip()] = v
    except OSError:
        pass
    return out


def read_tokens(path):
    try:
        with open(path) as f:
            return [l.strip() for l in f if l.strip()]
    except OSError:
        return []


def write_tokens(path, toks):
    write_private(path, "".join(t + "\n" for t in toks))


def good_tokens(v):
    if not isinstance(v, list) or not all(isinstance(t, str) and SAFE_TOKEN.match(t) for t in v):
        return None
    return v


# -------------------------------------------------------------------------------------- http
class NetError(Exception):
    pass


def ssl_ctx(cafile):
    if cafile:
        return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


def http(method, url, cafile=None, body=None, headers=None, timeout=15):
    """-> (status, parsed JSON body or {}). Network trouble raises NetError."""
    data = json.dumps(body).encode() if body is not None else None
    h = {"accept": "application/json", "user-agent": "yggdrasil-root-join/1"}
    if data is not None:
        h["content-type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    ctx = ssl_ctx(cafile) if url.startswith("https:") else None
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except (urllib.error.URLError, OSError) as e:
        why = getattr(e, "reason", e)
        if isinstance(why, ssl.SSLCertVerificationError) or isinstance(e, ssl.SSLCertVerificationError):
            hint = ""
            if sys.platform == "darwin":
                hint = " (macOS python without CA certificates? brew install python, or run 'Install Certificates.command')"
            raise NetError("the TLS certificate of %s is not trusted: %s%s"
                           % (urllib.parse.urlsplit(url).netloc, getattr(why, "verify_message", why), hint))
        raise NetError("%s %s: %s" % (method, url.split("?")[0], why))
    try:
        parsed = json.loads(raw.decode() or "{}")
    except ValueError:
        parsed = {}
    return status, parsed if isinstance(parsed, dict) else {}


def hub_join(hub, path):
    return urllib.parse.urljoin(hub.rstrip("/") + "/", path.lstrip("/")) if not re.match(r"^[a-z]+://", path) else path


# -------------------------------------------------------------------------------------- join
def cmd_join(o):
    state, hub = o.state, o.hub.rstrip("/")
    os.makedirs(state, mode=0o700, exist_ok=True)
    pend_path, root_path = os.path.join(state, "pending.json"), os.path.join(state, "root.json")
    if os.path.exists(root_path) and not o.new:
        fail("already joined (%s) — join.sh --rejoin to join again" % root_path)
    if o.wg_pub and not WG_KEY.match(o.wg_pub):
        fail("--wg-pub is not a WireGuard public key")
    pend = load_json(pend_path)
    if pend and pend.get("hub") == hub and pend.get("deadline", 0) > time.time() + 5 and pend.get("wg_pub") == o.wg_pub:
        say("==> resuming the join request sent earlier (no new request)")
    else:
        say('==> asking %s to let "%s" join as a root (%s, host %s)' % (hub, o.name, o.os, o.host))
        body = {"name": o.name, "os": o.os, "host": o.host}
        if o.wg_pub:
            body["wg_pub"] = o.wg_pub
        try:
            st, ans = http("POST", hub_join(hub, "/api/roots/join"), o.cacert, body=body)
        except NetError as e:
            fail("cannot reach the hub: %s" % e)
        if st != 201:
            fail("the hub answered %d to the join request: %s" % (st, ans.get("error") or ans or "(no body)"))
        miss = [k for k in ("req", "secret", "code", "approve_url", "poll_url", "expires_in") if k not in ans]
        if miss:
            fail("the hub's join answer lacks %s" % ", ".join(miss))
        try:
            ttl = int(ans["expires_in"])
        except (TypeError, ValueError):
            fail("the hub's expires_in is not a number")
        pend = {"hub": hub, "req": str(ans["req"]), "secret": str(ans["secret"]), "code": str(ans["code"]),
                "approve_url": hub_join(hub, str(ans["approve_url"])), "poll_url": hub_join(hub, str(ans["poll_url"])),
                "deadline": time.time() + ttl, "name": o.name, "wg_pub": o.wg_pub or None}
        write_private(pend_path, json.dumps(pend, indent=1) + "\n")

    url = pend["approve_url"]
    say("")
    show_qr(url, o.qr_png, o.open_qr)
    say("")
    say("    Scan this QR with the phone that is already paired with your tree, and approve.")
    say("    Code (check it matches the phone):  %s" % pend["code"])
    if pend.get("wg_pub"):
        say("    Tunnel key (the phone shows it too): %s" % wg_fingerprint(pend["wg_pub"]))
    say("    Or open on that phone:              %s" % url)
    if o.qr_png:
        say("    QR picture:                         %s" % o.qr_png)
    say("")
    say("==> waiting for your approval (until %s; Ctrl-C to stop — re-run to resume)"
        % time.strftime("%H:%M:%S", time.localtime(pend["deadline"])))
    return poll(o, pend, pend_path, root_path)


def poll(o, pend, pend_path, root_path):
    interval = float(os.environ.get("JOIN_POLL_SECS", "2"))
    net_warned = False

    def done(code, msg):
        try:
            os.unlink(pend_path)
        except OSError:
            pass
        print(msg, file=sys.stderr if code else sys.stdout, flush=True)
        return code

    while True:
        if time.time() > pend["deadline"] + 30:
            return done(EXIT_EXPIRED, "xx  the join request expired before it was approved — run join.sh again for a new QR")
        try:
            st, ans = http("GET", pend["poll_url"], o.cacert, headers={"x-join-secret": pend["secret"]})
            net_warned = False
        except NetError as e:
            if not net_warned:
                print("!!  hub unreachable (%s) — still waiting" % e, file=sys.stderr, flush=True)
                net_warned = True
            time.sleep(min(interval * 3, 10))
            continue
        status = ans.get("status")
        if st == 202 or (st == 200 and status == "pending"):
            time.sleep(interval)
            continue
        if st == 200 and status == "approved":
            return save_approval(o, pend, ans, pend_path, root_path)
        if st == 410 or status in ("refused", "expired"):
            if status == "refused":
                return done(EXIT_REFUSED, "xx  the join was refused on the phone — nothing was installed")
            return done(EXIT_EXPIRED, "xx  the join request expired — run join.sh again for a new QR")
        if st == 404:
            return done(EXIT_EXPIRED, "xx  the hub no longer knows this join request (expired) — run join.sh again")
        if st in (401, 403):
            return done(1, "xx  the hub refused the join secret (%d) — run join.sh again" % st)
        print("!!  unexpected answer from the hub while waiting: %d %s" % (st, ans), file=sys.stderr, flush=True)
        time.sleep(interval * 2)


def hub_name_of(ans):
    """The hub brain's root name from the approval (`hub`). A hub that sends none, or the literal
    "local" (hubs before the name was sent: that was the switchboard's address, not a name), is
    called "hub" as before."""
    name = ans.get("hub")
    return "hub" if name in (None, "", "local") else name


def save_approval(o, pend, ans, pend_path, root_path):
    root_id, secret = ans.get("root_id"), ans.get("root_secret")
    toks = good_tokens(ans.get("link_tokens"))
    hub_name = hub_name_of(ans)
    if not (isinstance(root_id, str) and SAFE_ID.match(root_id)):
        fail("the hub's root_id %r is not a plain name" % (root_id,))
    if not (isinstance(secret, str) and secret):
        fail("the hub's approval has no root_secret")
    if toks is None:
        fail("the hub's link_tokens are not a list of tokens")
    if not (isinstance(hub_name, str) and SAFE_ID.match(hub_name)):
        fail("the hub's name %r is not a plain name" % (hub_name,))
    if hub_name == root_id:
        fail("the hub's name %r is this root's own id" % (hub_name,))
    link = ans.get("rootlink_url") or ""
    if not link:          # not given: the hub's own access point, /rootlink
        u = urllib.parse.urlsplit(pend["hub"])
        link = "%s://%s/rootlink" % ("wss" if u.scheme == "https" else "ws", u.netloc)
    if not re.match(r"^wss?://", link):
        fail("the hub's rootlink_url %r is not a ws:// or wss:// URL" % link)
    peer_token = ans.get("peer_token") or ""
    wg = good_wg(ans.get("wg")) if pend.get("wg_pub") else None
    if pend.get("wg_pub") and ans.get("wg") is not None and wg is None:
        fail("the hub's tunnel grant (wg) is malformed")
    root = {"hub": pend["hub"], "name": pend.get("name") or o.name, "root_id": root_id, "root_secret": secret,
            "rootlink_url": link, "peer_token": str(peer_token), "hub_name": hub_name,
            "joined_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    if pend.get("wg_pub"):
        root["wg_pub"] = pend["wg_pub"]           # the key this join sent (pinned on the phone)
    if wg:
        root["wg"] = wg
    write_tokens(os.path.join(o.state, "link-tokens"), toks)
    write_private(root_path, json.dumps(root, indent=1) + "\n")
    try:
        os.unlink(pend_path)
    except OSError:
        pass
    say("==> approved: this machine is root %r of the tree at %s (%d link token(s) saved)" % (root_id, pend["hub"], len(toks)))
    if pend.get("wg_pub") and not wg:
        say("!!  the hub runs no WireGuard node: brain calls with other roots use the old path for now")
    return 0


# ------------------------------------------------------------------------------------ refill
def cmd_refill(o):
    if not o.every:
        return refill_once(o)
    while True:                                       # the nohup supervisor's timer: one process, killable
        try:
            refill_once(o)
        except SystemExit:
            pass
        time.sleep(o.every)


def refill_once(o):
    import fcntl
    root = load_json(os.path.join(o.state, "root.json")) or fail("not joined: no root.json in %s" % o.state)
    tpath = os.path.join(o.state, "link-tokens")
    with open(os.path.join(o.state, ".refill.lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)              # the timer and a dialer start never refill twice
        have = read_tokens(tpath)
        if len(have) >= o.min:
            say("link tokens: %d left (>= %d, no refill)" % (len(have), o.min))
            return 0
        url = hub_join(root["hub"], "/api/roots/%s/tokens" % urllib.parse.quote(root["root_id"]))
        try:
            st, ans = http("POST", url, o.cacert, body={}, headers={"x-root-secret": root["root_secret"]})
        except NetError as e:
            fail("refill: cannot reach the hub: %s" % e)
        new = good_tokens(ans.get("link_tokens")) if st == 200 else None
        if new is None:
            fail("refill: the hub answered %d %s" % (st, ans.get("error") or ans.get("status") or ""))
        cur = read_tokens(tpath)                      # re-read: the dialer may have burned one meanwhile
        merged = cur + [t for t in new if t not in cur]
        write_tokens(tpath, merged)
        say("link tokens: %d left, +%d from the hub -> %d" % (len(cur), len(new), len(merged)))
    return 0


# --------------------------------------------------------------------------------- brain env
def parse_env_file(path):
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            k, sep, v = line.partition("=")
            k, v = k.strip(), v.strip()
            if not sep or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k):
                continue
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            out.append((k, v))
    return out


def cmd_brain_env(o):
    """Write the brain's env file: the upstream (kept, or from --upstream / YGG_UPSTREAM_* in the
    environment) + the managed lines from the join (once joined). Prints changed|unchanged; exit 5 = no upstream."""
    root = load_json(os.path.join(o.state, "root.json"))      # None before the join: upstream lines only
    kept = []
    if os.path.exists(o.out):
        kept = [(k, v) for k, v in parse_env_file(o.out) if k.startswith("YGG_") and k not in MANAGED]
    given = [(k, v) for k, v in os.environ.items() if k.startswith("YGG_UPSTREAM_") and v]
    if o.upstream:
        given += [(k, v) for k, v in parse_env_file(o.upstream) if k.startswith("YGG_") and k not in MANAGED]
    vals = dict(kept)
    order = [k for k, _ in kept]
    for k, v in given:
        if "\n" in v or "\r" in v:
            fail("%s holds a line break" % k)
        if k not in vals:
            order.append(k)
        vals[k] = v
    base = vals.get("YGG_UPSTREAM_BASE_URL", "")
    if not base:
        print("rootjoin: no model upstream: set YGG_UPSTREAM_BASE_URL (and _API_KEY, _MODEL) or pass --upstream-env FILE",
              file=sys.stderr)
        return 5
    if not re.match(r"^https?://", base):
        fail("YGG_UPSTREAM_BASE_URL must start with http:// or https://")
    lines = ["# yggdrasil-root brain — written by join.sh on every run. The upstream lines (and any other",
             "# YGG_* you add) are kept; the lines below the blank line come from the join and are rewritten.",
             "# After editing: re-run join.sh (or restart the brain service).", ""]
    lines += ["%s=%s" % (k, vals[k]) for k in order]
    if root:
        # the hub brain by its own name (reports go to report_to.root = that name), always through the
        # dialer's peer port to `local` — the trunk's word for the hub brain. A root.json from before the
        # name was kept (no hub_name) keeps the old name "hub".
        hub_name = root.get("hub_name") or "hub"
        if not SAFE_ID.match(hub_name) or hub_name == root["root_id"]:
            fail("root.json: the hub's name %r is not a plain name other than this root's" % (hub_name,))
        lines += ["", "YGG_LISTEN=%s" % o.listen, "YGG_DATA_DIR=%s" % o.data, "YGG_PROJECT_DIR=%s" % o.project,
                  "YGG_ROOT_NAME=%s" % root["root_id"]]
        if root.get("wg"):
            # the tunnel: the peer port is this root's WireGuard node; the hub brain inside it
            # (`local`), every other root of the tree learned from the node's list
            node = "http://127.0.0.1:%d/_wg" % o.peer_port
            lines += ["YGG_PEERS=%s=%s/local" % (hub_name, node), "YGG_PEERS_FROM=%s/_roots" % node,
                      "YGG_PEERS_VIA=%s/{id}" % node]
        else:
            lines += ["YGG_PEERS=%s=http://127.0.0.1:%d/local" % (hub_name, o.peer_port)]
        if root.get("peer_token"):
            lines.append("YGG_PEER_TOKEN=%s" % root["peer_token"])
    text = "\n".join(lines) + "\n"
    try:
        with open(o.out) as f:
            old = f.read()
    except OSError:
        old = None
    if old == text:
        os.chmod(o.out, 0o600)
        say("unchanged")
    else:
        write_private(o.out, text)
        say("changed")
    return 0


# -------------------------------------------------------------------------------- dial / get
def cmd_dial(o):
    root = load_json(os.path.join(o.state, "root.json")) or fail("not joined: no root.json in %s" % o.state)
    u = urllib.parse.urlsplit(root["rootlink_url"])
    tls = u.scheme == "wss"
    host, port = u.hostname or "", u.port or (443 if tls else 80)
    path = (u.path or "/") + ("?" + u.query if u.query else "")
    if not re.match(r"^[A-Za-z0-9.:-]+$", host):
        fail("rootlink host %r is not a plain host name" % host)
    if not re.match(r"^/[A-Za-z0-9/._~%=&?-]*$", path):
        fail("rootlink path %r has unexpected characters" % path)
    say("TLS=%d\nHOST=%s\nPORT=%d\nPATH=%s" % (1 if tls else 0, host, port, path))
    return 0


def cmd_get(o):
    if o.key == "pending_hub":                       # the hub of a join still waiting for approval, if any
        say((load_json(os.path.join(o.state, "pending.json")) or {}).get("hub", ""))
        return 0
    if o.key not in ("root_id", "hub", "name", "rootlink_url", "hub_name", "joined_at", "wg_pub", "tunnel"):
        fail("get: %s is not a readable field" % o.key)
    root = load_json(os.path.join(o.state, "root.json")) or fail("not joined: no root.json in %s" % o.state)
    if o.key == "tunnel":                            # 1 = the approval granted a WireGuard tunnel
        say("1" if root.get("wg") else "")
        return 0
    say(str(root.get(o.key) or ""))
    return 0


# ------------------------------------------------------------------------------ the tunnel
def cmd_wg_config(o):
    """This root's `bifrost-net wg` node: its key (DIR/wg.key), loopback ports, its one static peer
    (`local`, the hub's key from the approval). The hub's directory brings the other roots."""
    root = load_json(os.path.join(o.state, "root.json")) or fail("not joined: no root.json in %s" % o.state)
    g = good_wg(root.get("wg"))
    if not g:
        return 5
    prefix = g["net"].split("/")[1]
    text = ("# yggdrasil-root: this root's WireGuard node (bifrost-net wg) — written by join.sh on every run\n"
            "[wg]\nkey_file = \"%s\"\nudp = \"127.0.0.1:%d\"\nrelay = \"127.0.0.1:%d\"\nhttp = \"127.0.0.1:%d\"\n"
            "brain = \"http://127.0.0.1:%d\"\naddress = \"%s/%s\"\n\n[[wg.peer]]\nid = \"local\"\n"
            "public_key = \"%s\"\nip = \"%s\"\n") % (os.path.join(o.state, "wg.key"), o.peer_port, o.brain_port,
                                                       o.peer_port, o.brain_port, g["ip"], prefix, g["public_key"], g["hub_ip"])
    try:
        with open(o.out) as f:
            old = f.read()
    except OSError:
        old = None
    if old == text:
        say("unchanged")
    else:
        write_private(o.out, text)
        say("changed")
    return 0


def cmd_fetch_net(o):
    """bifrost-net-<ver>-linux-<arch> from a release (BASE/SHA256SUMS names it), checked, mode 755."""
    import hashlib
    base = o.base.rstrip("/")

    def get(url):
        req = urllib.request.Request(url, headers={"user-agent": "yggdrasil-root-join/1"})
        ctx = ssl_ctx(o.cacert) if url.startswith("https:") else None
        try:
            with urllib.request.urlopen(req, timeout=120, context=ctx) as r:
                return r.read()
        except (urllib.error.URLError, OSError) as e:
            fail("cannot download %s: %s" % (url, getattr(e, "reason", e)))
    sums = get(base + "/SHA256SUMS").decode(errors="replace")
    pat = re.compile(r"^([0-9a-f]{64})  (bifrost-net-[0-9][0-9A-Za-z.+-]*-linux-%s)$" % re.escape(o.arch))
    hit = next((m for m in map(pat.match, sums.splitlines()) if m), None)
    if not hit:
        fail("the release has no bifrost-net for linux-%s" % o.arch)
    want, asset = hit.groups()
    data = get("%s/%s" % (base, asset))
    if hashlib.sha256(data).hexdigest() != want:
        fail("%s does not match SHA256SUMS — refusing to install it" % asset)
    tmp = "%s.%d.tmp" % (o.out, os.getpid())
    with open(tmp, "wb") as f:
        f.write(data)
    os.chmod(tmp, 0o755)
    os.replace(tmp, o.out)
    say(asset)
    return 0


def cmd_probe(o):
    try:
        with urllib.request.urlopen(o.url, timeout=4) as r:
            return 0 if 200 <= r.status < 300 else 1
    except Exception as e:  # noqa: BLE001 — any failure means no pong
        print("probe %s: %s" % (o.url, e), file=sys.stderr)
        return 1


# ---------------------------------------------------------------------------------------- QR
def show_qr(text, png=None, open_it=False):
    """Terminal QR (qrencode -t ANSIUTF8 when present, else the pure-Python encoder) + PNG."""
    qrencode = None if os.environ.get("JOIN_NO_QRENCODE") else shutil.which("qrencode")
    printed = False
    if qrencode:
        r = subprocess.run([qrencode, "-t", "ANSIUTF8", "-m", "2", text], capture_output=True, text=True)
        if r.returncode == 0:
            sys.stdout.write(r.stdout)
            printed = True
    matrix = None
    if not printed:
        matrix = qr_matrix(text)
        say(qr_terminal(matrix))
    if png:
        os.makedirs(os.path.dirname(os.path.abspath(png)), exist_ok=True)
        ok = False
        if qrencode:
            ok = subprocess.run([qrencode, "-o", png, "-s", "8", "-m", "4", text]).returncode == 0
        if not ok:
            qr_png(matrix or qr_matrix(text), png)
        if open_it:
            open_file(png)


def open_file(path):
    """Show the PNG on this machine's screen (best effort, never fatal)."""
    try:
        if sys.platform == "darwin":
            cmd = ["open", path]
        elif os.environ.get("WSL_DISTRO_NAME") or "microsoft" in open("/proc/version").read().lower():
            win = subprocess.run(["wslpath", "-w", os.path.abspath(path)], capture_output=True, text=True).stdout.strip()
            cmd = ["explorer.exe", win]
        elif os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
            cmd = ["xdg-open", path]
        else:
            return
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         cwd="/", start_new_session=True)
    except Exception:  # noqa: BLE001
        pass


# QR code, byte mode, error correction level M — after Project Nayuki's reference algorithm.
_ECC_M = (-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
          26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28)
_BLOCKS_M = (-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
             17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49)


def _gf_mul(x, y):
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(deg):
    r, root = [0] * (deg - 1) + [1], 1
    for _ in range(deg):
        for j in range(deg):
            r[j] = _gf_mul(r[j], root)
            if j + 1 < deg:
                r[j] ^= r[j + 1]
        root = _gf_mul(root, 2)
    return r


def _rs_rem(data, div):
    r = [0] * len(div)
    for b in data:
        f = b ^ r.pop(0)
        r.append(0)
        for i, c in enumerate(div):
            r[i] ^= _gf_mul(c, f)
    return r


def _raw_modules(v):
    r = (16 * v + 128) * v + 64
    if v >= 2:
        n = v // 7 + 2
        r -= (25 * n - 10) * n - 55
        if v >= 7:
            r -= 36
    return r


def _penalty(m):
    n, p = len(m), 0
    for line in [list(r) for r in m] + [list(c) for c in zip(*m)]:
        run = 1
        for i in range(1, n + 1):
            if i < n and line[i] == line[i - 1]:
                run += 1
            else:
                if run >= 5:
                    p += run - 2
                run = 1
        s = "0000" + "".join("1" if c else "0" for c in line) + "0000"
        p += 40 * (s.count("00001011101") + s.count("10111010000"))
    for y in range(n - 1):
        for x in range(n - 1):
            if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                p += 3
    dark = sum(sum(1 for c in r if c) for r in m)
    total = n * n
    p += 10 * ((abs(dark * 20 - total * 10) + total - 1) // total - 1)
    return p


def qr_matrix(text):
    """-> square list of rows of bools (True = dark), no quiet zone."""
    data = text.encode("utf-8")
    for v in range(1, 41):
        cap = (_raw_modules(v) // 8 - _ECC_M[v] * _BLOCKS_M[v]) * 8
        cbits = 8 if v < 10 else 16
        if 4 + cbits + 8 * len(data) <= cap:
            break
    else:
        raise ValueError("text too long for a QR code")
    bits = []

    def put(val, n):
        bits.extend((val >> i) & 1 for i in range(n - 1, -1, -1))

    put(4, 4)
    put(len(data), cbits)
    for b in data:
        put(b, 8)
    put(0, min(4, cap - len(bits)))
    put(0, (-len(bits)) % 8)
    pad = 0xEC
    while len(bits) < cap:
        put(pad, 8)
        pad ^= 0xEC ^ 0x11
    words = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]

    nb, ecl, raw = _BLOCKS_M[v], _ECC_M[v], _raw_modules(v) // 8
    nshort, shortlen = nb - raw % nb, raw // nb
    div, blocks, k = _rs_divisor(ecl), [], 0
    for i in range(nb):
        d = words[k:k + shortlen - ecl + (0 if i < nshort else 1)]
        k += len(d)
        e = _rs_rem(d, div)
        if i < nshort:
            d = d + [0]
        blocks.append(d + e)
    cw = [b[i] for i in range(len(blocks[0])) for j, b in enumerate(blocks) if i != shortlen - ecl or j >= nshort]

    size = v * 4 + 17
    m = [[False] * size for _ in range(size)]
    fn = [[False] * size for _ in range(size)]

    def setf(x, y, dark):
        m[y][x], fn[y][x] = dark, True

    for i in range(size):
        setf(6, i, i % 2 == 0)
        setf(i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    setf(x, y, max(abs(dx), abs(dy)) not in (2, 4))
    if v > 1:
        n = v // 7 + 2
        step = (v * 8 + n * 3 + 5) // (n * 4 - 4) * 2
        pos = [6] + sorted(size - 7 - i * step for i in range(n - 1))
        for i, a in enumerate(pos):
            for j, b in enumerate(pos):
                if (i, j) in ((0, 0), (0, n - 1), (n - 1, 0)):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        setf(a + dx, b + dy, max(abs(dx), abs(dy)) != 1)

    def format_bits(mask):
        d = mask                      # level M = 0b00
        r = d
        for _ in range(10):
            r = (r << 1) ^ ((r >> 9) * 0x537)
        fb = ((d << 10) | r) ^ 0x5412

        def g(i):
            return (fb >> i) & 1 == 1
        for i in range(6):
            setf(8, i, g(i))
        setf(8, 7, g(6))
        setf(8, 8, g(7))
        setf(7, 8, g(8))
        for i in range(9, 15):
            setf(14 - i, 8, g(i))
        for i in range(8):
            setf(size - 1 - i, 8, g(i))
        for i in range(8, 15):
            setf(8, size - 15 + i, g(i))
        setf(8, size - 8, True)

    format_bits(0)
    if v >= 7:
        r = v
        for _ in range(12):
            r = (r << 1) ^ ((r >> 11) * 0x1F25)
        vb = (v << 12) | r
        for i in range(18):
            bit = (vb >> i) & 1 == 1
            a, b = size - 11 + i % 3, i // 3
            setf(a, b, bit)
            setf(b, a, bit)

    i, right = 0, size - 1
    while right >= 1:
        if right == 6:
            right = 5
        up = ((right + 1) & 2) == 0
        for vert in range(size):
            y = size - 1 - vert if up else vert
            for x in (right, right - 1):
                if not fn[y][x] and i < len(cw) * 8:
                    m[y][x] = (cw[i >> 3] >> (7 - (i & 7))) & 1 == 1
                    i += 1
        right -= 2

    masks = (lambda x, y: (x + y) % 2 == 0, lambda x, y: y % 2 == 0, lambda x, y: x % 3 == 0,
             lambda x, y: (x + y) % 3 == 0, lambda x, y: (x // 3 + y // 2) % 2 == 0,
             lambda x, y: x * y % 2 + x * y % 3 == 0, lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
             lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0)

    def apply(k):
        f = masks[k]
        for y in range(size):
            for x in range(size):
                if not fn[y][x] and f(x, y):
                    m[y][x] = not m[y][x]

    best = None
    for k in range(8):
        apply(k)
        format_bits(k)
        p = _penalty(m)
        if best is None or p < best[0]:
            best = (p, k)
        apply(k)
    apply(best[1])
    format_bits(best[1])
    return m


def qr_terminal(m, border=2):
    """Two modules per character cell (upper half block), black on white whatever the theme."""
    n = len(m)

    def dark(x, y):
        return 0 <= x < n and 0 <= y < n and m[y][x]
    out = []
    for y in range(-border, n + border, 2):
        out.append("".join("\x1b[%d;%dm\u2580" % (30 if dark(x, y) else 97, 40 if dark(x, y + 1) else 107)
                           for x in range(-border, n + border)) + "\x1b[0m")
    return "\n".join(out)


def qr_png(m, path, scale=8, border=4):
    n = len(m)
    side = (n + 2 * border) * scale
    rows = []
    for y in range(-border, n + border):
        line = b"".join((b"\x00" if 0 <= x < n and 0 <= y < n and m[y][x] else b"\xff") * scale
                        for x in range(-border, n + border))
        rows.extend([b"\x00" + line] * scale)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", side, side, 8, 0, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(png)
    os.replace(tmp, path)


def cmd_qr(o):
    show_qr(o.text, o.png, False)
    return 0


# -------------------------------------------------------------------------------------- main
def main(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="rootjoin.py", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd")
    sub.required = True

    def with_state(p):
        p.add_argument("--state", required=True)
        p.add_argument("--cacert")
        return p
    j = with_state(sub.add_parser("join"))
    for a in ("--hub", "--name", "--os", "--host"):
        j.add_argument(a, required=True)
    j.add_argument("--qr-png")
    j.add_argument("--open-qr", action="store_true")
    j.add_argument("--new", action="store_true", help="join again even if root.json exists")
    j.add_argument("--wg-pub", help="this machine's WireGuard public key (the approval pins it)")
    r = with_state(sub.add_parser("refill"))
    r.add_argument("--min", type=int, default=5)
    r.add_argument("--every", type=float, default=0, help="loop: refill, sleep SECS, forever")
    b = with_state(sub.add_parser("brain-env"))
    for a in ("--out", "--listen", "--data", "--project"):
        b.add_argument(a, required=True)
    b.add_argument("--peer-port", type=int, required=True)
    b.add_argument("--upstream")
    w = with_state(sub.add_parser("wg-config"))
    w.add_argument("--out", required=True)
    w.add_argument("--brain-port", type=int, required=True)
    w.add_argument("--peer-port", type=int, required=True)
    fn = sub.add_parser("fetch-net")
    for a in ("--base", "--arch", "--out"):
        fn.add_argument(a, required=True)
    fn.add_argument("--cacert")
    with_state(sub.add_parser("dial"))
    g = with_state(sub.add_parser("get"))
    g.add_argument("key")
    q = sub.add_parser("qr")
    q.add_argument("text")
    q.add_argument("--png")
    p = sub.add_parser("probe")
    p.add_argument("url")
    o = ap.parse_args(argv)
    if getattr(o, "state", None) and not o.cacert:
        o.cacert = read_conf(o.state).get("CACERT") or None
    return {"join": cmd_join, "refill": cmd_refill, "brain-env": cmd_brain_env, "dial": cmd_dial,
            "get": cmd_get, "qr": cmd_qr, "probe": cmd_probe, "wg-config": cmd_wg_config,
            "fetch-net": cmd_fetch_net}[o.cmd](o)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except AttributeError:
        pass
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\nstopped — re-run join.sh to resume", file=sys.stderr)
        sys.exit(130)
