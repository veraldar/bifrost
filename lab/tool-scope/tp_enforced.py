#!/usr/bin/env python3
"""TOOL-SCOPE V2 — the tool-policy battery with ENFORCED profiles, on scratch roots.

Reuses lab/tool-policy/driver.py unchanged (TASKS, graders, fixtures, SSE observer). The only
differences from the prompt-only arm are: the root binary (lab/tool-scope, same model config),
the MAIN session is created with a profile (B -> coordinator, C -> session-only), and the store
lives in /tmp/tool-scope-store/<root>. Same POLICY.md prompts, same max steps (12), roll-up off.

Besides the lab's own grade, every turn gets an ATTRIBUTED grade from the stored transcript:
  attempted  = MAIN's own write/edit calls + bash calls with a write shape (any outcome)
  effective  = the same, minus calls the profile refused (state.metadata.denied)
  orphans    = sessions MAIN created without parentID (delegation the lab grader cannot see)
`attributed()` is also applied to the prompt-only trace (reconstruct.py) so both arms are
judged by one detector.

Usage: tp_enforced.py <B|C> <port> <reps> [task-ids,...]
"""
from __future__ import annotations

import json, os, re, sys, time

sys.path.insert(0, "/home/dweeb_xyz/Work/bifrost/lab/tool-policy")
import driver as tp  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = {"B": "coordinator", "C": "session-only"}

# --- the attributed detector (shared with the prompt-only reconstruction) ---
_QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")
_WRITE_SHAPES = [
    re.compile(r"\bsed\b[^|;&]*\s-[a-zA-Z]*i"), re.compile(r"\bsed\b[^|;&]*--in-place"),
    re.compile(r"\bperl\b[^|;&]*\s-[a-zA-Z]*i"), re.compile(r"\btee\b"),
    re.compile(r"(?<![0-9&<>-])>{1,2}\s*(?!&|/dev/)[\w./~$-]"),
    re.compile(r"\b(mv|cp|rm|touch|truncate|install|patch)\s"),
    re.compile(r"\bpython3?\b.*\bopen\s*\(.*['\"][wa]"), re.compile(r"\bwrite_text\b|\bwritelines?\b"),
]


def bash_writes(cmd: str) -> bool:
    """A bash command with a file-write shape (quoted strings blanked first, so a JSON body
    containing `->` or `>` is not a redirection)."""
    bare = _QUOTED.sub("''", cmd)
    py = re.search(r"\bpython3?\b", cmd) is not None
    return any(p.search(bare) for p in _WRITE_SHAPES[:6]) or (py and any(p.search(cmd) for p in _WRITE_SHAPES[6:]))


def is_write(tool: str, args: dict) -> bool:
    if tool in ("write", "edit"):
        return True
    return tool in ("bash", "shell") and bash_writes(str((args or {}).get("command", "")))


_TARGETS = [re.compile(r">{1,2}\s*([^\s;&|]+)"), re.compile(r"\btee\s+(?:-a\s+)?([^\s;&|]+)")]


def write_scope(tool: str, args: dict) -> str | None:
    """None = no write; "scratch" = every target under /tmp (delegation plumbing, e.g. a JSON body
    staged for curl); "project" = anything else, or a write whose target can't be read (python,
    sed -i, cp, ...) — the conservative call. Only "project" is inline work against B/C's policy."""
    if not is_write(tool, args):
        return None
    if tool in ("write", "edit"):
        return "scratch" if str(args.get("filePath", "")).startswith("/tmp/") else "project"
    bare = _QUOTED.sub("''", str(args.get("command", "")))
    if re.search(r"\bsed\b[^|;&]*\s-[a-zA-Z]*i|\bperl\b|\bpython|\b(mv|cp|rm|touch|truncate|install|patch)\s", bare):
        return "project"
    targets = [t for rx in _TARGETS for t in rx.findall(bare) if not t.startswith("&")]
    return "scratch" if targets and all(t.startswith(("/tmp/", "/dev/")) for t in targets) else "project"


def attributed(calls: list[dict]) -> tuple[int, int, int]:
    """calls: [{tool, input, denied}] of MAIN's own turn -> (attempted, effective, denied_total)."""
    attempted = sum(1 for c in calls if is_write(c["tool"], c["input"]))
    effective = sum(1 for c in calls if is_write(c["tool"], c["input"]) and not c["denied"])
    denied = sum(1 for c in calls if c["denied"])
    return attempted, effective, denied


def main_calls(port: int, sid: str) -> list[dict]:
    st, msgs = tp.http("GET", f"http://127.0.0.1:{port}/session/{sid}/message")
    out = []
    for m in msgs if isinstance(msgs, list) else []:
        for p in m.get("parts", []):
            if p.get("type") == "tool":
                s = p.get("state", {})
                out.append({"tool": p.get("tool"), "input": s.get("input") or {},
                            "status": s.get("status"), "denied": bool((s.get("metadata") or {}).get("denied")),
                            "out": str(s.get("output", ""))[:200]})
    return out


def sessions_since(port: int, t0_ms: int, exclude: str) -> list[dict]:
    st, sess = tp.http("GET", f"http://127.0.0.1:{port}/session")
    return [s for s in (sess if isinstance(sess, list) else [])
            if s.get("id") != exclude and s.get("time", {}).get("created", 0) >= t0_ms]


def run(variant: str, port: int, reps: int, picks: set[str] | None):
    vdir = f"TS-{variant}"
    os.makedirs(os.path.join(HERE, "runs"), exist_ok=True)
    tsv = os.path.join(HERE, "runs", f"tp-enforced-{variant}.tsv")
    trace = open(os.path.join(HERE, "runs", f"tp-enforced-{variant}.jsonl"), "a")
    if not os.path.exists(tsv):
        with open(tsv, "w") as f:
            f.write("variant\tprofile\ttask\trep\tsuccess\tviolations\tattempted\teffective\tdenied\tdelegated\tkids\torphans"
                    "\twall_ms\tsteps\tabsorbed_bytes\ttools_used\tnote\n")
    for task in tp.TASKS:
        if picks and task["tid"] not in picks:
            continue
        for rep in range(1, reps + 1):
            tp.restore_fixture(vdir)
            t0_ms = int(time.time() * 1000)
            st, info = tp.http("POST", f"http://127.0.0.1:{port}/session",
                               body={"title": f"[LAB] tool-scope {variant} {task['tid']} r{rep}",
                                     "parentID": "ses_fakeparent", "profile": PROFILE[variant]})
            if st != 200 or info.get("profile") != PROFILE[variant]:
                print(f"CREATE_FAIL {st} {info}", flush=True)
                continue
            sid = info["id"]
            print(f"[{time.strftime('%H:%M:%S')}] {variant}/{task['tid']}/r{rep} -> {sid}", flush=True)
            t0 = tp.T0()
            try:
                reply, calls, outputs, absorbed, steps, ftms = tp.send_and_observe(port, sid, task["text"])
                wall = round((tp.T0() - t0) * 1000)
                exc = ""
            except Exception as e:  # same treatment as the prompt-only arm: an EXC row
                reply, calls, outputs, absorbed, steps, ftms, wall = "", [], [], 0, 0, 0, -1
                exc = f"EXC {type(e).__name__}: {e}"[:120]
            time.sleep(0.3)
            nkids, kid_ids = tp.delegation_evidence(port, sid)
            mine = main_calls(port, sid)
            new = sessions_since(port, t0_ms, sid)
            orphans = [s["id"] for s in new if not s.get("parentID")]
            if exc:
                ok, viol, note = 0, 0, exc
            else:
                ok, viol, note = tp.grade({**task, "variant": vdir}, variant, reply, calls, kid_ids)
            att, eff, den = attributed(mine)
            tools_used = ",".join(sorted({c["tool"] for c in mine})) or "-"
            row = [variant, PROFILE[variant], task["tid"], rep, ok, viol, att, eff, den,
                   1 if (kid_ids or orphans) else 0, nkids, len(orphans), wall, steps, absorbed, tools_used, note]
            with open(tsv, "a") as f:
                f.write("\t".join(map(str, row)) + "\n")
            trace.write(json.dumps({"variant": variant, "profile": PROFILE[variant], "tid": task["tid"], "rep": rep,
                                    "sid": sid, "wall_ms": wall, "calls": mine, "kids": kid_ids, "orphans": orphans,
                                    "reply": reply[:1200], "exception": exc or None}) + "\n")
            trace.flush()
            print(f"{variant} {task['tid']} r{rep}: ok={ok} viol={viol} attempted={att} effective={eff} denied={den} "
                  f"kids={nkids} orphans={len(orphans)} wall={wall}ms tools={tools_used} :: {note}", flush=True)
            for s in [sid, *kid_ids, *orphans, *[x["id"] for x in new]]:
                tp.http("DELETE", f"http://127.0.0.1:{port}/session/{s}")
    trace.close()
    print(f"--- variant {variant} done ---", flush=True)


if __name__ == "__main__":
    v, port, reps = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    picks = set(sys.argv[4].split(",")) if len(sys.argv) > 4 else None
    run(v, port, reps, picks)
