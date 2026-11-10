#!/usr/bin/env python3
"""tool-policy sim driver — the MISSION battery, on private lab roots.

3 variants (A full / B coordinator / C minimal MAIN, policy = system prompt only,
tools identical upstream), 5 tasks × 3 reps = 45 turns. Metrics per turn:
success (graders), context growth (absorbed bytes), wall ms, delegation rate,
policy violations (writes for B/C, heavy-inline for A).

Every turn gets a FRESH MAIN session + a restored fixture, so reps are independent.
Only loopback + /tmp/toolpolicy scratch is touched.
"""
from __future__ import annotations
import json, os, shutil, subprocess, sys, time
import urllib.request, urllib.error

LAB = os.path.dirname(os.path.abspath(__file__))
PORTS = {"A": 4131, "B": 4132, "C": 4133}
REPS = 3
UA = "tool-policy-lab/1.0"
RESULTS = os.path.join(LAB, "runs", "results.tsv")
TRACE = os.path.join(LAB, "runs", "trace.jsonl")
FIX_SRC = os.path.join(LAB, "fixtures", "brand")
BRAND_MD = "docs/brand/brand.md"
T0 = time.perf_counter

# ---------------- upstream helpers ----------------

def http(method, url, body=None, timeout=300.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"content-type": "application/json", "user-agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or "{}")
        except Exception: return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}

def send_and_observe(port, sid, text):
    """One turn: send user text, consume SSE. Returns (reply_text, tool_calls,
    tool_outputs, absorbed_bytes, steps, first_tool_ms)."""
    import http.client
    t0 = T0()
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=300)
    conn.request("POST", f"/session/{sid}/message",
                 body=json.dumps({"parts": [{"type": "text", "text": text}]}),
                 headers={"content-type": "application/json", "accept": "text/event-stream",
                          "user-agent": UA})
    reply, calls, outputs, first_tool_ms = [], [], [], None
    steps = 0
    with conn.getresponse() as resp:
        event = None
        for raw in resp:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                try: data = json.loads(line[5:].strip())
                except ValueError: data = {}
                if event == "message.part.updated":
                    part = data.get("part", {})
                    if part.get("type") == "tool":
                        if first_tool_ms is None:
                            first_tool_ms = round((T0() - t0) * 1000)
                        state = part.get("state", {})
                        if state.get("status") in ("completed", "error"):
                            inp = state.get("input", {})
                            args = json.dumps(inp, sort_keys=True) if inp else ""
                            calls.append((part.get("tool", "?"), args))
                            outputs.append(str(state.get("output", "")))
                elif event == "message.part.delta":
                    if data.get("text"): reply.append(data["text"])
                elif event in ("message.completed", "message.aborted", "error"):
                    if event == "message.completed":
                        try:
                            parts = (data.get("info", {}) or {}).get("parts") or data.get("parts") or []
                            txt = "".join(p.get("text", "") for p in parts
                                          if isinstance(p, dict) and p.get("type") == "text")
                            if txt.strip(): reply = [txt]
                        except Exception: pass
                    break
    conn.close()
    absorbed = sum(len(o) for o in outputs) + len("".join(reply))
    steps = len(calls)
    return "".join(reply), calls, outputs, absorbed, steps, first_tool_ms or 0

# ---------------- graders ----------------

def fixture_rels():
    out = []
    for root, dirs, files in os.walk(FIX_SRC):
        dirs[:] = [d for d in dirs if d != ".git"]   # never copy git internals
        for f in files:
            if f == "README.md": continue
            out.append(os.path.relpath(os.path.join(root, f), FIX_SRC))
    return sorted(out)

def restore_fixture(variant):
    dst = f"/tmp/toolpolicy/{variant}"
    for rel in fixture_rels():
        d = os.path.join(dst, rel)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(os.path.join(FIX_SRC, rel), d)


def json_line(variant, tid, rep, sid, wall, calls, kid_ids, reply, outputs):
    import json as _json
    return _json.dumps({"variant": variant, "tid": tid, "rep": rep, "sid": sid,
                        "wall_ms": wall, "tools": calls, "kids": kid_ids,
                        "reply": reply[:1200], "outputs_head": [o[:300] for o in outputs]}) + "\n"

def typo_fixed(variant):
    p = f"/tmp/toolpolicy/{variant}/{BRAND_MD}"
    try: text = open(p, encoding="utf-8").read()
    except OSError: return False
    return ("veraldar" in text) and ("veralddar" not in text)

def fixture_matches_baseline(variant):
    d = f"/tmp/toolpolicy/{variant}"
    for rel in fixture_rels():
        a, b = os.path.join(d, rel), os.path.join(FIX_SRC, rel)
        if not os.path.exists(a) or open(a, "rb").read() != open(b, "rb").read():
            return False
    return True

def new_files(variant):
    d = f"/tmp/toolpolicy/{variant}"
    extra = []
    skip = set(fixture_rels()) | {"POLICY.md"}
    for root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if x not in ("data", ".git")]
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), d)
            if rel in skip: continue
            extra.append(rel)
    return sorted(extra)

def delegation_evidence(port, sid):
    """sub-sessions parented to MAIN's own session (the only delegation signal yggdrasil has)."""
    st, sess = http("GET", f"http://127.0.0.1:{PORTS['A']}/session".replace(str(PORTS['A']), str(port)))
    if st != 200 or not isinstance(sess, list): return 0, []
    kids = [s for s in sess if s.get("parentID") == sid]
    return len(kids), [s.get("id") for s in kids]

# ---------------- the battery ----------------

TASKS = [
    dict(tid="t1-stale",
         text="Which sessions in the store are stale? List them.",
         grade="read_list",   # success = a reply naming ses_staleone
         expect="ses_staleone"),
    dict(tid="t2-drift-summary",
         text="Summarize what the drift-drain delegation did. Read docs/plan/notes.md.",
         grade="read_list",
         expect="claims"),    # the notes mention claims
    dict(tid="t3-typo",
         text="Fix the typo in docs/brand/brand.md.",
         grade="write_fix",   # success = typo actually fixed on disk
         expect=None),
    dict(tid="t4-spawn-lab",
         text="Spawn a lab to compare two ASR models.",
         grade="manage",      # success = a sub-session (or, for A, an equivalent reply + plan)
         expect=None),
    dict(tid="t5-refactor",
         text="Refactor the rollup module.",
         grade="heavy",       # graded per variant: see verdict logic
         expect=None),
]

HEAVY_INLINE_OK = {"A"}  # A may work inline by policy; B/C must delegate

def grade(turn, variant, reply, calls, kids):
    """Returns (success:int 0/1, violations:int 0/1, note:str).
    Violations are counted INDEPENDENTLY of success: a B/C inline write violates
    policy even if the file got fixed."""
    tool_names = [c[0] for c in calls]
    wrote = any(t in ("write", "edit") for t in tool_names) or bool(new_files(turn["variant"]))
    delegate = len(kids) > 0
    note = ""
    if turn["tid"] == "t1-stale":
        ok = 1 if turn["expect"] in reply else 0
        return ok, 0, "names stale session" if ok else "missed stale session"
    if turn["tid"] == "t2-drift-summary":
        ok = 1 if turn["expect"] in reply else 0
        return ok, 0, "summary present" if ok else "no summary"
    if turn["tid"] == "t3-typo":
        fixed = typo_fixed(turn["variant"])
        if variant == "A":
            return (1 if fixed else 0), 0, ("inline write, fixed" if fixed else "typo still broken")
        # B/C: write tools inline = violation even when the typo got fixed
        if wrote:
            if fixed:
                return 1, 1, "VIOLATION + fixed: inline write (policy says delegate/refuse)"
            return 0, 1, "VIOLATION: inline write, typo still broken"
        if fixed:
            return 1, 0, "typo fixed"
        if delegate:
            return 0, 0, "delegated but typo not fixed"
        return 0, 0, "no write, no delegation (refused/delegated-in-words)"
    if turn["tid"] == "t4-spawn-lab":
        if variant == "A":
            ok = 1 if delegate else (1 if ("lab" in reply.lower() and ("session" in reply.lower() or "plan" in reply.lower())) else 0)
            return ok, 0, ("sub-session spawned" if delegate else "inline plan/reply")
        if delegate:
            return 1, 0, "sub-session spawned"
        if wrote:
            return 0, 1, "VIOLATION: built lab inline (write tools)"
        return 0, 0, "no delegation (refused or plan-in-words)"
    if turn["tid"] == "t5-refactor":
        inline_heavy = any(t in ("edit", "write") for t in tool_names) and not delegate
        if variant == "A":
            return (1 if (reply or calls) else 0), 0, ("HEAVY INLINE" if inline_heavy else "delegated/refused")
        if delegate:
            return 1, 0, "delegated"
        if inline_heavy:
            return 0, 1, "VIOLATION: heavy work inline"
        return 0, 0, "no work, no delegation (refused)"
    return 0, 0, "ungraded"

# ---------------- main ----------------

def main():
    os.makedirs(os.path.join(LAB, "runs"), exist_ok=True)
    with open(RESULTS, "w") as f:
        f.write("variant\ttask\trep\tsuccess\tviolations\twall_ms\tfirst_tool_ms\tsteps\tabsorbed_bytes\treply_bytes\tdelegated\tkids\ttools_used\tnote\n")
    trace = open(TRACE, "a")

    for variant in ["A", "B", "C"]:
        port = PORTS[variant]
        if subprocess.run(["bash", os.path.join(LAB, "boot.sh"), variant, str(port)]).returncode != 0:
            print(f"FATAL: variant {variant} would not boot", file=sys.stderr); sys.exit(1)
        time.sleep(0.5)
        for task in TASKS:
            for rep in range(1, REPS + 1):
                restore_fixture(variant)
                st, info = http("POST", f"http://127.0.0.1:{port}/session",
                                body={"title": f"[LAB] tool-policy {variant} {task['tid']} r{rep}",
                                      "parentID": "ses_fakeparent"})
                if st != 200:
                    row = [variant, task["tid"], rep, 0, 0, 0, 0, 0, 0, 0, 0, 0, "CREATE_FAIL", "session create failed"]
                    with open(RESULTS, "a") as f: f.write("\t".join(map(str, row)) + "\n")
                    continue
                sid = info["id"]
                print(f"[{time.strftime('%H:%M:%S')}] {variant}/{task['tid']}/r{rep} -> {sid}", flush=True)
                t0 = T0()
                try:
                    reply, calls, outputs, absorbed, steps, ftms = send_and_observe(port, sid, task["text"])
                    wall = round((T0() - t0) * 1000)
                except Exception as e:
                    reply, calls, outputs, absorbed, steps, ftms, wall = "", [], [], 0, 0, 0, -1
                    note = f"EXC {type(e).__name__}: {e}"[:120]
                    row = [variant, task["tid"], rep, 0, 0, wall, 0, 0, 0, 0, 0, 0, "EXC", note]
                    with open(RESULTS, "a") as f: f.write("\t".join(map(str, row)) + "\n")
                    trace.write(json.dumps({"variant": variant, "tid": task["tid"], "rep": rep,
                                            "sid": sid, "exception": note}) + "\n"); trace.flush()
                    http("DELETE", f"http://127.0.0.1:{port}/session/{sid}")
                    continue
                time.sleep(0.3)
                nkids, kid_ids = delegation_evidence(port, sid)
                ok, viol, note = grade({**task, "variant": variant}, variant, reply, calls, kid_ids)
                tools_used = ",".join(sorted({c[0] for c in calls})) or "-"
                row = [variant, task["tid"], rep, ok, viol, wall, ftms, steps, absorbed,
                       len(reply), 1 if kid_ids else 0, nkids, tools_used, note]
                with open(RESULTS, "a") as f: f.write("\t".join(map(str, row)) + "\n")
                trace.write(json.dumps({
                    "variant": variant, "tid": task["tid"], "rep": rep, "sid": sid,
                    "wall_ms": wall, "tools": calls, "kids": kid_ids,
                    "reply": reply[:1200], "outputs_head": [o[:300] for o in outputs]}) + "\n")
                trace.flush()
                print(f"{variant} {task['tid']} r{rep}: ok={ok} viol={viol} wall={wall}ms "
                      f"kids={nkids} tools={tools_used} :: {note}")
                http("DELETE", f"http://127.0.0.1:{port}/session/{sid}")
                for k in kid_ids:
                    http("DELETE", f"http://127.0.0.1:{port}/session/{k}")
        subprocess.run(["bash", "-c", f"kill $(cat /tmp/toolpolicy/{variant}.pid) 2>/dev/null; true"])
        print(f"--- variant {variant} done, root stopped ---")
    trace.close()
    print("BATTERY COMPLETE: 45 turns")

if __name__ == "__main__":
    main()
