#!/usr/bin/env python3
"""tree-e2e.py — deterministic end-to-end test of the root-coord tree on the mock upstream.

No LLM randomness: the mock answers scripted prompts (`tool:<json>` = scripted tool calls,
`reply with exactly: X`), so every assertion is exact. Boots a mock + two brains (home, lab)
on scratch ports, sandboxed, and walks the critical paths:

  start → child runs → digest card → inbox → door woken → MAIN speaks (internal turn hidden)
  lead nesting: grandchild reports to the lead, the lead reports the whole to MAIN
  session_send continues the same session · session_close archives a family
  the coordinator cannot run bash (profile enforced at dispatch)
  automation posted to MAIN lands in the inbox, never in the transcript
  a session started on another root: proxy here, real there, report flows home

    tree-e2e.py [--bin PATH]     exit 0 = all green
"""
import argparse
import time, json, os, shutil, subprocess, sys, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
YGG = os.path.join(HERE, "..", "root")
MOCK_PORT, HOME_PORT, LAB_PORT, LIB_PORT = 18197, 4187, 4188, 18310
LIBRARIAN = os.path.join(os.path.realpath(YGG), "extensions", "librarian", "librarian.py")
FAILS = []


def req(port, method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def check(name, ok, detail=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else ' — ' + str(detail)[:300]}", flush=True)
    if not ok:
        FAILS.append(name)


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
    """A one-step tool script for the mock: [[name, args], ...]."""
    return "tool:" + json.dumps([calls])


def tree(port):
    return {r["title"]: r for r in req(port, "GET", "/tree")}


def unit(name, cmd, env):
    subprocess.run(["systemctl", "--user", "stop", name], capture_output=True)
    subprocess.run(["systemctl", "--user", "reset-failed", name], capture_output=True)
    args = ["systemd-run", "--user", f"--unit={name}", "--collect", "-q"] + [f"--setenv={k}={v}" for k, v in env.items()] + cmd
    subprocess.run(args, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(YGG, "target", "release", "yggdrasil"))
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="tree-e2e-")
    units = ["tree-e2e-mock", "tree-e2e-home", "tree-e2e-lab", "tree-e2e-librarian"]
    try:
        unit(units[0], ["python3", os.path.join(YGG, "mock", "mock_upstream.py"), str(MOCK_PORT)], {})
        base = {"YGG_UPSTREAM_BASE_URL": f"http://127.0.0.1:{MOCK_PORT}", "YGG_UPSTREAM_STYLE": "anthropic", "YGG_UPSTREAM_API_KEY": "mock",
                "YGG_UPSTREAM_MODEL": "mock", "YGG_WAKE_DEBOUNCE_MS": "400", "YGG_PEER_TOKEN": "e2e-token"}
        # an extension outside the core: the librarian, indexing the home root
        unit(units[3], ["python3", LIBRARIAN, "--root", f"http://127.0.0.1:{HOME_PORT}", "--port", str(LIB_PORT),
                        "--db", os.path.join(tmp, "librarian.db"), "--poll", "1"], {})
        for name, port, other, oport in (("home", HOME_PORT, "lab", LAB_PORT), ("lab", LAB_PORT, "home", HOME_PORT)):
            d = os.path.join(tmp, name)
            os.makedirs(os.path.join(d, "work"))
            if name == "home":
                # saved while Gemini CLI was a harness (≤ 11-13): an agent and a session on it
                with open(os.path.join(d, "agents.json"), "w") as f:
                    json.dump({"agent": {"gem-old": {"harness": "gemini", "model": "gemini-3.5-flash", "description": "saved on Gemini CLI"}}}, f)
                os.makedirs(os.path.join(d, "data", "session"))
                now = int(time.time() * 1000)
                with open(os.path.join(d, "data", "session", "ses_gemold.json"), "w") as f:
                    json.dump({"info": {"id": "ses_gemold", "title": "gemini old", "agent": "gem-old", "time": {"created": now, "updated": now},
                                        "model": {"id": "gemini-3.5-flash", "providerID": "gemini"},
                                        "harness": {"kind": "gemini", "id": "5a0c1f9e-2b7d-4c55-9e0a-7f3b2d1c4e5f"}}, "messages": []}, f)
            # home reads Claude Code's sessions from a scratch config dir (one fake terminal session)
            extra = {"YGG_EXTENSIONS": f"librarian=http://127.0.0.1:{LIB_PORT}", "CLAUDE_CONFIG_DIR": os.path.join(tmp, "claude")} if name == "home" else {}
            unit(f"tree-e2e-{name}", [a.bin], dict(base, YGG_LISTEN=f"127.0.0.1:{port}", YGG_DATA_DIR=os.path.join(d, "data"), YGG_PROFILES=os.path.join(d, "agents.json"),
                 YGG_PROJECT_DIR=os.path.join(d, "work"), YGG_ROOT_NAME=name, YGG_PEERS=f"{other}=http://127.0.0.1:{oport}", **extra))
        check("brains up", wait(lambda: req(HOME_PORT, "GET", "/root") and req(LAB_PORT, "GET", "/root"), 10))
        main_id = req(HOME_PORT, "POST", "/session", {"title": "[MAIN]"})["id"]
        check("a new MAIN is stamped coordinator", req(HOME_PORT, "GET", f"/session/{main_id}").get("agent") == "coordinator")
        try:
            req(HOME_PORT, "POST", f"/api/session/{main_id}/agent", {"agent": "build"})
            check("MAIN cannot be switched off the coordinator", False, "accepted")
        except urllib.error.HTTPError as e:
            check("MAIN cannot be switched off the coordinator", e.code == 400, e.code)
        fix = req(HOME_PORT, "POST", "/session", {"title": "fix-main-1", "agent": "coordinator"})
        check("no second coordinator at creation", fix.get("agent") != "coordinator", fix.get("agent"))
        try:
            req(HOME_PORT, "POST", f"/api/session/{fix['id']}/agent", {"agent": "coordinator"})
            check("no switch to coordinator for a non-MAIN session", False, "accepted")
        except urllib.error.HTTPError as e:
            check("no switch to coordinator for a non-MAIN session", e.code == 400, e.code)
        say = lambda text: req(HOME_PORT, "POST", f"/session/{main_id}/message", {"parts": [{"type": "text", "text": text}]}, 60)

        # 1. start → report → wake
        r = say(tool([["session_start", {"title": "alpha", "agent": "build", "brief": "Reply with exactly: ALPHA-DONE"}]]))
        out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]["output"]
        check("session_start answers at once", out.startswith("STARTED"), out)
        t = tree(HOME_PORT)
        check("child under MAIN with its profile", t.get("alpha", {}).get("parentID") == main_id and t["alpha"]["agent"] == "build", t.get("alpha"))
        done = wait(lambda: (tree(HOME_PORT)["alpha"].get("card") or {}).get("status") == "done", 20)
        check("child card done with its result", done and "ALPHA-DONE" in (tree(HOME_PORT)["alpha"]["card"].get("headline") or ""), tree(HOME_PORT)["alpha"].get("card"))
        spoke = wait(lambda: [m for m in req(HOME_PORT, "GET", f"/session/{main_id}/message") if m["info"]["role"] == "assistant"][1:], 20)
        check("door woken: MAIN spoke without being asked", bool(spoke))
        vis = req(HOME_PORT, "GET", f"/session/{main_id}/message")
        check("the internal [inbox] turn is not in the transcript", not any("[inbox]" in json.dumps(m["parts"]) for m in vis if m["info"]["role"] == "user"))
        allm = req(HOME_PORT, "GET", f"/session/{main_id}/message?internal=1")
        check("…but it is stored for the agent", any("[inbox]" in json.dumps(m["parts"]) for m in allm if m["info"]["role"] == "user"))
        inbox = req(HOME_PORT, "GET", f"/session/{main_id}/inbox")
        check("inbox event delivered", inbox and inbox[-1]["from"] == t["alpha"]["id"] and inbox[-1]["delivered"] is True, inbox[-1:] if inbox else inbox)

        # 2. lead nesting
        lead_brief = tool([["session_start", {"title": "beta-1", "agent": "build", "brief": "Reply with exactly: B1-DONE"}]])
        say(tool([["session_start", {"title": "beta", "agent": "lead", "brief": lead_brief}]]))
        ok = wait(lambda: "beta-1" in tree(HOME_PORT) and (tree(HOME_PORT)["beta-1"].get("card") or {}).get("status") == "done", 30)
        t = tree(HOME_PORT)
        check("grandchild under the lead (depth 2)", ok and t["beta-1"]["parentID"] == t["beta"]["id"] and t["beta-1"]["depth"] == 2, {k: (v.get("parentID"), v.get("depth")) for k, v in t.items()})
        lead_inbox = wait(lambda: req(HOME_PORT, "GET", f"/session/{t['beta']['id']}/inbox"), 15)
        check("grandchild reported to the lead", lead_inbox and lead_inbox[0]["from"] == t["beta-1"]["id"], lead_inbox)
        main_from = lambda: {e["from"] for e in req(HOME_PORT, "GET", f"/session/{main_id}/inbox")}
        got = wait(lambda: t["beta"]["id"] in main_from(), 30)
        check("the lead reported the whole to MAIN", bool(got), main_from())
        check("the grandchild never reported to MAIN directly", t["beta-1"]["id"] not in main_from())

        # 3. follow-up to the same session
        r = say(tool([["session_send", {"id": "alpha", "message": "Reply with exactly: ALPHA-AGAIN"}]]))
        sent = [p for p in r["parts"] if p["type"] == "tool"]
        check("session_send accepted", sent and sent[0]["state"]["output"].startswith("SENT"), sent)
        again = wait(lambda: "ALPHA-AGAIN" in ((tree(HOME_PORT)["alpha"].get("card") or {}).get("headline") or ""), 20)
        check("session_send continues the same session", bool(again), tree(HOME_PORT)["alpha"].get("card"))
        check("no duplicate session for the follow-up", sum(1 for k in tree(HOME_PORT) if k.startswith("alpha")) == 1)

        # 4. close a family
        r = say(tool([["session_close", {"id": "beta", "reason": "e2e"}]]))
        t = tree(HOME_PORT)
        check("session_close archives the family", t["beta"]["archived"] and t["beta-1"]["archived"], (t["beta"]["archived"], t["beta-1"]["archived"]))

        # 4b. a running session is not closed to tidy up — only cancelled on purpose
        say(tool([["session_start", {"title": "slow", "agent": "build", "brief": "sleep 8 then Reply with exactly: SLOW-DONE"}]]))
        wait(lambda: tree(HOME_PORT)["slow"]["busy"], 10)
        r = say(tool([["session_close", {"id": "slow", "reason": "tidy"}]]))
        out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]["output"]
        check("closing a running session without cancel is refused", "still running" in out and not tree(HOME_PORT)["slow"]["archived"], out)
        r = say(tool([["session_close", {"id": "slow", "reason": "user cancelled", "cancel": True}]]))
        check("cancel=true stops and archives it", tree(HOME_PORT)["slow"]["archived"], tree(HOME_PORT)["slow"])

        # 5. the door cannot run bash
        r = say(tool([["bash", {"command": "echo pwned > /tmp/tree-e2e-pwned"}]]))
        out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]["output"]
        check("coordinator denied bash at dispatch", "permission denied" in out and not os.path.exists("/tmp/tree-e2e-pwned"), out)

        # 6. automation goes to the inbox, not the transcript
        before = len(req(HOME_PORT, "GET", f"/session/{main_id}/message"))
        r = req(HOME_PORT, "POST", f"/session/{main_id}/message", {"parts": [{"type": "text", "text": "LANE LANDED (auto-watch): lane x GREEN"}], "meta": {"auto": True}})
        check("automation POST answers at once with a msg id", r and r["info"]["id"].startswith("msg_"), r)
        check("automation not in MAIN's transcript", len(req(HOME_PORT, "GET", f"/session/{main_id}/message")) == before)
        check("automation filed in the inbox", wait(lambda: any(e["from"] == "external" for e in req(HOME_PORT, "GET", f"/session/{main_id}/inbox")), 15))

        # 6b. agents: read, create, refuse, switch (model stamped, tools enforced), harness, lock, delete
        agi = req(HOME_PORT, "GET", "/agent/AGI")
        check("AGI agent: Claude Code on Opus", agi["harness"] == "claude" and agi["model"] == "opus" and agi["builtin"], {k: agi.get(k) for k in ("harness", "model")})
        check("AGI offers Claude Code's models", {"opus", "sonnet", "haiku"} <= set(agi["models"]), agi.get("models"))
        try:
            req(HOME_PORT, "PUT", "/agent/AGI", {"model": "gpt-free-text"})
            check("a harness model must be one it offers", False, "accepted")
        except urllib.error.HTTPError as e:
            check("a harness model must be one it offers", e.code == 400, e.code)
        made = req(HOME_PORT, "PUT", "/agent/reader", {"description": "reads only", "tools": {"read": True}, "model": "mock", "variant": "low"})
        check("create an agent", made["tools"]["read"] and not made["tools"]["bash"] and made["harness"] == "root", made.get("tools"))
        try:
            req(HOME_PORT, "PUT", "/agent/reader", {"model": "gpt-nope"})
            check("a model this root does not serve is refused", False, "accepted")
        except urllib.error.HTTPError as e:
            check("a model this root does not serve is refused", e.code == 400, e.code)
        raw = json.load(open(os.path.join(tmp, "home", "agents.json")))
        check("agent edits persist to the agents file", raw["agent"]["reader"]["description"] == "reads only")
        sid = req(HOME_PORT, "POST", "/session", {"title": "switcher", "agent": "build"})["id"]
        req(HOME_PORT, "POST", f"/api/session/{sid}/agent", {"agent": "reader"})
        info = req(HOME_PORT, "GET", f"/session/{sid}")
        check("switching takes the agent's model + thinking", info["agent"] == "reader" and info["model"]["id"] == "mock" and info["model"]["variant"] == "low", info["model"])
        r = req(HOME_PORT, "POST", f"/session/{sid}/message", {"parts": [{"type": "text", "text": tool([["bash", {"command": "echo hi"}]])}]}, 60)
        out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]["output"]
        check("the switched agent's tools are enforced", "permission denied" in out, out)
        req(HOME_PORT, "POST", f"/api/session/{sid}/agent", {"agent": "AGI"})
        info = req(HOME_PORT, "GET", f"/session/{sid}")
        check("switching to AGI moves the session onto Claude Code", info["model"] == {"id": "opus", "providerID": "claude"} and info["harness"]["kind"] == "claude", (info["model"], info.get("harness")))
        req(HOME_PORT, "POST", f"/session/{sid}/model".replace("/session/", "/api/session/"), {"model": {"id": "sonnet", "providerID": "claude"}})
        check("a Claude Code session can change model within Claude's", req(HOME_PORT, "GET", f"/session/{sid}")["model"] == {"id": "sonnet", "providerID": "claude"})
        try:
            req(HOME_PORT, "POST", f"/api/session/{sid}/model", {"model": {"id": "gpt-x", "providerID": "claude"}})
            check("…and only within Claude's models", False, "accepted")
        except urllib.error.HTTPError as e:
            check("…and only within Claude's models", e.code == 400, e.code)
        agi2 = req(HOME_PORT, "GET", "/agent/AGI")
        check("model labels for the picker", agi2["model_labels"]["claude"]["opus"].startswith("strongest"), agi2.get("model_labels", {}).get("claude"))

        # 6c. continue a Claude Code session from the phone: the list (metadata only), attach, refusals
        cc_id, cc_cwd = "0f1e2d3c-4b5a-4968-8776-655443322110", os.path.join(tmp, "home", "work", "proj")
        os.makedirs(cc_cwd)
        pdir = os.path.join(tmp, "claude", "projects", "".join(c if c.isascii() and c.isalnum() else "-" for c in cc_cwd))
        os.makedirs(pdir)
        lines = [{"type": "user", "cwd": cc_cwd, "sessionId": cc_id, "message": {"role": "user", "content": "remember the word walrus; reply ok"}},
                 {"type": "assistant", "cwd": cc_cwd, "message": {"content": [{"type": "text", "text": "ok"}]}},
                 {"type": "user", "cwd": cc_cwd, "message": {"role": "user", "content": [{"type": "tool_result", "content": "TOOL-OUTPUT-NEVER-LISTED"}]}}]
        with open(os.path.join(pdir, cc_id + ".jsonl"), "w") as f:
            f.writelines(json.dumps(l) + "\n" for l in lines)
        listed = req(HOME_PORT, "GET", "/harness/claude/sessions")
        row = next((r for r in listed if r["id"] == cc_id), None)
        check("Claude Code's sessions are listed: id, cwd, modified, title", row and row["cwd"] == cc_cwd and row["title"] == "remember the word walrus; reply ok" and row["modified"] > 0 and set(row) == {"id", "cwd", "modified", "title"}, row)
        check("…metadata only, no transcript content", "TOOL-OUTPUT" not in json.dumps(listed) and '"ok"' not in json.dumps(listed))
        att = req(HOME_PORT, "POST", "/session", {"agent": "AGI", "harness": {"id": cc_id}, "cwd": cc_cwd})
        check("attach: an AGI session holding the terminal's conversation", att["agent"] == "AGI" and att["harness"] == {"kind": "claude", "id": cc_id, "attached": True} and att["cwd"] == cc_cwd, (att.get("agent"), att.get("harness"), att.get("cwd")))
        check("attach: titled after it · Claude Code", att["title"] == "remember the word walrus; reply ok · Claude Code", att["title"])
        for name, body in (("a non-uuid id", {"harness": {"id": "../../etc/passwd"}, "cwd": cc_cwd}),
                           ("a folder that does not exist", {"harness": {"id": cc_id}, "cwd": cc_cwd + "-gone"}),
                           ("a session not started in that folder", {"harness": {"id": cc_id}, "cwd": os.path.join(tmp, "home", "work")}),
                           ("an agent that does not run on Claude Code", {"agent": "build", "harness": {"id": cc_id}, "cwd": cc_cwd})):
            try:
                req(HOME_PORT, "POST", "/session", body)
                check(f"attach refuses {name}", False, "accepted")
            except urllib.error.HTTPError as e:
                msg = json.loads(e.read() or b"{}").get("error", "")
                check(f"attach refuses {name} (400, said plainly)", e.code == 400 and len(msg) > 20, (e.code, msg))

        # 6d. Google's harness next to Claude Code's and Codex's: an agent on Antigravity (agy)
        agy = req(HOME_PORT, "PUT", "/agent/agy", {"harness": "antigravity", "description": "Antigravity"})
        check("an agent can run on Antigravity", agy["harness"] == "antigravity" and agy["customizable"] == ["description", "model"], (agy.get("harness"), agy.get("customizable")))
        mbh = agy["models_by_harness"]
        check("Gemini CLI is no longer a harness", "gemini" not in mbh and set(mbh) == {"root", "claude", "opencode", "codex", "antigravity"}, list(mbh))
        am = mbh["antigravity"]
        check("Antigravity's picker: its own pick first, then Google's current models strongest first",
              am[:4] == ["default", "gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"] and "gemini-3.8-flash" in am, am)
        al = agy["model_labels"]["antigravity"]
        check("…each with a label", all(al.get(m) for m in am) and al["gemini-4-carbon"].startswith("Gemini 4 Carbon — strongest"), {m: al.get(m) for m in am[:3]})
        if shutil.which("agy"):
            check("…merged with what `agy models` lists (agy on this tree's PATH)", len(am) > 6 or all(not al[m].endswith("needs GEMINI_API_KEY") for m in am), am)
        try:
            req(HOME_PORT, "PUT", "/agent/agy", {"harness": "gemini"})
            check("an agent cannot be put on Gemini CLI", False, "accepted")
        except urllib.error.HTTPError as e:
            check("an agent cannot be put on Gemini CLI", e.code == 400, e.code)
        req(HOME_PORT, "PUT", "/agent/agy", {"model": "gemini-4-hydrogen"})
        check("an Antigravity agent takes a model of its list", req(HOME_PORT, "GET", "/agent/agy")["model"] == "gemini-4-hydrogen")
        req(HOME_PORT, "DELETE", "/agent/agy")
        old = req(HOME_PORT, "GET", "/agent/gem-old")
        check("an agent saved on Gemini CLI loads on Antigravity (its model dropped: agy does not run it)", old["harness"] == "antigravity" and old["model"] is None, (old.get("harness"), old.get("model")))
        olds = req(HOME_PORT, "GET", "/session/ses_gemold")
        check("…and its session moves too (a new agy conversation)", olds["harness"] == {"kind": "antigravity"} and olds["model"] == {"id": "default", "providerID": "antigravity"}, (olds.get("harness"), olds.get("model")))
        req(HOME_PORT, "DELETE", "/agent/gem-old")
        try:
            req(HOME_PORT, "PUT", "/agent/coordinator", {"tools": {"bash": True}})
            check("the coordinator's tools are locked", False, "accepted")
        except urllib.error.HTTPError as e:
            check("the coordinator's tools are locked", e.code == 400, e.code)
        try:
            req(HOME_PORT, "DELETE", "/agent/AGI")
            check("built-in agents cannot be deleted", False, "accepted")
        except urllib.error.HTTPError as e:
            check("built-in agents cannot be deleted", e.code == 400, e.code)
        req(HOME_PORT, "DELETE", "/agent/reader")
        check("a made agent can be deleted", "reader" not in [x["name"] for x in req(HOME_PORT, "GET", "/agent")])

        # 7. another root
        r = say(tool([["session_start", {"title": "gamma", "agent": "build", "root": "lab", "brief": "Reply with exactly: GAMMA-ON-LAB"}]]))
        out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]["output"]
        check("session_start on another root", "on root lab" in out, out)
        t = tree(HOME_PORT)
        lab = {r["title"]: r for r in req(LAB_PORT, "GET", "/tree")}
        check("proxy here, real session there", t["gamma"]["card"].get("root") == "lab" and "gamma" in lab, (t["gamma"].get("card"), list(lab)))
        home_done = wait(lambda: (tree(HOME_PORT)["gamma"].get("card") or {}).get("status") == "done", 20)
        check("the lab root's report reached home", home_done and "GAMMA-ON-LAB" in (tree(HOME_PORT)["gamma"]["card"].get("headline") or ""), tree(HOME_PORT)["gamma"].get("card"))
        msgs = req(HOME_PORT, "GET", f"/session/{t['gamma']['id']}/message")
        check("reading the proxy reads the lab root", any("GAMMA-ON-LAB" in json.dumps(m["parts"]) for m in msgs), msgs[-1:] if msgs else msgs)
        bad = urllib.request.Request(f"http://127.0.0.1:{HOME_PORT}/tree/report", data=b'{"proxy":"x","event":{}}', method="POST", headers={"content-type": "application/json"})
        try:
            urllib.request.urlopen(bad, timeout=5)
            check("peer report without the token is refused", False, "accepted")
        except urllib.error.HTTPError as e:
            check("peer report without the token is refused", e.code == 401, e.code)
        # extensions: discovered from the manifest, offered to MAIN (scope self), run outside the core
        ext = lambda: (req(HOME_PORT, "GET", "/extensions") or [{}])[0]
        check("the librarian extension is discovered", wait(lambda: ext().get("up"), 20), ext())
        check("its tools are listed with their scope", [t["name"] for t in ext().get("tools", [])] == ["search", "recent", "remember", "recall"], ext().get("tools"))
        sysx = req(HOME_PORT, "GET", "/agent/build")["system"][0]["text"]
        check("the extension's prompt joins the shared prompt", "[extensions]\n- librarian:" in sysx, sysx[-300:])
        time.sleep(2)  # one index pass (poll 1 s) after the last turns
        r = say(tool([["librarian_search", {"query": "ALPHA-DONE"}]]))
        out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]
        check("MAIN searches every session through the extension", out["status"] == "completed" and "alpha" in out["output"], out.get("output", "")[:200])
        say(tool([["librarian_remember", {"topic": "e2e", "fact": "the sky is teal"}]]))
        r = say(tool([["librarian_recall", {"topic": "e2e"}]]))
        out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]["output"]
        check("remember → recall through the extension", "the sky is teal" in out, out[:200])
        r = say(tool([["librarian_recent", {"minutes": 10}]]))
        out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]["output"]
        check("recent lists what changed, with keywords", "session(s) changed" in out and "keywords:" in out, out[:300])
    finally:
        for u in units:
            subprocess.run(["systemctl", "--user", "stop", u], capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'GREEN' if not FAILS else 'RED'}: {len(FAILS)} failure(s) {FAILS if FAILS else ''}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
