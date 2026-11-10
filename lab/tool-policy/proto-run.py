#!/usr/bin/env python3
"""Enforced arms (B2/C2): SAME policy prompts as B/C, but the MAIN session is
created with a real tool allowlist on the patched (vendored) root:
  MAIN: tools = [read, glob, grep, bash]   (no write/edit)
  sub-sessions: NO allowlist (full tools) — delegates CAN work.
Identical tasks, reps, graders, metrics as the soft arms. Rows append to
runs/results.tsv with variant B2/C2."""
import os, sys, time, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import driver

LAB = driver.LAB
RES = driver.RESULTS
MAIN_TOOLS = ["read", "glob", "grep", "bash"]   # session management rides on bash
ARMS = {"B2": "B", "C2": "C"}                    # enforced arm -> policy-variant logic
PORTS = {"B2": 4132, "C2": 4133}
PROMPTS = {"B2": os.path.join(LAB, "prompts", "B2E.md"),
           "C2": os.path.join(LAB, "prompts", "C2E.md")}
BIN = os.path.join(LAB, "vendor", "target", "release", "yggdrasil")

def main():
    env = dict(os.environ, BOOT_BIN=BIN)
    for arm, logic in ARMS.items():
        port = PORTS[arm]
        e = dict(env, PROMPT_OVERRIDE=PROMPTS[arm])
        if subprocess.run(["bash", os.path.join(LAB, "boot.sh"), arm, str(port)], env=e).returncode != 0:
            print(f"FATAL boot {arm}"); sys.exit(1)
        time.sleep(0.5)
        # functional probe: allowlist echo
        st, info = driver.http("POST", f"http://127.0.0.1:{port}/session",
                               body={"title": "probe", "parentID": "ses_fakeparent", "tools": MAIN_TOOLS})
        assert st == 200 and info.get("tools") == MAIN_TOOLS, f"{arm}: allowlist echo failed: {info}"
        st, bad = driver.http("POST", f"http://127.0.0.1:{port}/session",
                              body={"title": "probe-bad", "tools": ["notatool"]})
        assert st == 400, f"{arm}: bad tool name accepted ({st})"
        driver.http("DELETE", f"http://127.0.0.1:{port}/session/{info['id']}")
        print(f"{arm}: allowlist echo + validation OK")
        for task in driver.TASKS:
            for rep in range(1, driver.REPS + 1):
                driver.restore_fixture(arm)
                st, info = driver.http("POST", f"http://127.0.0.1:{port}/session",
                                       body={"title": f"[LAB] tool-policy {arm} {task['tid']} r{rep}",
                                             "parentID": "ses_fakeparent", "tools": MAIN_TOOLS})
                if st != 200:
                    print(f"{arm} {task['tid']} r{rep}: CREATE_FAIL"); continue
                sid = info["id"]
                print(f"[{time.strftime('%H:%M:%S')}] {arm}/{task['tid']}/r{rep} -> {sid}", flush=True)
                t0 = driver.T0()
                try:
                    reply, calls, outputs, absorbed, steps, ftms = driver.send_and_observe(port, sid, task["text"])
                    wall = round((driver.T0() - t0) * 1000)
                except Exception as e:
                    with open(RES, "a") as f:
                        f.write(f"{arm}\t{task['tid']}\t{rep}\t0\t0\t-1\t0\t0\t0\t0\t0\t0\tEXC\tEXC {type(e).__name__}\n")
                    print(f"{arm} {task['tid']} r{rep}: EXC {e}")
                    driver.http("DELETE", f"http://127.0.0.1:{port}/session/{sid}")
                    continue
                time.sleep(0.3)
                nkids, kid_ids = driver.delegation_evidence(port, sid)
                ok, viol, note = driver.grade({**task, "variant": arm}, logic, reply, calls, kid_ids)
                tools_used = ",".join(sorted({c[0] for c in calls})) or "-"
                with open(RES, "a") as f:
                    f.write("\t".join(map(str, [arm, task["tid"], rep, ok, viol, wall, ftms, steps,
                                                absorbed, len(reply), 1 if kid_ids else 0, nkids,
                                                tools_used, note])) + "\n")
                with open(driver.TRACE, "a") as f:
                    f.write(driver.json_line(arm, task["tid"], rep, sid, wall, calls, kid_ids, reply, outputs))
                print(f"{arm} {task['tid']} r{rep}: ok={ok} viol={viol} wall={wall}ms kids={nkids} :: {note}")
                driver.http("DELETE", f"http://127.0.0.1:{port}/session/{sid}")
                for k in kid_ids:
                    driver.http("DELETE", f"http://127.0.0.1:{port}/session/{k}")
        subprocess.run(["bash", "-c", f"kill $(cat /tmp/toolpolicy/{arm}.pid) 2>/dev/null; true"])
        print(f"--- {arm} done ---")

if __name__ == "__main__":
    main()
