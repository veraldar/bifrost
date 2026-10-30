#!/usr/bin/env python3
"""mac-council distractor leg — drift under interference.

The owner's phenomenon is not clean recall; it is DRIFT: a long session that has
absorbed contradictory updates answers per the LATEST state (or gets confused);
a fresh session with exactly the right context cannot be contaminated by noise
it never saw (the Mac's "context extension hands it its latest state" pattern).

Design (scratch root :4138): marathon arm reads corpus + a deterministic
"changelog" containing 8 LATEST-WINS policy revisions that contradict 4 corpus
facts (maintenance day, alert threshold, eviction policy name, listen port),
planted at increasing depth, plus neutral filler. Then two question sets:
  SET-ORIGINAL: the corpus facts as written ("per the base docs")
  SET-LATEST:   the revised facts ("per the latest updates")
Flow arm: fresh sessions answer the SAME two sets from (a) fresh full-file
reads incl. the same changelog file, and (b) digests only.
All facts remain deterministic + substring-gradable.
"""
from __future__ import annotations
import json, os, re, subprocess, time, urllib.request
import runner

PORT = 4138
runner.PORT = PORT
runner.BASE = f"http://127.0.0.1:{PORT}"
BATTERY = json.load(open(os.path.join(runner.CORPUS, "battery.json")))

CHANGELOG = """# ops/changelog.md — LATEST ENTRY WINS
2026-10-01 policy update: the maintenance window MOVES to **Sundays 04:00** (effective immediately).
2026-10-03 policy update: kvx_dirty_total warning alert LOWERS to **7500** (was 8000).
2026-10-05 policy update: cache eviction policy is renamed to **GCLOCK** (a CLOCK variant; the old name is retired).
2026-10-09 policy update: the network listener moves to **127.0.0.1:7800** (was 7777).
2026-10-12 note: nightly telemetry retention is now 30 days.
2026-10-15 policy update: shard count doubles to **32 shards** (re-shard planned Q1).
2026-10-18 note: runbooks are now reviewed monthly.
2026-10-21 policy update: flush threshold raises to **12000 dirty entries** (was 9000).
Always answer per the LATEST dated entry when docs disagree.
"""

def norm(s):
    s = s.lower().replace("**","").strip()
    s = s.replace("tuesdays","tuesday").replace("sundays","sunday")
    s = s.replace(" at ", " ")
    return " ".join(s.split())

SET_ORIGINAL = [
    ("d01-maint-base",  "Per the BASE capacity docs (ignoring any changelog), when does the maintenance window run? Weekday and time.", "tuesday 03:00"),
    ("d02-alert-base",  "Per the BASE monitoring docs (ignoring any changelog), at what value does kvx_dirty_total warn? Just the number.", "8000"),
    ("d03-shards-base", "Per the BASE design notes (ignoring any changelog), how many shards? Just the number.", "16"),
    ("d04-flush-base",  "Per the BASE limits docs (ignoring any changelog), what is the flush threshold in dirty entries? Just the number.", "9000"),
]
SET_LATEST = [
    ("d05-maint-latest","Per the LATEST changelog entries, when does the maintenance window now run? Weekday and time.", "sunday 04:00"),
    ("d06-alert-latest","Per the LATEST changelog entries, at what value does kvx_dirty_total now warn? Just the number.", "7500"),
    ("d07-shards-latest","Per the LATEST changelog entries, how many shards are planned? Just the number.", "32"),
    ("d08-flush-latest","Per the LATEST changelog entries, what is the flush threshold now? Just the number.", "12000"),
]

def boot_dist():
    data, proj = "/tmp/macdist/data", "/tmp/macdist/proj"
    os.makedirs(data + "/session", exist_ok=True); os.makedirs(proj, exist_ok=True)
    subprocess.run(["cp", "-r", f"{runner.CORPUS}/.", proj + "/"], check=True)
    open(proj + "/ops/changelog.md", "w").write(CHANGELOG)
    old = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True).stdout
    m = re.search(rf"pid=(\d+).*:{PORT} ", old) or re.search(rf":{PORT} .*pid=(\d+)", old)
    if m: os.kill(int(m.group(1)), 15); time.sleep(0.5)
    log = open("/tmp/macdist/root.log", "a")
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
    raise RuntimeError("dist root did not boot")

def ask_set(sid, qs, preamble=""):
    txt = (preamble + "Answer using ONLY what you have. One line per answer, format exactly "
           "'A1: ...' 'A2: ...' etc. No explanations.\n" +
           "\n".join(f"Q{i+1}: {q}" for i, (_id, q, _a) in enumerate(qs)))
    r = runner.turn(sid, txt)
    out = []
    for i, (qid, _q, ans) in enumerate(qs):
        m = re.search(rf"A{i+1}\s*:\s*(.+)", r["reply"])
        piece = m.group(1) if m else ""
        ok = norm(ans) in norm(piece or r["reply"])
        out.append((qid, int(ok), piece.strip()[:60]))
    runner.log(f"dist {sid[:12]} {qs[0][0][:6]}", r)
    return out

def main():
    boot_dist()
    print("dist root up on", PORT)
    resfile = os.path.join(runner.RUNS, "distractor.tsv")
    open(resfile, "w").write("arm\trep\tqid\tcorrect\tsaid\n")
    REPS = 3
    for rep in range(1, REPS+1):
        # ---- FLOW arm: fresh sessions, full-file read incl changelog ----
        f1 = runner.fresh(f"[LAB] mc-dist-flow-docs r{rep}")
        for qid, ok, said in ask_set(f1, SET_ORIGINAL + SET_LATEST,
            "Read readme.md, docs/limits.md, ops/monitoring.md, design/notes.md, conf/settings.ini and ops/changelog.md first.\n"):
            open(resfile, "a").write(f"B\t{rep}\t{qid}\t{ok}\t{said}\n")
        # ---- MARATHON arm: read corpus + changelog + heavy filler, then both sets ----
        m1 = runner.fresh(f"[LAB] mc-dist-marathon r{rep}")
        r = runner.turn(m1, "Read ALL of these files completely and commit their contents to memory. "
                        "Do not answer anything yet, just read and reply with the single line: READ-DONE.\n"
                        + "- readme.md\n- docs/limits.md\n- ops/monitoring.md\n- design/notes.md\n"
                        "- conf/settings.ini\n- ops/changelog.md\n")
        runner.log(f"dist-m r{rep} ingest", r)
        ctx = 4000
        for dose_bytes in (120_000, 240_000):
            fr = runner.turn(m1, "Append this operations log to your memory (do not summarize, just retain it), "
                             "then reply with just: LOG-OK\n\n" + runner.filler_text(dose_bytes))
            ctx += dose_bytes
            runner.log(f"dist-m r{rep} dose@{ctx//1000}k", fr)
        for qid, ok, said in ask_set(m1, SET_ORIGINAL + SET_LATEST):
            open(resfile, "a").write(f"A\t{rep}\t{qid}\t{ok}\t{said}\n")
        print(f"== dist rep {rep} done (marathon ctx ~{(ctx)//1000}kB)")
    print("DIST DONE")

if __name__ == "__main__":
    main()
