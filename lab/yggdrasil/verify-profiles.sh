#!/usr/bin/env bash
# TOOL-SCOPE (10-28): session tool profiles against the mock upstream, both dialects.
# Default = today's root (build, 8 tools); YGG_PROFILES: listing, unknown/patch refusals,
# declared tools per profile, denials (tool, bash segment, redirect, path pattern, external),
# denial message + part metadata + bus event, no-tool profile (calls ignored, next anthropic
# turn still valid), rename round trip, legacy session under the default, a profile gone at
# restart (fail closed, blocked), a bad profiles file (exit 2). Ports 18290 / 14197 (14196 = root-store-backup.sh).
set -euo pipefail
cd "$(dirname "$0")"
source ~/.cargo/env
cargo build -q
exec python3 - <<'PY'
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.error

MOCK, PORT = 18290, 14197
BIN = os.path.abspath("target/debug/yggdrasil")
TMP = tempfile.mkdtemp(prefix="ygg-profiles-")
FAILS, PASSES = [], 0
procs = []

def ok(cond, label, detail=""):
    global PASSES
    if cond:
        PASSES += 1
    else:
        FAILS.append(label)
        print(f"FAIL {label} {detail}"[:600])

def http(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, method=method,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw else None)

PROFILES = {"default_agent": "build", "agent": {
    "build": {"description": "every tool", "permission": [{"permission": "*", "pattern": "*", "action": "allow"}]},
    "coordinator": {"description": "sessions + reading", "permission": [
        {"permission": "*", "pattern": "*", "action": "deny"},
        {"permission": "read", "pattern": "*", "action": "allow"},
        {"permission": "glob", "pattern": "*", "action": "allow"},
        {"permission": "grep", "pattern": "*", "action": "allow"},
        {"permission": "bash", "pattern": "echo *", "action": "allow"},
        {"permission": "bash", "pattern": "curl *127.0.0.1:*", "action": "allow"}]},
    "quiet": {"permission": [{"permission": "*", "pattern": "*", "action": "deny"}]},
    "renamed": {"permission": [{"permission": "*", "pattern": "*", "action": "allow"}],
                "override": {"bash": {"name": "shell", "description": "Run a shell command."}}},
    "docsonly": {"permission": [{"permission": "*", "pattern": "*", "action": "deny"},
                                {"permission": "read", "pattern": "docs/*", "action": "allow"},
                                {"permission": "edit", "pattern": "docs/*", "action": "allow"}]},
}}

def write_profiles(obj, name="profiles.json"):
    path = os.path.join(TMP, name)
    with open(path, "w") as f:
        f.write(obj if isinstance(obj, str) else json.dumps(obj))
    return path

def start(tag, style="openai", profiles=None, data=None, proj=None, expect_exit=False):
    data = data or os.path.join(TMP, f"data-{tag}")
    proj = proj or os.path.join(TMP, f"proj-{tag}")
    os.makedirs(proj, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith("YGG_")}
    env.update(YGG_UPSTREAM_BASE_URL=(f"http://127.0.0.1:{MOCK}/v1" if style == "openai" else f"http://127.0.0.1:{MOCK}"),
               YGG_UPSTREAM_STYLE=style, YGG_UPSTREAM_API_KEY="dummy", YGG_UPSTREAM_MODEL="mock",
               YGG_LISTEN=f"127.0.0.1:{PORT}", YGG_DATA_DIR=data, YGG_PROJECT_DIR=proj, YGG_ROLLUP_TOKENS="0",
               YGG_MAX_STEPS="6")
    if profiles:
        env["YGG_PROFILES"] = profiles
    log = open(os.path.join(TMP, f"srv-{tag}.log"), "w")
    p = subprocess.Popen([BIN], env=env, stdout=log, stderr=log)
    procs.append(p)
    if expect_exit:
        try:
            return p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            return None
    for _ in range(100):
        try:
            if http("GET", "/session")[0] == 200:
                return p
        except Exception:
            pass
        time.sleep(0.05)
    sys.exit(f"server {tag} did not come up; log: {open(log.name).read()[-800:]}")

def stop(p):
    p.terminate()
    p.wait(timeout=10)

def new(profile=None, **kw):
    body = dict(kw)
    if profile is not None:
        body["profile"] = profile
    return http("POST", "/session", body)

def say(sid, text):
    st, msg = http("POST", f"/session/{sid}/message", {"parts": [{"type": "text", "text": text}]}, timeout=60)
    reply = "".join(p.get("text", "") for p in (msg or {}).get("parts", []) if p.get("type") == "text")
    return st, reply, msg

def tool(calls):
    return "tool:" + json.dumps([calls])

def tool_parts(msg):
    return [p for p in (msg or {}).get("parts", []) if p.get("type") == "tool"]

mock = subprocess.Popen([sys.executable, "mock/mock_upstream.py", str(MOCK)],
                        stdout=subprocess.DEVNULL, stderr=open(os.path.join(TMP, "mock.log"), "w"))
procs.append(mock)
time.sleep(0.4)

try:
    # ---- A: no YGG_PROFILES = today's root ----
    srv = start("default")
    st, info = new()
    ok(st == 200 and info.get("profile") == "build", "A1 default session gets profile build", info)
    st, plist = http("GET", "/profile")
    ok(st == 200 and [p["name"] for p in plist] == ["build"] and plist[0]["default"] is True
       and plist[0]["permission"] == [{"permission": "*", "pattern": "*", "action": "allow"}], "A2 GET /profile builtin", plist)
    st, reply, _ = say(info["id"], tool([["bash", {"command": "echo a-ok"}]]))
    ok("TOOL-FINAL: a-ok" in reply and "[tools declared: 8]" in reply, "A3 bash runs, 8 tools declared", reply)
    st, reply, _ = say(info["id"], "tools?")
    ok(reply == "TOOLS: bash,read,write,edit,glob,grep,webfetch,todowrite", "A4 declared names unchanged", reply)
    st, agents = http("GET", "/agent")
    ok([a["name"] for a in agents] == ["build", "plan"] and all("permission" not in a for a in agents), "A5 GET /agent unchanged", agents)
    st, _ = new("coordinator")
    ok(st == 400, "A6 unknown profile on the builtin root -> 400")
    stop(srv)

    prof = write_profiles(PROFILES)
    for style in ("openai", "anthropic"):
        tag = style[:3]
        proj = os.path.join(TMP, f"proj-{tag}")
        os.makedirs(os.path.join(proj, "docs"), exist_ok=True)
        open(os.path.join(proj, "docs", "a.md"), "w").write("doc a\n")
        open(os.path.join(TMP, "outside.txt"), "w").write("secret\n")
        ev_path = os.path.join(TMP, f"events-{tag}.txt")
        srv = start(tag, style, prof, proj=proj)
        ev = subprocess.Popen(["curl", "-sN", f"http://127.0.0.1:{PORT}/event"], stdout=open(ev_path, "w"))
        procs.append(ev)
        time.sleep(0.2)

        st, plist = http("GET", "/profile")
        ok(st == 200 and sorted(p["name"] for p in plist) == ["build", "coordinator", "docsonly", "quiet", "renamed"]
           and [p["name"] for p in plist if p["default"]] == ["build"], f"{tag} B1 GET /profile", plist)
        st, body = new("nosuch")
        ok(st == 400 and "coordinator" in body.get("profiles", []) and "nosuch" in body.get("error", ""), f"{tag} B2 unknown -> 400 + list", body)
        st, body = new(7)
        ok(st == 400, f"{tag} B2b non-string profile -> 400", body)

        st, co = new("coordinator", title="coord")
        cid = co["id"]
        ok(st == 200 and co["profile"] == "coordinator", f"{tag} B3 coordinator created", co)
        st, body = http("PATCH", f"/session/{cid}", {"profile": "build"})
        ok(st == 400 and "fixed" in body.get("error", ""), f"{tag} B3b PATCH profile -> 400", body)
        st, body = http("PATCH", f"/session/{cid}", {"title": "coord2"})
        ok(st == 200 and body["title"] == "coord2" and body["profile"] == "coordinator", f"{tag} B3c PATCH title still fine", body)
        st, reply, _ = say(cid, "tools?")
        ok(reply == "TOOLS: bash,read,glob,grep", f"{tag} B3d coordinator declares 4 tools", reply)

        st, reply, msg = say(cid, tool([["write", {"filePath": "b4.txt", "content": "x"}]]))
        parts = tool_parts(msg)
        den = parts[0]["state"].get("metadata", {}).get("denied", {}) if parts else {}
        ok('Permission denied by profile "coordinator": edit `b4.txt` is denied' in reply
           and "Allowed in this session: bash (only: echo *, curl *127.0.0.1:*); read; glob; grep." in reply,
           f"{tag} B4 write denied, model told why + what works", reply)
        ok(not os.path.exists(os.path.join(proj, "b4.txt")), f"{tag} B4b no file written")
        ok(parts and parts[0]["tool"] == "write" and parts[0]["state"]["status"] == "error"
           and den.get("profile") == "coordinator" and den.get("permission") == "edit"
           and den.get("rule", {}).get("action") == "deny", f"{tag} B4c part error + metadata.denied", parts)

        st, reply, _ = say(cid, tool([["bash", {"command": "echo b5-ok"}]]))
        ok("TOOL-FINAL: b5-ok" in reply, f"{tag} B5 allowed bash runs", reply)
        st, reply, _ = say(cid, tool([["bash", {"command": "echo x && sed -i s/a/b/ docs/a.md"}]]))
        ok("bash `sed -i s/a/b/ docs/a.md` is denied" in reply and open(os.path.join(proj, "docs/a.md")).read() == "doc a\n",
           f"{tag} B6 chained segment denied, nothing ran", reply)
        st, reply, _ = say(cid, tool([["bash", {"command": "echo pwned > b7.txt"}]]))
        ok("edit `b7.txt` is denied" in reply and not os.path.exists(os.path.join(proj, "b7.txt")), f"{tag} B7 redirect = edit, denied", reply)
        st, reply, _ = say(cid, tool([["read", {"filePath": "docs/a.md"}]]))
        ok("doc a" in reply, f"{tag} B7b coordinator reads", reply)

        st, q = new("quiet")
        qid = q["id"]
        st, reply, _ = say(qid, "tools?")
        ok(reply == "TOOLS: ", f"{tag} B8 quiet declares no tools", reply)
        st, reply, msg = say(qid, tool([["bash", {"command": "touch quiet.txt"}]]))
        ok(st == 200 and "step 0." in reply and not tool_parts(msg) and not os.path.exists(os.path.join(proj, "quiet.txt")),
           f"{tag} B8b undeclared call ignored, not stored, not run", (st, reply))
        st, reply, _ = say(qid, "hello quiet")
        ok(st == 200 and reply.startswith("MOCK-REPLY"), f"{tag} B8c next turn valid (anthropic: no orphan tool blocks)", (st, reply))

        st, rn = new("renamed")
        rid = rn["id"]
        st, reply, _ = say(rid, "tools?")
        ok(reply == "TOOLS: shell,read,write,edit,glob,grep,webfetch,todowrite", f"{tag} B9 rename on the wire", reply)
        st, reply, msg = say(rid, tool([["shell", {"command": "echo renamed-ok"}]]))
        ok("TOOL-FINAL: renamed-ok" in reply and tool_parts(msg)[0]["tool"] == "shell", f"{tag} B9b shell runs bash, stored as called", reply)
        st, reply, _ = say(rid, tool([["bash", {"command": "echo x"}]]))
        ok("unknown tool: bash" in reply, f"{tag} B9c the canonical name is unknown here", reply)
        st, reply, _ = say(rid, "after rename")
        ok(st == 200 and reply.startswith("MOCK-REPLY"), f"{tag} B9d history with renamed calls replays", (st, reply))

        st, d = new("docsonly")
        did = d["id"]
        st, reply, _ = say(did, tool([["read", {"filePath": "docs/a.md"}]]))
        ok("doc a" in reply, f"{tag} B10 docs read allowed", reply)
        st, reply, _ = say(did, tool([["read", {"filePath": "docs/../../outside.txt"}]]))
        ok("Permission denied" in reply and "secret" not in reply, f"{tag} B10b traversal out of docs denied", reply)
        st, reply, _ = say(did, tool([["write", {"filePath": "docs/new.md", "content": "n"}]]))
        ok(os.path.exists(os.path.join(proj, "docs/new.md")), f"{tag} B10c docs write allowed", reply)
        st, reply, _ = say(did, tool([["write", {"filePath": "src/x.md", "content": "n"}]]))
        ok("edit `src/x.md` is denied" in reply and not os.path.exists(os.path.join(proj, "src/x.md")), f"{tag} B10d write outside docs denied", reply)

        st, dflt = new()
        st, reply, _ = say(dflt["id"], tool([["bash", {"command": "echo dflt-ok"}]]))
        ok(dflt["profile"] == "build" and "TOOL-FINAL: dflt-ok" in reply and "[tools declared: 8]" in reply, f"{tag} B11 default profile = every tool", reply)

        time.sleep(0.3)
        ev.terminate()
        evs = [json.loads(l[5:]) for l in open(ev_path) if l.startswith("data:")]
        denied_ev = [e for e in evs if e["type"] == "message.part.updated"
                     and e["properties"]["part"].get("state", {}).get("metadata", {}).get("denied")]
        created = [e for e in evs if e["type"] == "session.created" and e["properties"]["info"]["id"] == cid]
        ok(len(denied_ev) >= 4 and created and created[0]["properties"]["info"]["profile"] == "coordinator",
           f"{tag} B12 bus: denials on part events, profile on session.created", len(denied_ev))
        ok(not [e for e in evs if e["type"].startswith("permission")], f"{tag} B12b no new event type")
        stop(srv)

    # ---- C: restart semantics (openai) ----
    data = os.path.join(TMP, "data-c")
    os.makedirs(os.path.join(data, "session"), exist_ok=True)
    now = int(time.time() * 1000)
    legacy = {"info": {"id": "ses_legacy", "title": "pre-profile", "time": {"created": now, "updated": now}}, "messages": []}
    json.dump(legacy, open(os.path.join(data, "session", "ses_legacy.json"), "w"))
    strict = json.loads(json.dumps(PROFILES))
    strict["default_agent"] = "coordinator"
    srv = start("c1", profiles=write_profiles(strict, "strict.json"), data=data)
    st, reply, _ = say("ses_legacy", tool([["write", {"filePath": "legacy.txt", "content": "x"}]]))
    ok('denied by profile "coordinator"' in reply, "C1 legacy session runs under the current default", reply)
    st, rn = new("renamed")
    stop(srv)
    gone = json.loads(json.dumps(PROFILES))
    del gone["agent"]["renamed"]
    srv = start("c2", profiles=write_profiles(gone, "gone.json"), data=data)
    st, body = http("POST", f"/session/{rn['id']}/message", {"parts": [{"type": "text", "text": "hi"}]})
    _, states = http("GET", "/session/state")
    s = states.get(rn["id"], {})
    ok(st == 500 and "not configured" in json.dumps(body) and s.get("type") == "blocked" and s.get("reason") == "error",
       "C2 profile gone at restart -> fail closed, blocked", (st, body, s))
    stop(srv)
    for i, bad in enumerate(['{"agent":{"x":{"permission":[]}}}', "not json",
                             '{"agent":{"build":{"permission":[{"permission":"*","pattern":"*","action":"maybe"}]}}}']):
        rc = start(f"c3-{i}", profiles=write_profiles(bad, f"bad{i}.json"), expect_exit=True)
        ok(rc == 2, f"C3.{i} bad profiles file -> exit 2", rc)
    rc = start("c3-missing", profiles=os.path.join(TMP, "nope.json"), expect_exit=True)
    ok(rc == 2, "C3.m missing profiles file -> exit 2", rc)
finally:
    for p in procs:
        if p.poll() is None:
            p.terminate()
    for p in procs:
        try:
            p.wait(timeout=5)
        except Exception:
            p.kill()

print(f"profiles: {PASSES} checks passed, {len(FAILS)} failed")
if FAILS:
    print("logs in", TMP)
    sys.exit(1)
shutil.rmtree(TMP, ignore_errors=True)
print("PASS")
PY
