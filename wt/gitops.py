"""Git helpers for `run --commit` (one commit per run, schema.md §1)."""
import subprocess

from .common import root


def _git(*args, check=True):
    return subprocess.run(["git", "-C", str(root()), *args], check=check, capture_output=True, text=True)


def head_commit():
    r = _git("rev-parse", "HEAD", check=False)
    return r.stdout.strip() if r.returncode == 0 else None


def commit_run(run_id, published, first_fail):
    msg = f"run {run_id}: published" if published else f"run {run_id}: held — {first_fail}"
    _git("add", "-A")
    _git("commit", "-q", "-m", msg)
    return msg
