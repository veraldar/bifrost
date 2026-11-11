#!/usr/bin/env python3
"""lane-followup core (better-loops, owner law: no lane ends PARTIAL and stops).

  lane-followup.sh ARTIFACT.md     evaluate one landed artifact; auto-dispatch a follow-up lane when its
                                   verdict is PARTIAL/BLOCKED/RIG/FAILED* and the chain has no live follow-up
  lane-followup.sh --sweep         retro sweep: artifacts/*.md mtime <= 48h, same rules, one dispatch each

Chain id = artifact stem minus -rN. State in $LF_CHAIN_DIR (/tmp/lane-chains): <chain>.n iteration counter
(max 3), <chain>.v verdict history, <chain>.last artifact+mtime already acted on, <chain>.escalated,
<chain>.done / <stem>.done coordinator override. Env: LF_ART_DIR LF_CHAIN_DIR LF_AGI_RUN LF_LOG_DIR
STATUS_FILE LF_IGNORE_UNIT LF_DRY LF_MAX LF_UNIT_GLOB (tests)."""
import fcntl, glob, os, re, subprocess, sys, time

HOME = os.path.expanduser("~")
BIF = os.environ.get("LF_BIF", os.path.join(HOME, "Work/bifrost"))
ART = os.environ.get("LF_ART_DIR", os.path.join(BIF, "artifacts"))
CH = os.environ.get("LF_CHAIN_DIR", "/tmp/lane-chains")
AGI_RUN = os.environ.get("LF_AGI_RUN", os.path.join(BIF, "scripts/agi-run.sh"))
LOGD = os.environ.get("LF_LOG_DIR", os.path.join(BIF, ".agi-log"))
STATUS = os.environ.get("STATUS_FILE") or os.environ.get("AGI_STATUS_FILE") or "/tmp/sub-status.tsv"
WILLS = os.environ.get("AGI_WILL_DIR", os.path.join(LOGD, "wills"))
MAX = int(os.environ.get("LF_MAX", "3"))
DRY = os.environ.get("LF_DRY") == "1"
CANON = ("CANON: Veraldar=org, Yggdrasil=product (root=brain, trunk=private line, branch=app; bifrost=first branch). "
         "Canon file: docs/CONSTRUCT.md sha256=3a37c2945973b2e0cc56f29cd22e3d04d6f35f3d6c91de96e2fb22e681f7e76e. "
         "Naming/structure work without this contract = refuse. Every report you land carries one canon line: "
         "run scripts/canon-check.sh and paste its CANON row.")
GREEN = re.compile(r"^\W*(DONE-GREEN|DONE|GREEN|LIVE|FEASIBLE)\b", re.I)
GATED = re.compile(r"^\W*OWNER[- ]GATED", re.I)
BAD = re.compile(r"PARTIAL|BLOCKED|\bRIG\b|FAILED|NOT GREEN", re.I)
GAPKEY = re.compile(r"next[- ]actions?|gaps?\b|not done|recommend|remaining|todo|still open|follow-?up", re.I)


def log(msg):
    if not DRY:
        os.makedirs(LOGD, exist_ok=True)
        with open(os.path.join(LOGD, "followups.log"), "a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')}\t{msg}\n")
    print(f"lane-followup: {msg}")


def chain_of(stem):
    return re.sub(r"-r\d+$", "", stem)


def read(p):
    try:
        return open(p, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


def classify(text):
    """-> (kind, words, line): kind in GREEN|GATED|BAD|NONE; words = leading verdict phrase."""
    lines = text.splitlines()
    if lines and lines[0].startswith("# LANE FAILED"):
        return "BAD", "FAILED-STUB", lines[0]
    for ln in lines[:12]:
        m = re.search(r"verdict\W*(.*)", ln, re.I) or (re.match(r"#\s+\S+\s+[—–-]+\s*(.*)", ln) if ln.startswith("#") else None)
        if not m:
            continue
        head = m.group(1).strip().lstrip("*_` ")[:48]
        if GATED.match(head):
            return "GATED", "OWNER-GATED", ln
        if GREEN.match(head):
            return "GREEN", GREEN.match(head).group(1).upper(), ln
        if BAD.search(head):
            return "BAD", BAD.search(head).group(0).upper().replace(" ", "-"), ln
    return "NONE", "", ""


def next_actions(text):
    out, grab = [], 0
    for ln in text.splitlines()[1:]:
        s = ln.strip()
        if grab:
            if not s or (s.startswith("#") and not GAPKEY.search(s)):
                grab = 0
            else:
                out.append(ln.rstrip())
                grab -= 1
                continue
        if s and GAPKEY.search(s[:60]) and (s.startswith(("-", "*", "#", ">")) or re.match(r"[\w -]{2,24}:", s)):
            out.append(ln.rstrip())
            if s.startswith("#") or s.rstrip().endswith(":"):
                grab = 10
    return out[:14]


def artifacts():
    d = {}
    for p in glob.glob(os.path.join(ART, "*.md")):
        stem = os.path.basename(p)[:-3]
        d.setdefault(chain_of(stem), []).append((int((re.search(r"-r(\d+)$", stem) or [0, 0])[1]), p))
    return {c: sorted(v) for c, v in d.items()}


def live_units(chain):
    """live follow-up for the chain: agi-lane-<CHAIN>-* units, or a will whose artifact is in the chain."""
    ign = os.environ.get("LF_IGNORE_UNIT", "").removesuffix(".service")
    pat = re.compile(r"^agi-lane-" + re.escape(chain) + r"(-r\d+)?-\d+\.service$", re.I)
    r = subprocess.run(["systemctl", "--user", "list-units", "agi-lane-*", "--no-legend", "--no-pager", "--plain"],
                       capture_output=True, text=True)
    for ln in r.stdout.splitlines():
        f = ln.split()
        if f and pat.match(f[0]) and f[0].removesuffix(".service") != ign and f[3] in ("running", "start", "activating"):
            return f[0]
    for w in glob.glob(os.path.join(WILLS, "*.will")):
        t = read(w)
        a = re.search(r"^artifact=(.*)$", t, re.M)
        u = (re.search(r"^unit=(.*)$", t, re.M) or [0, "none"])[1].removesuffix(".service")
        if a and chain_of(os.path.basename(a.group(1))[:-3]).lower() == chain.lower() and u != ign:
            pid = (re.search(r"^pid=(\d+)", t, re.M) or [0, 0])[1]
            if os.path.isdir(f"/proc/{pid}") and int(pid) != os.getppid():
                return "will:" + os.path.basename(w)
    return None


def covered_by(chain, head_path, arts):
    """covered = a NEWER green/gated chain continues it: sibling prefix (brain-swap -> brain-swap-verify), or a chain
    whose artifacts cite this chain's stems >=3 times (hf-sim -> human-sim; a one-off incident mention doesn't count)."""
    mt = os.path.getmtime(head_path)
    stems = r"\b" + re.escape(chain) + r"-r\d+\b"
    for c, v in arts.items():
        if c == chain:
            continue
        hp = v[-1][1]
        if os.path.getmtime(hp) < mt or classify(read(hp))[0] not in ("GREEN", "GATED"):
            continue
        fam = [p for c2, v2 in arts.items() if c2 == c or c2.startswith(c + "-") for _, p in v2]
        if c.startswith(chain + "-") or sum(len(re.findall(stems, read(p))) for p in fam) >= 3:
            return os.path.basename(hp)
    return None


def meta_for(stem):
    """model + budget class of the original lane row (log.tsv by session name), fallback sonnet/25."""
    model, dur = None, 0
    for ln in read(os.path.join(LOGD, "log.tsv")).splitlines():
        f = ln.split("\t")
        if len(f) > 8 and f[2].lower() == stem.lower() and f[8] not in ("RUNNING",):
            model = f[3]
            dur = int(f[6]) if f[6].isdigit() else dur
    if model:
        return model, (25 if dur <= 1500 else 45), "orig-row"
    return os.environ.get("AGI_MODEL", "sonnet"), 25, "default"


def evaluate(path, arts):
    path = os.path.abspath(path)
    stem = os.path.basename(path)[:-3]
    chain = chain_of(stem)
    os.makedirs(CH, exist_ok=True)
    cf = lambda ext: os.path.join(CH, f"{chain}.{ext}")
    chain_arts = arts.get(chain, [(0, path)])
    head = chain_arts[-1][1]
    if head != path and os.path.getmtime(head) >= os.path.getmtime(path):
        return log(f"{chain}: skip {stem} — superseded by newer {os.path.basename(head)}")
    text = read(path)
    kind, words, vline = classify(text)
    if kind in ("GREEN", "GATED"):
        return log(f"{chain}: {stem} {words} — chain terminates, no dispatch")
    if kind == "NONE":
        return log(f"{chain}: {stem} no verdict line — nothing to do")
    for f in (cf("done"), os.path.join(CH, f"{stem}.done")):
        if os.path.exists(f):
            return log(f"{chain}: {stem} {words} — coordinator override {os.path.basename(f)}, no dispatch")
    with open(cf("lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        mark = f"{path} {int(os.path.getmtime(path))}"
        if read(cf("last")).strip() == mark:
            return log(f"{chain}: {stem} {words} — already acted on (dedupe)")
        u = live_units(chain)
        if u:
            return log(f"{chain}: {stem} {words} — live follow-up {u}, no dispatch (dedupe)")
        cov = covered_by(chain, path, arts)
        if cov:
            return log(f"{chain}: {stem} {words} — covered by {cov} (green), no dispatch")
        n = int(read(cf("n")).strip() or 0)
        hist = read(cf("v")).split()
        if n >= MAX:
            if not os.path.exists(cf("escalated")):
                vs = "/".join((hist + [words])[-3:])
                with open(STATUS, "a") as f:
                    f.write(f"chain-escalate {chain} — {MAX} attempts: {vs} {time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n")
                open(cf("escalated"), "w").write(vs)
                open(cf("last"), "w").write(mark)
                return log(f"{chain}: ESCALATE after {n} auto-iterations ({vs})")
            return log(f"{chain}: exhausted ({n}), already escalated — no dispatch")
        gaps = next_actions(text)
        missing = not gaps
        nxt = max(r for r, _ in chain_arts) + 1
        session = f"{chain}-r{nxt}".upper()
        out_art = os.path.join(ART, f"{chain}-r{nxt}.md")
        model, budget, src = meta_for(stem)
        gap_txt = "\n".join(gaps) if gaps else "(artifact carries NO next-actions block) — read the artifact and name the gaps yourself, then close them."
        brief = (f"{CANON}\n\nBUILD lane ({model}) — OWNER LAW better-loops: no lane ends PARTIAL and stops. AUTO-FOLLOWUP "
                 f"{n + 1}/{MAX} of chain '{chain}'. Artifact {os.path.relpath(out_art, BIF) if out_art.startswith(BIF) else out_art} "
                 f"≤10 lines, first line '# {chain}-r{nxt} — VERDICT: <DONE-GREEN|OWNER-GATED|PARTIAL|BLOCKED>'; a PARTIAL/BLOCKED/RIG "
                 f"artifact MUST carry a 'Next-actions:' block. Budget {budget}min.\n\nPrior artifact: {path}\nPrior verdict line (exact): {vline}\n"
                 f"Next-actions/gap lines from the prior artifact (exact):\n{gap_txt}\n\nClose exactly these gaps; don't touch pwa/brain live.")
        pf = os.path.join(CH, f"{chain}.r{nxt}.prompt")
        open(pf, "w").write(brief)
        log(f"{chain}: DISPATCH {n + 1}/{MAX} session={session} model={model} budget={budget}min class-src={src} trigger={words}"
            f"{' MISSING-NEXT-ACTIONS' if missing else ''} artifact={out_art} prompt={pf}{' DRY' if DRY else ''}")
        if not DRY:
            r = subprocess.run([AGI_RUN, "-s", session, "-m", model, "-a", out_art, "-b", str(budget), "-f", pf],
                               cwd=BIF, capture_output=True, text=True, env={**os.environ, "AGI_FOLLOWUP": "1", "AGI_DETACH": "1"})
            if r.returncode != 0:
                return log(f"{chain}: agi-run FAILED rc={r.returncode} {r.stderr.strip()[:200]} — counter not advanced")
        open(cf("n"), "w").write(str(n + 1))
        open(cf("v"), "a").write(words + "\n")
        open(cf("last"), "w").write(mark)


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit("usage: lane-followup.sh ARTIFACT.md | --sweep")
    arts = artifacts()
    if a[0] == "--sweep":
        cut = time.time() - 48 * 3600
        heads = sorted({v[-1][1] for v in arts.values()})
        for p in heads:
            if os.path.getmtime(p) >= cut and classify(read(p))[0] == "BAD":
                evaluate(p, arts)
        return
    if not os.path.isfile(a[0]):
        return log(f"{a[0]}: not a file — skip")
    evaluate(a[0], arts)


main()
