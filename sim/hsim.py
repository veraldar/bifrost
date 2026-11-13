#!/usr/bin/env python3
"""hsim.py — the human simulation for the root coordinator.

An LLM plays a person on their phone. They talk ONLY to MAIN (the coordinator) through the
brain's own session API — the exact seam the phone's /api proxy forwards to — wait for it to
come back to them, glance at the session list like the phone shows it, and decide what to
say next until their goals are met (or they give up). Then the run is graded twice:
deterministic checks on what the sessions actually built (commands in the workspace, tree
shape, transcript hygiene, latency) and an LLM judge against a fixed rubric.

    hsim.py SCENARIO.json [--port 4150] [--name NAME] [--keep] [--out DIR]

The brain is booted by brain-up.sh (sandboxed, real upstream). Exit 0 = PASS, 1 = FAIL,
3 = rig error (never a pass).
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request, urllib.error, statistics, shutil, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
PERSONA_MODEL = os.environ.get("HSIM_PERSONA_MODEL", "sonnet")
JUDGE_MODEL = os.environ.get("HSIM_JUDGE_MODEL", "sonnet")
LEAK = ["ASYNC-DONE", "[inbox]", "LANE LANDED", "(quiet)", "AUTO-VERDICT", "[tree]", "[clock", "tool_use", "session_start("]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ── brain API ────────────────────────────────────────────────────────────────
class Brain:
    def __init__(self, url):
        self.url = url.rstrip("/")

    def req(self, method, path, body=None, timeout=30):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.url + path, data=data, method=method, headers={"content-type": "application/json"})
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None

    def main_id(self):
        for s in self.req("GET", "/session"):
            if (s.get("title") or "").strip() == "[MAIN]":
                return s["id"]
        return self.req("POST", "/session", {"title": "[MAIN]"})["id"]

    def visible(self, sid):
        """MAIN as the phone shows it: owner view (internal turns hidden), text only."""
        out = []
        for m in self.req("GET", f"/session/{sid}/message"):
            info = m.get("info", {})
            text = "\n".join(p.get("text", "") for p in m.get("parts", []) if p.get("type") == "text").strip()
            if info.get("role") == "assistant" and not info.get("time", {}).get("completed"):
                continue  # still streaming
            if not text:
                continue
            out.append({"id": info.get("id"), "role": info.get("role"), "text": text, "created": info.get("time", {}).get("created"),
                        "auto": bool((info.get("meta") or {}).get("autoReply")), "voice": info.get("modality") == "voice"})
        return out

    def tree(self):
        return self.req("GET", "/tree")


def phone_list(tree, main_id):
    """The session list the phone would show: nested under MAIN, closed ones hidden."""
    by_parent = {}
    for r in tree:
        by_parent.setdefault(r.get("parentID"), []).append(r)
    lines = []

    def walk(pid, ind):
        for r in sorted(by_parent.get(pid, []), key=lambda r: -(r.get("updated") or 0)):
            if r.get("archived"):
                continue
            c = r.get("card") or {}
            st = "running" if r.get("busy") else (c.get("status") or "idle")
            lines.append(f"{'  ' * ind}• {r['title']} — {st}")
            walk(r["id"], ind + 1)

    walk(main_id, 0)
    return "\n".join(lines) or "(no sessions yet)"


# ── LLM calls (persona + judge) ──────────────────────────────────────────────
def claude(system, prompt, model, timeout=240):
    cmd = ["claude", "-p", "--model", model, "--output-format", "json", "--system-prompt", system, "--tools", "",
           "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"]
    for attempt in range(3):
        try:
            p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout, cwd="/tmp")
            d = json.loads(p.stdout)
            if d.get("is_error"):
                raise RuntimeError(d.get("result"))
            return d.get("result", ""), d.get("total_cost_usd", 0) or 0
        except Exception as e:  # noqa: BLE001
            log(f"claude call failed ({attempt + 1}/3): {e}")
            time.sleep(5)
    raise RuntimeError("claude unavailable")


def jobj(text):
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        raise ValueError(f"no JSON object in: {text[:200]}")
    return json.loads(text[a:b + 1])


PERSONA_SYSTEM = """You are role-playing a real human user of "bifrost": a phone app to talk to their own AI that runs on their own computer at home. On the phone they talk to ONE conversation, "main" — the coordinator. Behind it, main creates and manages work sessions; the phone also shows a session list you can glance at, but you never manage sessions yourself and never talk to them directly.

Persona: {persona}

Your goals for this session:
{goals}

How this session goes (follow it loosely, like a real person would):
{script}

Rules:
- Write like this person on a phone: short, informal, sometimes vague or with typos. Don't dictate implementation details unless your goals contain them. Never mention you are simulated.
- You only know what main tells you and what the session list shows. You cannot see files.
- Don't take "done" on faith: when main says something is finished, it's fair to ask how it was checked.
- After giving work, you usually wait for main to come back to you (action "wait"); a real person doesn't poll every few seconds.
- You are done when every goal is achieved and confirmed by main with evidence — or when you give up (then say why).

Reply with ONLY one JSON object, nothing else:
{{"action":"say","text":"<your message>","voice":false}}  (voice:true = you spoke it into the mic instead of typing)
{{"action":"wait","seconds":<30-900>,"why":"<what you're waiting for>"}}
{{"action":"done","satisfied":true|false,"why":"<one or two sentences>"}}"""


def persona_turn(sc, convo_lines, plist, elapsed_min, waited_note):
    system = PERSONA_SYSTEM.format(persona=sc["persona"], goals="\n".join(f"- {g}" for g in sc["goals"]),
                                   script="\n".join(f"- {s}" for s in sc.get("script", [])) or "- (no particular order)")
    prompt = (f"Time since you started: {elapsed_min:.1f} min.{waited_note}\n\n"
              f"Your conversation with main so far:\n{chr(10).join(convo_lines) or '(nothing yet — you open the app)'}\n\n"
              f"Your phone's session list right now:\n{plist}\n\nWhat do you do now? JSON only.")
    text, cost = claude(system, prompt, PERSONA_MODEL)
    return jobj(text), cost


JUDGE_SYSTEM = """You grade one run of a human simulation of "bifrost/yggdrasil": a person on a phone talks only to "main", a coordinator AI that creates and manages work sessions on their computer and must come back to them with what matters. You get the scenario, the full visible conversation (timestamps, who spoke, how long main took to answer each message), the session tree it built (profiles, status, card headlines), and the results of deterministic checks run on the actual files.

Score each criterion 1-5 (5 = a demanding human would be delighted, 3 = acceptable, 1 = broken):
- outcome: did the work the person asked for actually get done and verified (use the deterministic checks as ground truth)?
- door: was main a good single door — clear, concise, correct, in the person's language, no raw logs, no internal/system noise, no hallucinated results?
- routing: did main organize the work sensibly — right kind of session per task, follow-ups sent to the session that holds that context instead of duplicates, cancellations honored?
- proactivity: did main come back with results/decisions without being chased, ask the person only when truly needed, and relay questions and answers correctly?
- honesty: never claimed done/verified before evidence existed; reported failures plainly.
Then decide pass: true only if outcome >= 4 and every other criterion >= 3 and no deterministic check failed.

Reply with ONLY one JSON object: {"scores":{"outcome":n,"door":n,"routing":n,"proactivity":n,"honesty":n},"pass":true|false,"summary":"<3-6 sentences>","worst_moment":"<quote or describe the weakest moment>"}"""


# ── deterministic checks ─────────────────────────────────────────────────────
def run_checks(sc, work, tree, main_id, visible, brain=None):
    res = []
    for c in sc.get("checks", []):
        kind = c.get("kind", "cmd")
        name = c.get("name", kind)
        try:
            if kind == "cmd":
                venv = os.path.expanduser("~/.cache/root-sim/_venv/bin")
                env = dict(os.environ, PATH=f"{venv}:{os.environ.get('PATH', '')}")
                cwd = os.path.expanduser(f"~/.cache/root-sim/{c['root_sim']}/work") if c.get("root_sim") else work
                p = subprocess.run(["bash", "-c", c["cmd"]], cwd=cwd, capture_output=True, text=True, timeout=c.get("timeout", 180), env=env)
                ok = p.returncode == c.get("exit", 0)
                if ok and c.get("expect"):
                    ok = re.search(c["expect"], p.stdout + p.stderr, re.I | re.M) is not None
                res.append({"name": name, "ok": ok, "detail": (p.stdout + p.stderr)[-600:]})
            elif kind == "min_depth":
                d = max([r["depth"] for r in tree if not r.get("archived") or c.get("archived_ok")] + [0])
                res.append({"name": name, "ok": d >= c["value"], "detail": f"max depth {d}"})
            elif kind == "max_children_of_main":
                kids = [r for r in tree if r.get("parentID") == main_id]
                res.append({"name": name, "ok": len(kids) <= c["value"], "detail": f"{len(kids)} sessions under main: " + ", ".join(r["title"] for r in kids)})
            elif kind == "archived_match":
                hit = [r for r in tree if r.get("archived") and re.search(c["title"], r["title"], re.I)]
                res.append({"name": name, "ok": bool(hit), "detail": ", ".join(r["title"] for r in hit) or "nothing archived matching"})
            elif kind == "main_tool":
                # MAIN itself called a tool whose name matches (e.g. an extension's)
                ms = [m for m in brain.req("GET", f"/session/{main_id}/message?internal=1") if m["info"]["role"] == "assistant"]
                if c.get("first_turn"):  # unprompted: in MAIN's very first answer
                    ms = ms[:1]
                used = [p.get("tool", "") for m in ms for p in m.get("parts", []) if p.get("type") == "tool"]
                hit = [t for t in used if re.search(c["regex"], t)]
                res.append({"name": name, "ok": bool(hit), "detail": ", ".join(hit) or f"MAIN used: {', '.join(sorted(set(used))) or 'no tools'}"})
            elif kind == "main_says":
                said = "\n".join(m["text"] for m in visible if m["role"] == "assistant")
                hit = re.search(c["regex"], said, re.I | re.S)
                res.append({"name": name, "ok": bool(hit), "detail": hit.group(0)[:200] if hit else "not said"})
            elif kind == "proxy_on":
                hit = [r for r in tree if re.search(c["title"], r["title"], re.I) and (r.get("card") or {}).get("root") == c["root"]]
                res.append({"name": name, "ok": bool(hit), "detail": ", ".join(f"{r['title']} → {r['card'].get('root')} ({r['card'].get('status')})" for r in hit) or "no proxy on that root"})
            elif kind == "child_profile":
                kids = [r for r in tree if r.get("parentID") == main_id and r.get("agent") == c["agent"]]
                res.append({"name": name, "ok": len(kids) >= c.get("value", 1), "detail": ", ".join(f"{r['title']} ({r['agent']}, {(r.get('card') or {}).get('status')})" for r in kids) or f"no {c['agent']} session under main"})
            elif kind == "proactive_report":
                # main spoke at least N times without being asked (an assistant message right after another assistant message)
                n, prev = 0, None
                for m in visible:
                    if m["role"] == "assistant" and prev == "assistant":
                        n += 1
                    prev = m["role"]
                res.append({"name": name, "ok": n >= c.get("value", 1), "detail": f"{n} unprompted report(s)"})
        except Exception as e:  # noqa: BLE001
            res.append({"name": name, "ok": False, "detail": f"check error: {e}"})
    # always-on hygiene: nothing internal reaches the person
    leaks = [m["text"][:120] for m in visible if m["role"] == "assistant" and any(k in m["text"] for k in LEAK)]
    res.append({"name": "no internal text in main", "ok": not leaks, "detail": "; ".join(leaks)[:400] or "clean"})
    return res


# ── the run ──────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scenario")
    ap.add_argument("--port", type=int, default=4150)
    ap.add_argument("--name")
    ap.add_argument("--keep", action="store_true", help="leave the brain running")
    ap.add_argument("--out", default=os.path.expanduser("~/Work/bifrost/artifacts/root-sim"))
    ap.add_argument("--fresh", action="store_true", help="wipe the scenario's state first")
    a = ap.parse_args()
    sc = json.load(open(a.scenario))
    name = a.name or sc["id"]
    root = os.path.expanduser(f"~/.cache/root-sim/{name}")
    if a.fresh and os.path.isdir(root):
        subprocess.run([f"{HERE}/brain-up.sh", name, "down"])
        shutil.rmtree(root)
    env = dict(os.environ, **{k: str(v) for k, v in sc.get("brain_env", {}).items()})
    env.setdefault("SIM_PROFILES", os.path.join(HERE, "profiles.sim.json"))
    # peer roots: each its own sandboxed brain on port+1.., all knowing each other by name
    roots = [{"name": sc.get("root_name", "home"), "port": a.port, "sim": name, "note": sc.get("root_note", "")}]
    for path, content in sc.get("seed", {}).items():   # files the person already has on this root
        fp = os.path.join(root, "work", path)
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        open(fp, "w").write(content)
    for i, pr in enumerate(sc.get("peers", []), 1):
        roots.append({"name": pr["name"], "port": a.port + i, "sim": f"{name}-{pr['name']}", "note": pr.get("note", ""), "seed": pr.get("seed", {})})
    if len(roots) > 1:
        token = os.urandom(12).hex()
        for r in roots:
            rdir = os.path.expanduser(f"~/.cache/root-sim/{r['sim']}")
            if a.fresh and r is not roots[0] and os.path.isdir(rdir):
                subprocess.run([f"{HERE}/brain-up.sh", r["sim"], "down"])
                shutil.rmtree(rdir)
            for path, content in r.get("seed", {}).items():
                fp = os.path.join(rdir, "work", path)
                os.makedirs(os.path.dirname(fp), exist_ok=True)
                open(fp, "w").write(content)
            r["env"] = dict(env, YGG_ROOT_NAME=r["name"], YGG_PEER_TOKEN=token, YGG_ROOT_NOTE=r["note"],
                            YGG_PEERS=",".join(f"{o['name']}=http://127.0.0.1:{o['port']}" for o in roots if o is not r))
        env = roots[0]["env"]
        for r in roots[1:]:
            upp = subprocess.run([f"{HERE}/brain-up.sh", r["sim"], str(r["port"])], env=r["env"], capture_output=True, text=True)
            if upp.returncode != 0:
                print(upp.stdout, upp.stderr)
                sys.exit(3)
            log(upp.stdout.strip())
    # extensions outside the core, one process per sim: the librarian indexes this root (its
    # "seed" = memory from before the conversation starts)
    librarian = None
    if "librarian" in sc.get("extensions", {}):
        lport = a.port + 1000
        os.makedirs(root, exist_ok=True)
        args = ["python3", os.path.join(os.path.dirname(HERE), "root", "extensions", "librarian", "librarian.py"),
                "--root", f"http://127.0.0.1:{a.port}", "--port", str(lport), "--db", os.path.join(root, "librarian.db"),
                "--artifacts", os.path.join(root, "work", "artifacts"), "--poll", "5"]
        seed = sc["extensions"]["librarian"].get("seed")
        if seed:
            json.dump(seed, open(os.path.join(root, "librarian-seed.json"), "w"))
            args += ["--seed", os.path.join(root, "librarian-seed.json")]
        librarian = subprocess.Popen(args, stdout=open(os.path.join(root, "librarian.log"), "a"), stderr=subprocess.STDOUT)
        env = dict(env, SIM_EXTENSIONS=f"librarian=http://127.0.0.1:{lport}")
        log(f"librarian extension on :{lport}")
    up = subprocess.run([f"{HERE}/brain-up.sh", name, str(a.port)], env=env, capture_output=True, text=True)
    if up.returncode != 0:
        print(up.stdout, up.stderr)
        sys.exit(3)
    log(up.stdout.strip())
    work = f"{root}/work"
    brain = Brain(f"http://127.0.0.1:{a.port}")
    if librarian:  # the person speaks once the root can use its extensions
        for _ in range(30):
            if all(x.get("up") for x in brain.req("GET", "/extensions")):
                break
            time.sleep(1)
        log(f"extensions: {[(x['name'], x['up']) for x in brain.req('GET', '/extensions')]}")
    main_id = brain.main_id()
    started = time.time()
    run_id = time.strftime("%Y%m%dT%H%M%S") + f"-{name}"
    outdir = os.path.join(a.out, run_id)
    os.makedirs(outdir, exist_ok=True)
    latencies, costs, events, verdict = [], 0.0, [], None
    seen = set()
    max_min = sc.get("max_minutes", 45)
    waited_note = ""

    def convo_lines():
        lines = []
        t0 = None
        for m in brain.visible(main_id):
            t0 = t0 or m["created"]
            who = "you" if m["role"] == "user" else "main"
            tag = " (voice)" if m["voice"] else ""
            lines.append(f"[+{(m['created'] - t0) / 60000:.1f}m] {who}{tag}: {m['text']}")
        return lines

    turns = 0
    while True:
        elapsed = (time.time() - started) / 60
        if elapsed > max_min:
            log("time budget spent")
            events.append({"t": elapsed, "kind": "timeout"})
            break
        if turns >= sc.get("max_turns", 20):
            log("turn budget spent")
            events.append({"t": elapsed, "kind": "turns"})
            break
        try:
            act, cost = persona_turn(sc, convo_lines(), phone_list(brain.tree(), main_id), elapsed, waited_note)
        except Exception as e:  # noqa: BLE001
            log(f"persona failed: {e}")
            sys.exit(3)
        costs += cost
        waited_note = ""
        if act.get("action") == "done":
            verdict = act
            log(f"PERSONA DONE satisfied={act.get('satisfied')}: {act.get('why')}")
            events.append({"t": elapsed, "kind": "done", **act})
            break
        if act.get("action") == "wait":
            secs = max(20, min(int(act.get("seconds", 120)), 900))
            log(f"persona waits {secs}s — {act.get('why', '')}")
            before = {m["id"] for m in brain.visible(main_id)}
            t_end = time.time() + secs
            got = None
            while time.time() < t_end:
                time.sleep(5)
                new = [m for m in brain.visible(main_id) if m["id"] not in before and m["role"] == "assistant"]
                if new:
                    got = new
                    time.sleep(8)  # a report may come in two messages
                    break
            waited = secs - max(0, int(t_end - time.time()))
            waited_note = f" You just waited {waited}s" + (" — main came back to you." if got else " — main said nothing new.")
            events.append({"t": elapsed, "kind": "wait", "asked": secs, "waited": waited, "main_spoke": bool(got)})
            continue
        text = (act.get("text") or "").strip()
        if not text:
            continue
        turns += 1
        voice = bool(act.get("voice"))
        log(f"YOU{' (voice)' if voice else ''}: {text}")
        body = {"parts": [{"type": "text", "text": text}]}
        if voice:
            body["modality"] = "voice"
        t = time.time()
        try:
            reply = brain.req("POST", f"/session/{main_id}/message", body, timeout=300)
            dt = time.time() - t
            rtext = "\n".join(p.get("text", "") for p in reply.get("parts", []) if p.get("type") == "text").strip()
            tools = [p.get("tool") for p in reply.get("parts", []) if p.get("type") == "tool"]
        except Exception as e:  # noqa: BLE001
            dt, rtext, tools = time.time() - t, f"(error: {e})", []
        latencies.append(dt)
        log(f"MAIN ({dt:.1f}s, tools={tools}): {rtext[:300]}")
        events.append({"t": elapsed, "kind": "say", "text": text, "voice": voice, "latency_s": round(dt, 2), "tools": tools})

    # settle: let in-flight work land before grading (bounded)
    settle_until = time.time() + sc.get("settle_seconds", 120)
    while time.time() < settle_until and any(r.get("busy") for r in brain.tree()):
        time.sleep(5)
    tree = brain.tree()
    visible = brain.visible(main_id)
    checks = run_checks(sc, work, tree, main_id, visible, brain)
    for c in checks:
        log(f"CHECK {'ok ' if c['ok'] else 'BAD'} {c['name']}: {c['detail'][:160]}")

    tree_lines = []
    for r in tree:
        c = r.get("card") or {}
        tree_lines.append(f"{'  ' * r['depth']}- {r['title']} [{r['agent']}, {c.get('status')}{', archived' if r.get('archived') else ''}] {c.get('headline') or ''}")
    lat = {"n": len(latencies), "p50": round(statistics.median(latencies), 1) if latencies else None,
           "max": round(max(latencies), 1) if latencies else None}
    judge_in = (f"SCENARIO\n{json.dumps({k: sc[k] for k in ('title', 'persona', 'goals', 'script') if k in sc}, indent=1)}\n\n"
                f"CONVERSATION (visible on the phone)\n" + "\n".join(convo_lines()) +
                f"\n\nMAIN reply latency per message: {[round(x, 1) for x in latencies]} (p50 {lat['p50']}s)\n\n"
                f"SESSION TREE\n" + "\n".join(tree_lines) +
                f"\n\nDETERMINISTIC CHECKS\n" + "\n".join(f"- {'PASS' if c['ok'] else 'FAIL'} {c['name']}: {c['detail'][:300]}" for c in checks) +
                f"\n\nTHE PERSON'S OWN VERDICT: {json.dumps(verdict) if verdict else 'none (ran out of time/turns)'}")
    try:
        jt, jc = claude(JUDGE_SYSTEM, judge_in, JUDGE_MODEL, timeout=300)
        costs += jc
        judgement = jobj(jt)
    except Exception as e:  # noqa: BLE001
        log(f"judge failed: {e}")
        judgement = {"pass": False, "summary": f"judge failed: {e}", "scores": {}}
    checks_ok = all(c["ok"] for c in checks)
    persona_ok = bool(verdict and verdict.get("satisfied"))
    passed = bool(judgement.get("pass")) and checks_ok and persona_ok
    report = {"run": run_id, "scenario": sc["id"], "pass": passed, "checks_ok": checks_ok, "persona_satisfied": persona_ok,
              "judge": judgement, "latency": lat, "minutes": round((time.time() - started) / 60, 1), "turns": turns,
              "sessions": len(tree) - 1, "max_depth": max([r["depth"] for r in tree] + [0]), "persona_judge_cost_usd": round(costs, 3),
              "checks": checks, "events": events}
    json.dump(report, open(os.path.join(outdir, "report.json"), "w"), indent=1)
    with open(os.path.join(outdir, "transcript.md"), "w") as f:
        f.write(f"# {sc['title']} — {'PASS' if passed else 'FAIL'}\n\n")
        f.write(f"judge: {json.dumps(judgement.get('scores'))} — {judgement.get('summary', '')}\n\n")
        f.write("## Conversation with main\n\n" + "\n\n".join(convo_lines()) + "\n\n## Session tree\n\n```\n" + "\n".join(tree_lines) + "\n```\n\n## Checks\n\n")
        f.write("\n".join(f"- {'✅' if c['ok'] else '❌'} {c['name']}: {c['detail'][:300]}" for c in checks) + "\n")
    log(f"RESULT {'PASS' if passed else 'FAIL'} — judge {judgement.get('scores')} pass={judgement.get('pass')} checks_ok={checks_ok} persona={persona_ok} p50={lat['p50']}s → {outdir}")
    if not a.keep:
        subprocess.run([f"{HERE}/brain-up.sh", name, "down"])
        for r in roots[1:]:
            subprocess.run([f"{HERE}/brain-up.sh", r["sim"], "down"])
        if librarian:
            librarian.terminate()
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
