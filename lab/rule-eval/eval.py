#!/usr/bin/env python3
"""rule-eval state machine — proposed -> measuring -> promoted | sunset.

Reads the register (candidates.yaml) + the ledger (rule-eval.jsonl), applies
the protocol (protocol.md §1), updates register states/points, appends
promote/sunset/measure events, writes a dated scorecard.

    python3 eval.py            # evaluate all candidates
    python3 eval.py --dry      # print verdicts, write nothing
"""
import argparse, json, re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

HERE = Path(__file__).parent
LEDGER = Path.home() / ".local/share/bifrost/bench/rule-eval.jsonl"
REGISTER = HERE / "candidates.yaml"
SCORECARDS = HERE / "scorecards"
WINDOW_DAYS = 7
MIN_POINTS = 3            # trend = >=3 measurement points (protocol 1d)
GUARD_ABS_S = 1.0         # discovery failure mode is seconds, not ms
GUARD_MULT = 4.0          # or >4x the baseline-corroboration probe


def parse_ts(ts) -> datetime:
    if isinstance(ts, datetime):
        d = ts
    else:
        d = datetime.fromisoformat(str(ts))
    if d.tzinfo is None:
        d = d.astimezone()  # assume local
    return d


def load_ledger(candidate: str) -> list:
    if not LEDGER.exists():
        return []
    rows = []
    for line in LEDGER.read_text().splitlines():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("candidate") == candidate:
            rows.append(r)
    return rows


def store_of(row: dict) -> str:
    m = re.search(r"store=:(\d+)", row.get("notes") or "")
    return m.group(1) if m else "?"


def evaluate(c: dict, dry: bool = False) -> dict:
    """Apply the state machine to one candidate; returns its verdict."""
    cid = c["id"]
    prior_state = c["state"]
    rows = load_ledger(cid)
    events = [r for r in rows if r.get("kind") == "event"]
    meas = [r for r in rows if r.get("kind") == "measurement"]

    primary = c["metrics"]["primary"]
    guard = c["guard"]["metric"]
    m = re.search(r"<=\s*([\d.]+)", c.get("target") or "")
    target_max = float(m.group(1)) if m else None

    base = c.get("baseline", {})
    base_val = base.get("value")
    base_ok = bool(base_val is not None and base.get("citation"))
    points = sorted((r for r in meas if r["metric"] == primary), key=lambda r: r["ts"])

    # split baseline-corroboration (measured on the pre-change store) from post points
    base_probe_store = str(base.get("probe_store", ""))
    post = [r for r in points if store_of(r) != base_probe_store]
    corrobor = [r for r in points if store_of(r) == base_probe_store]

    verdict = {"candidate": cid, "state": c["state"], "events": len(events)}
    reasons = []

    # (b) baseline must exist before anything moves
    if c["state"] == "proposed":
        if base_ok:
            c["state"] = "measuring"; c["since"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
            reasons.append("baseline present -> MEASURING")
        else:
            reasons.append("no baseline (value+citation) -> stays PROPOSED, cannot measure")

    # latest guard reading
    guards = sorted((r for r in meas if r["metric"] == guard), key=lambda r: r["ts"])
    g = guards[-1] if guards else None
    guard_ok = True
    if g and base_probe_store:
        gcorrob = [r for r in corrobor if r["metric"] == guard]
        gbase = gcorrob[-1]["value"] if gcorrob else base_val
        limit = max(GUARD_ABS_S, (gbase or 0) * GUARD_MULT)
        guard_ok = bool(g["ok"]) and g["value"] <= limit
        verdict["guard_value"] = g["value"]

    # (c)+(d) target met at >=MIN_POINTS post-adoption points, guard not regressed
    met = [r for r in post if target_max is not None and r["value"] <= target_max]
    verdict.update(points_total=len(post), points_met=len(met),
                   latest={k: post[-1][k] for k in ("ts", "value")} if post else None)
    if post:
        verdict["latest_notes"] = post[-1]["notes"][:220]

    now = datetime.now(timezone.utc).astimezone()
    window_end = parse_ts(c["since"]) + timedelta(days=WINDOW_DAYS) if c.get("since") else None
    verdict["window_end"] = window_end.isoformat(timespec="seconds") if window_end else None

    if c["state"] == "measuring":
        if len(met) >= MIN_POINTS and guard_ok:
            c["state"] = "promoted"
            reasons.append(f"target met at {len(met)}/{len(post)} points, guard ok -> PROMOTED")
        elif window_end and now > window_end:
            c["state"] = "sunset"
            reasons.append(f"window ended {window_end.date()} without a validated trend -> AUTO-SUNSET")
        else:
            need = MIN_POINTS - len(met)
            reasons.append(f"MEASURING: target met at {len(met)} point(s); "
                           f"needs {max(need, 0)} more + guard ok; auto-sunset {window_end.date() if window_end else '?'}")
    elif c["state"] == "promoted":
        latest_ok = bool(post) and post[-1]["value"] <= target_max
        if (post and not latest_ok) or not guard_ok:
            c["state"] = "measuring"
            reasons.append("latest point missed target or guard regressed -> back to MEASURING")
        else:
            reasons.append("PROMOTED and still holding")

    verdict["reasons"] = reasons
    verdict["verdict"] = c["state"].upper()

    # loss side (honesty row): from latest noise-ratio notes, if any
    noises = sorted((r for r in meas if r["metric"] == "noise_ratio"), key=lambda r: r["ts"])
    if noises:
        verdict["loss_notes"] = noises[-1]["notes"][:400]

    if not dry:
        c["points"] = [{"ts": r["ts"], "metric": r["metric"], "value": r["value"],
                        "store": store_of(r), "ok": r["ok"]} for r in points[-12:]]
        if c["state"] != prior_state:
            event = {"ts": now.isoformat(timespec="seconds"), "kind": "event",
                     "candidate": cid, "event": c["state"], "reason": "; ".join(reasons)}
            with LEDGER.open("a") as f:
                f.write(json.dumps(event, sort_keys=True) + "\n")
    return verdict


def write_register(cands: list, dry: bool):
    if dry:
        return
    REGISTER.write_text(yaml.safe_dump({"candidates": cands}, sort_keys=False, allow_unicode=True))


def scorecard(verdicts: list, dry: bool) -> str:
    day = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d")
    lines = [f"# rule-eval scorecard — {day}", "",
             "State machine output for the current register (protocol.md §1).", ""]
    for v in verdicts:
        lines += [f"## {v['candidate']} — {v['verdict']}",
                  f"- points: {v.get('points_met', 0)}/{v.get('points_total', 0)} met target"
                  f" · guard: {v.get('guard_value', 'n/a')}",
                  f"- latest: {v.get('latest')}", "- reasons: " + " · ".join(v["reasons"])]
        if v.get("loss_notes"):
            lines.append(f"- loss side: `{v['loss_notes']}`")
        lines.append("")
    text = "\n".join(lines)
    if not dry:
        SCORECARDS.mkdir(exist_ok=True)
        (SCORECARDS / f"rule-eval-{day}.md").write_text(text)
    return text


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    reg = yaml.safe_load(REGISTER.read_text())
    verdicts = [evaluate(c, a.dry) for c in reg["candidates"]]
    if not a.dry:
        write_register(reg["candidates"], a.dry)
    print(scorecard(verdicts, a.dry))
