"""Git helpers for `run --commit` (a commit only when a tracked file changed; the per-run marker is ledger.jsonl)."""
import subprocess

from .common import root


def _git(*args, check=True):
    return subprocess.run(["git", "-C", str(root()), *args], check=check, capture_output=True, text=True)


def head_commit():
    r = _git("rev-parse", "HEAD", check=False)
    return r.stdout.strip() if r.returncode == 0 else None


def commit_run(run_id, published, first_fail):
    """Commit a run only when it changed a tracked file. A run that changed nothing (the normal night: raw/series/
    runs/out are gitignored) leaves NO trunk commit; its marker is the ledger line (wt/ledger.py), S17."""
    msg = f"run {run_id}: published" if published else f"run {run_id}: held — {first_fail}"
    # pathspec "." = this lab dir only: R sits inside the bifrost repo, and a bare
    # `add -A` stages every other session's work (run 20261004T081621Z did).
    _git("add", "-A", "--", ".")
    if _git("diff", "--cached", "--quiet", "--", ".", check=False).returncode == 0:
        return None
    _git("commit", "-q", "-m", msg, "--", ".")
    return msg
