#!/usr/bin/env python3
"""Freeze tests/fixtures/<method version>/ from the current repo (plan.md step 9, prediction.md §6).
Copies every raw snapshot the series of this as-of read (with sidecars), writes as_of/now, runs the
pipeline on a temp copy and stores the expected realms.json + provenance.json.
Usage: python3 tests/make_fixture.py <as_of> <now>"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

R = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(R))
sys.path.insert(0, str(R / "tests"))
from fixture_lib import run_fixture  # noqa: E402

from wt.common import load_series, method_version  # noqa: E402
from wt.extract import ext_of, snapshot  # noqa: E402


def main(as_of, now):
    fx = R / "tests" / "fixtures" / method_version()
    if fx.exists():
        shutil.rmtree(fx)
    for sid, s in load_series().items():
        if s["stage"] != "core":
            continue
        p, meta = snapshot(s["source_id"], s["slug"], ext_of(s), as_of)
        for f in (p, Path(str(p) + ".prov.json")):
            dst = fx / f.relative_to(R)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, dst)
    (fx / "as_of").write_text(as_of + "\n")
    (fx / "now").write_text(now + "\n")
    with tempfile.TemporaryDirectory() as tmp:
        out = run_fixture(fx, Path(tmp))
        shutil.copyfile(out / "realms.json", fx / "realms.json")
        shutil.copyfile(out / "realms.provenance.json", fx / "provenance.json")
    print("fixture", fx.relative_to(R), json.loads((fx / "realms.json").read_text())["weights"])


if __name__ == "__main__":
    main(*sys.argv[1:3])
