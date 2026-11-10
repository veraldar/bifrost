"""Deterministic graders — pure functions, no LLM judge in v1 (LLM judge = v2).

Every method maps a task's grade spec + the model's reply to a score in [0, 1].
Determinism rule: same inputs -> same score, always. No network, no clock, no RNG.
"""
from __future__ import annotations

import importlib
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SUITE = Path(__file__).resolve().parent


def _norm(s: str) -> str:
    """Lowercase, collapse whitespace — the only normalization graders may do."""
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def word_count(s: str) -> int:
    """Voice-brevity words: whitespace-split; hyphenated counts as one."""
    return len((s or "").split())


# ---- methods ---------------------------------------------------------------

def grade_contains(reply: str, spec: dict) -> tuple[float, str]:
    """Every string in spec['expected'] appears (case-insensitive)."""
    hay = _norm(reply)
    missing = [e for e in spec["expected"] if _norm(e) not in hay]
    if not missing:
        return 1.0, ""
    return round(1 - len(missing) / len(spec["expected"]), 3), f"missing {missing}"


def grade_not_contains(reply: str, spec: dict) -> tuple[float, str]:
    """None of spec['expected'] appear (case-insensitive)."""
    hay = _norm(reply)
    present = [e for e in spec["expected"] if _norm(e) in hay]
    if not present:
        return 1.0, ""
    return 0.0, f"forbidden present: {present}"


def grade_contains_and_not_contains(reply: str, spec: dict) -> tuple[float, str]:
    """spec['expected'] all present AND spec['forbidden'] all absent. 0.5 per half."""
    s1, n1 = grade_contains(reply, spec)
    s2, n2 = grade_not_contains(reply, {"expected": spec.get("forbidden", [])})
    return round((s1 + s2) / 2, 3), "; ".join(x for x in (n1, n2) if x)


def grade_word_cap(reply: str, spec: dict) -> tuple[float, str]:
    """spec['expected']: {max, contains?}. Cap is hard: over = 0 on the cap half."""
    exp = spec["expected"]
    n = word_count(reply)
    cap_ok = n <= exp["max"]
    cap_score = 1.0 if cap_ok else 0.0
    note = "" if cap_ok else f"{n} words > cap {exp['max']}"
    if exp.get("contains"):
        s, n2 = grade_contains(reply, {"expected": exp["contains"]})
        return round((cap_score + s) / 2, 3), "; ".join(x for x in (note, n2) if x)
    return cap_score, note


def grade_code(reply: str, spec: dict) -> tuple[float, str]:
    """Hidden pytest suite vs the model's submitted module.

    The model may (a) emit a fenced python block — preferred, or (b) write the file
    with tools. If (b) the adapter notes the path in the reply's trailing
    'HARNESS-BENCH:FILE <path>' line; otherwise a fenced block is extracted.
    Returns fraction of hidden tests passed; import errors score 0.
    """
    # 1. locate submitted source
    src = None
    m = re.search(r"HARNESS-BENCH:FILE (\S+)", reply or "")
    if m and Path(m.group(1)).is_file():
        src = Path(m.group(1)).read_text()
    if src is None:
        blocks = re.findall(r"```(?:python|py)\s*\n(.*?)```", reply or "", re.S)
        if not blocks:
            return 0.0, "no code block in reply and no file marker"
        src = max(blocks, key=len)  # biggest block wins
        if spec["expected"]["filename"] not in src and not re.search(r"^def |^class |^import |^from ",
                                                                     src, re.M):
            return 0.0, "code block does not look like a module"
    # 2. stage submitted module in a throwaway dir
    import os
    with tempfile.TemporaryDirectory(prefix="hb-submit-") as td:
        sub = Path(td) / spec["expected"]["filename"]
        sub.write_text(src)
        tests_dir = SUITE / "tests" / spec["expected"]["tests_dir"].removeprefix("tests/")
        # copy the hidden suite NEXT TO the submitted module: conftest.py is then
        # discovered (registers --submitted), and plain `import <mod>` resolves since
        # pytest prepends the test file's dir to sys.path.
        for f in tests_dir.iterdir():
            if f.suffix == ".py":
                (Path(td) / f.name).write_text(f.read_text())
        (Path(td) / "conftest.py").write_text((SUITE / "tests" / "conftest.py").read_text())
        # 3. run the hidden suite (own tmp import path; -p no:cacheprovider keeps it clean)
        py = os.environ.get("HB_PYTHON", sys.executable)
        cmd = [py, "-m", "pytest", "-q", "--tb=no", "-p", "no:cacheprovider",
               f"--submitted={sub.parent}", str(td)]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60, cwd=td,
                               env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1",
                                    "HB_PYTHON": py})
        except subprocess.TimeoutExpired:
            return 0.0, "hidden tests timed out (60s)"
        if not r.stdout.strip():
            return 0.0, f"pytest produced no output: {r.stderr[:160]!r}"
        # count outcomes from the summary tail line, e.g. "3 failed, 2 passed in 0.1s"
        tail = r.stdout.strip().splitlines()[-1]
        nums = {word: int(n) for n, word in re.findall(r"(\d+) (passed|failed|error)", tail)}
        total = sum(nums.values())
        if total == 0:
            return 0.0, f"no tests ran: {tail[:120]!r} stderr={r.stderr[:120]!r}"
        return round(nums.get("passed", 0) / total, 3), tail[:120]


GRADERS = {
    "contains": grade_contains,
    "not_contains": grade_not_contains,
    "contains_and_not_contains": grade_contains_and_not_contains,
    "word_cap": grade_word_cap,
    "code": grade_code,
}


def grade(task: dict, reply: str) -> tuple[float, str]:
    fn = GRADERS.get(task["grade"]["method"])
    if fn is None:
        return 0.0, f"unknown grade method {task['grade']['method']}"
    try:
        return fn(reply, task["grade"])
    except Exception as e:  # a grader must never crash the run
        return 0.0, f"grader exception: {type(e).__name__}: {e}"
