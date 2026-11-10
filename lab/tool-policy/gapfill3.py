#!/usr/bin/env python3
"""Gap-fill: rerun the turns missing/damaged from the quota-gap run and APPEND
them to runs/results.tsv (A/t4 r1 EXC row is dropped first; C/t5 r2,r3 missing)."""
import os, sys, time, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import driver

LAB = driver.LAB
RES = driver.RESULTS

# drop the damaged rows we are re-running (EXC timeout casualties)
import re
DAMAGED = [("^A\tt4-spawn-lab\t1\t.*\tEXC\t", ), ]
with open(RES) as f:
    lines = f.readlines()
head, body = lines[0], [l for l in lines[1:] if not ("\tEXC\t" in l and l.startswith(("B\tt4-spawn-lab\t1", "C\tt3-typo\t2")))]
with open(RES, "w") as f:
    f.writelines([head] + body)
print(f"results.tsv: kept {len(body)} rows")

WANT = [("C", "t5-refactor", 3)]
PORTS = {v: p for v, p in driver.PORTS.items()}

for variant, tid, rep in WANT:
    port = PORTS[variant]
    if subprocess.run(["bash", os.path.join(LAB, "boot.sh"), variant, str(port)]).returncode != 0:
        print(f"FATAL boot {variant}"); sys.exit(1)
    time.sleep(0.5)
    task = next(t for t in driver.TASKS if t["tid"] == tid)
    driver.restore_fixture(variant)
    st, info = driver.http("POST", f"http://127.0.0.1:{port}/session",
                           body={"title": f"[LAB] tool-policy {variant} {tid} r{rep} gapfill",
                                 "parentID": "ses_fakeparent"})
    sid = info["id"]
    print(f"[{time.strftime('%H:%M:%S')}] {variant}/{tid}/r{rep} -> {sid}", flush=True)
    t0 = driver.T0()
    try:
        reply, calls, outputs, absorbed, steps, ftms = driver.send_and_observe(port, sid, task["text"])
        wall = round((driver.T0() - t0) * 1000)
        time.sleep(0.3)
        nkids, kid_ids = driver.delegation_evidence(port, sid)
        ok, viol, note = driver.grade({**task, "variant": variant}, variant, reply, calls, kid_ids)
        tools_used = ",".join(sorted({c[0] for c in calls})) or "-"
        row = [variant, tid, rep, ok, viol, wall, ftms, steps, absorbed, len(reply),
               1 if kid_ids else 0, nkids, tools_used, note]
        with open(RES, "a") as f: f.write("\t".join(map(str, row)) + "\n")
        with open(driver.TRACE, "a") as f:
            f.write(driver.json_line(variant, tid, rep, sid, wall, calls, kid_ids, reply, outputs))
        print(f"{variant} {tid} r{rep}: ok={ok} viol={viol} wall={wall}ms kids={nkids} :: {note}")
        driver.http("DELETE", f"http://127.0.0.1:{port}/session/{sid}")
        for k in kid_ids:
            driver.http("DELETE", f"http://127.0.0.1:{port}/session/{k}")
    except Exception as e:
        print(f"{variant} {tid} r{rep}: EXC {e}")
    subprocess.run(["bash", "-c", f"kill $(cat /tmp/toolpolicy/{variant}.pid) 2>/dev/null; true"])


