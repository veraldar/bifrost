"""Run the pipeline against a fixture tree in a temp copy (WT_ROOT); current code + current catalog."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

R = Path(__file__).resolve().parent.parent


def run_fixture(fx: Path, tmp: Path) -> Path:
    shutil.copytree(fx / "raw", tmp / "raw")
    shutil.copytree(R / "catalog", tmp / "catalog")
    shutil.copytree(R / "method", tmp / "method")
    for d in ("series", "runs", "out"):
        (tmp / d).mkdir()
    as_of = (fx / "as_of").read_text().strip()
    now = (fx / "now").read_text().strip()
    env = dict(os.environ, WT_ROOT=str(tmp))
    env.pop("WT_CATALOG", None)
    p = subprocess.run([sys.executable, "-m", "wt", "run", "--as-of", as_of, "--now", now, "--no-fetch"],
                   cwd=R, env=env, check=False, capture_output=True, text=True)
    if p.returncode != 0:
        print(p.stderr[-1500:], file=sys.stderr)
        raise SystemExit(f"fixture run failed rc={p.returncode}")
    return tmp / "out"
