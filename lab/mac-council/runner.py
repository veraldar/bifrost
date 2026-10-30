#!/usr/bin/env python3
"""mac-council tier-3 sim — the owner's thesis, head-to-head.

  THESIS (owner, 10-30): "short sessions with the right context always beat
  long sessions" — LLMs get lazier in long windows; fresh session + exactly
  the right context + freedom = best quality, especially on small models.

Design (deterministic corpus, objective graders, same root binary, same
upstream model key, interleaved execution):
  corpus   = lab/mac-council/corpus/ (fictional KVStore project, 8 files,
             12 planted facts, 12-question battery, substring graders)
  ARM A    = MARATHON: one fresh session, ingest all 8 files, then 3 stages
             x 4 questions. Between stages the context is deliberately
             DOSED with filler turns (deterministic log text) so the window
             reaches the regime where the literature says degradation bites
             (stage-2 target ~25k tok est, stage-3 ~55k, stage-4 ~85k est).
             This reproduces the owner's actual regime (house marathons hit
             148k tokens; rollup exists because of it) — a tiny-context
             marathon would not test the claim.
  ARM B    = FLOW: 2 fresh ingest sessions (4 files each) write digests to
             disk; 3 fresh Q&A sessions read ONLY the digests. Context per
             session stays small by construction. This is the Mac pattern:
             each step = fresh session + exactly the right context.

Measures per question: correct (substring grader), reply chars, refusal
markers, wall ms, session age (msgs so far, est context bytes). Aggregates:
accuracy per stage x arm (paired by stage), laziness signals, failures.
Honesty notes built in: tool calls logged; graders fixed before runs;
no Mac content, no veraldar lore — the corpus is fictional by design.
"""
from __future__ import annotations
import json, os, re, subprocess, sys, time, urllib.request, urllib.error

LAB = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(LAB, "corpus")
RUNS = os.path.join(LAB, "runs")
PORT = 4136
BASE = f"http://127.0.0.1:{PORT}"
UA = "mac-council-sim/1.0"
KEY = open(os.path.join(os.path.dirname(LAB), "tool-policy", "upstream.key")).read().strip()
BIN = os.path.join(os.path.dirname(LAB), "yggdrasil", "target", "release", "yggdrasil")
REPS = 3
T0 = time.perf_counter

# ---------------- infra ----------------

def boot_root():
    data = f"/tmp/maccouncil/data"; proj = "/tmp/maccouncil/proj"
    os.makedirs(data + "/session", exist_ok=True); os.makedirs(proj + "/digests", exist_ok=True)
    # copy corpus into the project dir so the model's read tool can reach it
    subprocess.run(["cp", "-r", f"{CORPUS}/.", proj + "/"], check=True)
    pidf = "/tmp/maccouncil/root.pid"
    old = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True).stdout
    m = re.search(rf"pid=(\d+).*:{PORT} ", old) or re.search(rf":{PORT} .*pid=(\d+)", old)
    if m: os.kill(int(m.group(1)), 15); time.sleep(0.5)
    log = open("/tmp/maccouncil/root.log", "a")
    env = dict(os.environ,
        YGG_UPSTREAM_BASE_URL="https://api.z.ai/api/anthropic",
        YGG_UPSTREAM_STYLE="anthropic",
        YGG_UPSTREAM_API_KEY=KEY,
        YGG_UPSTREAM_MODEL="glm-5.3-flash",
        YGG_LISTEN=f"127.0.0.1:{PORT}",
        YGG_MAX_TOKENS="16384",
        YGG_DATA_DIR=data, YGG_PROJECT_DIR=proj,
        YGG_CONTEXT_FILES="", YGG_ROLLUP_TOKENS="0", YGG_MAX_STEPS="10")
    p = subprocess.Popen([BIN], stdout=log, stderr=log, env=env)
    open(pidf, "w").write(str(p.pid))
    for _ in range(60):
        try:
            urllib.request.urlopen(f"{BASE}/session/status", timeout=2); return
        except Exception: time.sleep(0.3)
    raise RuntimeError("lab root did not boot; see /tmp/maccouncil/root.log")

def http(method, url, body=None, timeout=420.0):
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

def turn(sid, text):
    """One turn via the proven SSE pattern (harness-bench adapter shape)."""
    import http.client
    t0 = T0(); conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=420)
    conn.request("POST", f"/session/{sid}/message",
        body=json.dumps({"parts": [{"type": "text", "text": text}]}),
        headers={"content-type": "application/json", "accept": "text/event-stream", "user-agent": UA})
    reply, tools, err = [], [], None
    try:
        with conn.getresponse() as resp:
            if resp.status != 200:
                return {"reply": "", "tools": [], "wall_ms": 0, "error": f"HTTP {resp.status}"}
            event = None
            for raw in resp:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if line.startswith("event:"): event = line[6:].strip()
                elif line.startswith("data:"):
                    try: data = json.loads(line[5:].strip())
                    except Exception: continue
                    if event == "message.part.delta" and isinstance(data, dict) and data.get("text"):
                        reply.append(data["text"])
                    elif event == "tool.start" or (event == "message.part" and isinstance(data, dict)
                                                   and data.get("type") == "tool"):
                        tools.append(data)
                    elif event == "session.error" or (event == "message.completed" and isinstance(data, dict) and data.get("error")):
                        err = data
    except Exception as e:
        return {"reply": "".join(reply), "tools": tools, "wall_ms": int((T0()-t0)*1000), "error": str(e)}
    finally: conn.close()
    return {"reply": "".join(reply), "tools": tools, "wall_ms": int((T0()-t0)*1000), "error": err}

def fresh(title):
    st, body = http("POST", f"{BASE}/session", {"title": title})
    assert st == 200, f"session create failed: {st} {body}"
    return body["id"]

# ---------------- the dose (deterministic filler for arm A) ----------------

def filler_text(n_bytes: int) -> str:
    """Deterministic pseudo-ops-log filler (no corpus facts, no answers)."""
    lines = []
    seeds = ["sync-worker ran batch", "cache shard rebalanced", "telemetry flushed",
             "replica lag nominal", "queue drained", "nightly index compacted",
             "checkpoint written", "lease renewed"]
    i = 0
    total = 0
    while total < n_bytes:
        i += 1
        line = f"{i:06d} ops: {seeds[i % len(seeds)]} item={i*7919 % 100000} status=ok latency={(i*104729)%900+11}ms note=procedural-no-fill-here"
        lines.append(line); total += len(line) + 1
    return "\n".join(lines)

def dose_turn_bytes(stage: int) -> int:
    """Filler bytes per gap so stage-2/3/4 sit at ~25k/55k/85k tok est (4 ch/tok)."""
    return {2: 60_000, 3: 120_000, 4: 120_000}[stage]

# ---------------- arms ----------------

ALL_FILES = ["readme.md", "docs/history.md", "docs/limits.md", "docs/api.md",
             "ops/runbook.md", "ops/monitoring.md", "conf/settings.ini", "design/notes.md"]

def arm_a_session(rep: int) -> str:
    sid = fresh(f"[LAB] mc-marathon r{rep}")
    filelist = "\n".join("- " + p for p in ALL_FILES)
    r = turn(sid, "Read ALL of these files completely and commit their contents to memory. "
             "Do not answer anything yet, just read and reply with the single line: READ-DONE.\n" + filelist)
    log(f"A r{rep} ingest", r)
    return sid

def arm_b_digests(rep: int) -> list[str]:
    out = []
    halves = [("s1", ALL_FILES[:4]), ("s2", ALL_FILES[4:])]
    for tag, files in halves:
        sid = fresh(f"[LAB] mc-ingest-{tag} r{rep}")
        filelist = "\n".join("- " + p for p in files)
        r = turn(sid, f"Read these files completely:\n{filelist}\n\n"
                 "Then WRITE a complete reference digest to digests/digest-{tag}.md "
                 "capturing EVERY concrete fact, number, name, path, threshold and setting they contain — "
                 "it will be the ONLY thing later readers ever see from these files. "
                 "When done, reply with just: DIGEST-DONE".replace("{tag}", tag))
        log(f"B r{rep} ingest-{tag}", r)
        out.append(f"digests/digest-{tag}.md")
    return out

STAGES = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]]

def ask_text(qs) -> str:
    return ("Answer these questions using ONLY what you have. One line per answer, "
            "format exactly 'A1: ...' 'A2: ...' etc. No explanations.\n" +
            "\n".join(f"Q{i+1}: {q}" for i, (_id, q, _a) in enumerate(qs)))

def ask_digest_text(qs) -> str:
    return ("Read every file in the digests/ directory first. Then answer these questions "
            "using ONLY the digests. One line per answer, format exactly 'A1: ...' 'A2: ...' etc. "
            "No explanations.\n" +
            "\n".join(f"Q{i+1}: {q}" for i, (_id, q, _a) in enumerate(qs)))

def grade(reply: str, expected: str) -> bool:
    return expected.lower() in reply.lower().replace("**", "")

REFUSAL_MARKERS = ["i cannot", "i can't", "i do not have", "i don't have", "not sure",
                   "no information", "unable to", "i'm unable", "as an ai", "don't know", "do not know"]

def laziness(reply: str) -> dict:
    low = reply.lower()
    return {"chars": len(reply), "words": len(reply.split()),
            "refusals": sum(1 for m in REFUSAL_MARKERS if m in low)}

def log(label, r):
    line = json.dumps({"label": label, "wall_ms": r.get("wall_ms"), "error": r.get("error"),
                       "chars": len(r.get("reply", "")), "tools": len(r.get("tools", [])),
                       "reply": r.get("reply", "")[:2000]})
    open(os.path.join(RUNS, "turns.jsonl"), "a").write(line + "\n")
    print("   ", line[:160])

def main():
    os.makedirs(RUNS, exist_ok=True)
    battery = json.load(open(os.path.join(CORPUS, "battery.json")))
    boot_root()
    print("root up on", PORT)
    rows_out = open(os.path.join(RUNS, "results.tsv"), "w")
    rows_out.write("arm\tstage\trep\tqid\tcorrect\tchars\twords\trefusals\twall_ms\tsession_msgs\test_ctx_bytes\ttools\n")

    for rep in range(1, REPS + 1):
        # ---- interleaved: arm A and B alternate rep by rep ----
        # ARM B (flow)
        digests = arm_b_digests(rep)
        for stage_idx, qidx in enumerate(STAGES, start=1):
            qs = [battery[i] for i in qidx]
            sid = fresh(f"[LAB] mc-flow-q s{stage_idx} r{rep}")
            r = turn(sid, ask_digest_text(qs))
            log(f"B s{stage_idx} r{rep}", r)
            lz = laziness(r["reply"])
            for i, (qid, _q, ans) in enumerate(qs):
                m = re.search(rf"A{i+1}\s*:\s*(.+)", r["reply"])
                piece = m.group(1) if m else ""
                ok = grade(piece or r["reply"], ans)
                rows_out.write(f"B\t{stage_idx}\t{rep}\t{qid}\t{int(ok)}\t{lz['chars']}\t{lz['words']}\t{lz['refusals']}\t{r['wall_ms']}\t0\t0\t{len(r['tools'])}\n")
        # ARM A (marathon)
        sid = arm_a_session(rep)
        msgs = 1; ctx = sum(len(open(os.path.join(CORPUS, f)).read()) for f in ALL_FILES)
        for stage_idx, qidx in enumerate(STAGES, start=1):
            if stage_idx > 1:
                fb = dose_turn_bytes(stage_idx)
                fr = turn(sid, "Append this operations log to your memory (do not summarize, just retain it), "
                          "then reply with just: LOG-OK\n\n" + filler_text(fb))
                msgs += 1; ctx += fb + len(fr.get("reply", ""))
                log(f"A dose s{stage_idx} r{rep}", fr)
            qs = [battery[i] for i in qidx]
            r = turn(sid, ask_text(qs))
            msgs += 1; ctx += len(r.get("reply", ""))
            log(f"A s{stage_idx} r{rep}", r)
            lz = laziness(r["reply"])
            for i, (qid, _q, ans) in enumerate(qs):
                m = re.search(rf"A{i+1}\s*:\s*(.+)", r["reply"])
                piece = m.group(1) if m else ""
                ok = grade(piece or r["reply"], ans)
                rows_out.write(f"A\t{stage_idx}\t{rep}\t{qid}\t{int(ok)}\t{lz['chars']}\t{lz['words']}\t{lz['refusals']}\t{r['wall_ms']}\t{msgs}\t{ctx}\t{len(r['tools'])}\n")
        print(f"== rep {rep} done")
    rows_out.close()
    print("DONE -> runs/results.tsv")

if __name__ == "__main__":
    main()
