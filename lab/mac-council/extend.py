#!/usr/bin/env python3
"""mac-council deep-dose extension — the marathon at the owner's real regime.

The main sim dosed the marathon to ~46k tok est. The house's measured marathons
hit 148k tokens (rollup.rs exists because of them). This extension pushes the
marathon to ~150k tok est (deterministic filler) before the graded ask, against
the same flow pattern (fresh Q&A session on digests). 3 reps, interleaved.
Own scratch root on :4137 — nothing shared with the main sim but the corpus,
the graders and the digest artifacts from the completed main run.
"""
from __future__ import annotations
import json, os, re, shutil, subprocess, time, urllib.request
import runner

PORT = 4137
runner.PORT = PORT
runner.BASE = f"http://127.0.0.1:{PORT}"
RUNS = runner.RUNS
BATTERY = json.load(open(os.path.join(runner.CORPUS, "battery.json")))
STAGE_QS = {1: [0,1,2,3], 2: [4,5,6,7], 3: [8,9,10,11]}
REPS = 3

def norm(s):
    s = s.lower().replace("**","").strip()
    s = s.replace("tuesdays","tuesday").replace("wednesdays","wednesday")
    return " ".join(s.split())

def boot_deep():
    data, proj = "/tmp/macdeep/data", "/tmp/macdeep/proj"
    os.makedirs(data + "/session", exist_ok=True); os.makedirs(proj, exist_ok=True)
    subprocess.run(["cp", "-r", f"{runner.CORPUS}/.", proj + "/"], check=True)
    # reuse the completed main run's digests (identical corpus)
    shutil.copytree("/tmp/maccouncil/proj/digests", proj + "/digests", dirs_exist_ok=True)
    old = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True).stdout
    m = re.search(rf"pid=(\d+).*:{PORT} ", old) or re.search(rf":{PORT} .*pid=(\d+)", old)
    if m: os.kill(int(m.group(1)), 15); time.sleep(0.5)
    log = open("/tmp/macdeep/root.log", "a")
    env = dict(os.environ,
        YGG_UPSTREAM_BASE_URL="https://api.z.ai/api/anthropic", YGG_UPSTREAM_STYLE="anthropic",
        YGG_UPSTREAM_API_KEY=runner.KEY, YGG_UPSTREAM_MODEL="glm-5.3-flash",
        YGG_LISTEN=f"127.0.0.1:{PORT}", YGG_MAX_TOKENS="16384",
        YGG_DATA_DIR=data, YGG_PROJECT_DIR=proj, YGG_CONTEXT_FILES="",
        YGG_ROLLUP_TOKENS="0", YGG_MAX_STEPS="10")
    p = subprocess.Popen([runner.BIN], stdout=log, stderr=log, env=env)
    for _ in range(60):
        try:
            urllib.request.urlopen(f"{runner.BASE}/session/status", timeout=2); return
        except Exception: time.sleep(0.3)
    raise RuntimeError("deep root did not boot")

def main():
    boot_deep()
    print("deep root up on", PORT)
    for rep in range(1, REPS+1):
        # ARM B: fresh flow Q&A (stage-2 questions)
        qs = [BATTERY[i] for i in STAGE_QS[2]]
        sid = runner.fresh(f"[LAB] mc-deep-flow r{rep}")
        r = runner.turn(sid, runner.ask_digest_text(qs))
        runner.log(f"D-B s2 r{rep}", r)
        for i, (qid, _q, ans) in enumerate(qs):
            m = re.search(rf"A{i+1}\s*:\s*(.+)", r["reply"])
            ok = norm(ans) in norm((m.group(1) if m else "") or r["reply"])
            open(os.path.join(RUNS, "deep.tsv"), "a").write(
                f"B\t{rep}\t{qid}\t{int(ok)}\t{len(r['reply'])}\t{r['wall_ms']}\t0\n")
        # ARM A: deep marathon (~150k tok est)
        sid = runner.fresh(f"[LAB] mc-deep-marathon r{rep}")
        r0 = runner.turn(sid, "Read ALL of these files completely and commit their contents to memory. "
                         "Do not answer anything yet, just read and reply with the single line: READ-DONE.\n"
                         + "\n".join("- "+p for p in runner.ALL_FILES))
        runner.log(f"D-A r{rep} ingest", r0)
        ctx = 2000
        for dose_bytes in (240_000, 560_000):
            fr = runner.turn(sid, "Append this operations log to your memory (do not summarize, just retain it), "
                             "then reply with just: LOG-OK\n\n" + runner.filler_text(dose_bytes))
            ctx += dose_bytes + len(fr.get("reply",""))
            runner.log(f"D-A r{rep} dose@{ctx//1000}k", fr)
        r = runner.turn(sid, runner.ask_text(qs))
        runner.log(f"D-A s2 r{rep} @~{ctx//1000}kB", r)
        est_tok = (ctx + len(r.get("reply",""))) // 4
        for i, (qid, _q, ans) in enumerate(qs):
            m = re.search(rf"A{i+1}\s*:\s*(.+)", r["reply"])
            ok = norm(ans) in norm((m.group(1) if m else "") or r["reply"])
            open(os.path.join(RUNS, "deep.tsv"), "a").write(
                f"A\t{rep}\t{qid}\t{int(ok)}\t{len(r['reply'])}\t{r['wall_ms']}\t{est_tok}\n")
        print(f"== deep rep {rep} done (A est {est_tok} tok)")
    print("DEEP DONE -> runs/deep.tsv")

if __name__ == "__main__":
    main()
