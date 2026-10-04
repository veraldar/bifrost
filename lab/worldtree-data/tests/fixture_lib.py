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
    # The catalog is always current (see above); when it gained series after a fixture was
    # frozen (e.g. the 0.4.0 geo layer vs the 0.3.1 tree), copy those series' raw from the
    # live tree so build_all can run. Frozen world-series raws are never replaced: copy only
    # series with no raw of that ext in the fixture at all.
    from wt.common import load_series
    from wt.extract import ext_of, snapshot
    for sid, s in load_series().items():
        if s["stage"] != "core":
            continue
        d = tmp / "raw" / s["source_id"] / s["slug"]
        if not any(d.glob(f"*.{ext_of(s)}.prov.json")):
            try:
                p, meta = snapshot(s["source_id"], s["slug"], ext_of(s), "9999-12-31")
            except FileNotFoundError:
                continue
            shutil.copytree(p.parent, d, dirs_exist_ok=True)
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
