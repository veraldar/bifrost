"""CLI: python3 -m wt <cmd> (plan.md conventions)."""
import argparse
import sys


def main(argv=None):
    ap = argparse.ArgumentParser(prog="wt")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("what", choices=["catalog", "integrity"])
    f = sub.add_parser("fetch")
    f.add_argument("--source", default="")
    s = sub.add_parser("series")
    s.add_argument("--as-of", required=True)
    r = sub.add_parser("run")
    r.add_argument("--as-of", required=True)
    r.add_argument("--now")
    r.add_argument("--no-fetch", action="store_true")
    r.add_argument("--commit", action="store_true")
    h = sub.add_parser("history")
    h.add_argument("--as-of", required=True)
    h.add_argument("--now")
    h.add_argument("--out")
    c = sub.add_parser("countries")
    c.add_argument("--as-of", required=True)
    c.add_argument("--now")
    c.add_argument("--no-commit", action="store_true")
    mp = sub.add_parser("mapdata")
    a = ap.parse_args(argv)

    if a.cmd == "check" and a.what == "catalog":
        from .catalog import check
        errs, ns, nr, ngr = check()
        if errs:
            for e in errs:
                print("catalog FAIL:", e, file=sys.stderr)
            return 1
        print(f"catalog OK {ns} series {nr} rows {ngr} geo rows")
        return 0
    if a.cmd == "check" and a.what == "integrity":
        from .integrity import check_all
        bad, n = check_all()
        if bad:
            for b in bad:
                print("integrity FAIL:", b, file=sys.stderr)
            return 1
        print(f"integrity OK {n}")
        return 0
    if a.cmd == "fetch":
        from .fetch import fetch
        srcs = [x for x in a.source.split(",") if x] or None
        return fetch(srcs)
    if a.cmd == "series":
        from .extract import build_all
        build_all(a.as_of)
        return 0
    if a.cmd == "mapdata":
        from .mapdata import build
        return build()
    if a.cmd == "countries":
        from .countries import main as countries_main
        return countries_main(a.as_of, now=a.now, no_commit=a.no_commit)
    if a.cmd == "run":
        from .run import main as run_main
        return run_main(a.as_of, now=a.now, no_fetch=a.no_fetch, commit=a.commit)
    if a.cmd == "history":
        from .history import main as history_main
        return history_main(a.as_of, now=a.now, out=a.out)
    return 2


if __name__ == "__main__":
    sys.exit(main())
