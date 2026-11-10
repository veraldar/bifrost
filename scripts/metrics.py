#!/usr/bin/env python3
"""metrics.py — the evolution-metrics ledger (v07-reflection-and-plan §9.4, lane S14).

Six fixed metrics, every wave, always with a build hash and a device class:
  e2e_pass_rate  flake_rate  voice_rtt  wedge_count  gate_green  uptime
Rows live in docs/metrics/waves/<wave>.jsonl (one JSON object per line);
docs/metrics/index.jsonl is derived from them. Every table, block and chart is
regenerated from the JSONL alone — never from prose.

  metrics.py append   --wave W [--ts D] --metric M --value V ...      one row by hand
  metrics.py append   --wave W --from playwright|sim|agi|voice FILE   an adapter
  metrics.py backfill                                                 the §9.4 history
  metrics.py report   [--wave W [--md] [--check FILE]] [--all]        six-row block / table
  metrics.py month    YYYY-MM [--svg PATH]                            table + chart
  metrics.py index                                                    rebuild index.jsonl

Read-only on everything but docs/metrics/ and the --svg path. No network, no live.
"""
import argparse, glob, hashlib, json, os, re, statistics, subprocess, sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MET = os.environ.get("METRICS_DIR") or os.path.join(ROOT, "docs", "metrics")  # override: the spec runs on a scratch copy
WAVES = os.path.join(MET, "waves")
INDEX = os.path.join(MET, "index.jsonl")

SIX = ["e2e_pass_rate", "flake_rate", "voice_rtt", "wedge_count", "gate_green", "uptime"]
LABEL = {"e2e_pass_rate": "e2e pass rate", "flake_rate": "flake rate", "voice_rtt": "voice round-trip",
         "wedge_count": "wedge count", "gate_green": "gate items green", "uptime": "session uptime"}
# what stands in the way of collecting each metric (§9.4), shown when a wave has no row
MISSING = {
    "e2e_pass_rate": "no Playwright JSON for this wave",
    "flake_rate": "needs `--retries=1` in the referee run + the N=3 rerun step",
    "voice_rtt": "needs the `voice.turn` diag line (S1/T2)",
    "wedge_count": "needs the daily wedge count",
    "gate_green": "needs the gate in machine form",
    "uptime": "needs the quick-gate probe timer",
}
UNIT = {"e2e_pass_rate": "ratio", "flake_rate": "ratio", "voice_rtt": "ms", "wedge_count": "per100",
        "gate_green": "ratio", "uptime": "ratio"}
SRC_KINDS = ("you", "e2e", "sim")


# ───────────────────────── rows ─────────────────────────
def validate(r):
    for k in ("v", "ts", "wave", "metric", "build", "device", "from"):
        if r.get(k) in (None, ""):
            raise ValueError(f"row missing {k!r}: {r}")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", r["ts"]):
        raise ValueError(f"ts must be YYYY-MM-DD: {r['ts']}")
    if r["metric"] not in SIX and not r["metric"].startswith("x."):
        raise ValueError(f"metric {r['metric']!r}: one of {SIX} or x.<name>")
    if r.get("value") is not None and not isinstance(r["value"], (int, float)):
        raise ValueError("value must be a number or null")
    return r


def key(r):
    return (r["metric"], r.get("suite", ""), r.get("src_kind", ""), r.get("leg", ""))


def row(wave, ts, metric, value, build, device, frm, **kw):
    r = {"v": 1, "ts": ts, "wave": wave, "metric": metric, "value": value, "unit": UNIT.get(metric, kw.pop("unit", "")),
         "build": build, "device": device, "from": frm}
    r.update({k: v for k, v in kw.items() if v is not None})
    return validate(r)


def rate(num, den):
    return round(num / den, 4) if den else None


def wave_path(w):
    return os.path.join(WAVES, f"{w}.jsonl")


def read_wave(w):
    p = wave_path(w)
    if not os.path.exists(p):
        return []
    return [json.loads(l) for l in open(p) if l.strip()]


def write_wave(w, rows):
    os.makedirs(WAVES, exist_ok=True)
    rows = sorted(rows, key=lambda r: (SIX.index(r["metric"]) if r["metric"] in SIX else 99, r["metric"], key(r)))
    with open(wave_path(w), "w") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n")


def upsert(w, new):
    """Replace rows with the same key, keep the rest."""
    cur = {key(r): r for r in read_wave(w)}
    for r in new:
        cur[key(validate(r))] = r
    write_wave(w, list(cur.values()))
    rebuild_index()


def all_rows():
    out = []
    for p in sorted(glob.glob(os.path.join(WAVES, "*.jsonl"))):
        out += [json.loads(l) for l in open(p) if l.strip()]
    return out


def rebuild_index():
    os.makedirs(MET, exist_ok=True)
    lines = []
    for p in sorted(glob.glob(os.path.join(WAVES, "*.jsonl"))):
        rows = [json.loads(l) for l in open(p) if l.strip()]
        if not rows:
            continue
        lines.append({"wave": os.path.basename(p)[:-6], "ts": min(r["ts"] for r in rows),
                      "file": f"waves/{os.path.basename(p)}", "rows": len(rows),
                      "metrics": sorted({r["metric"] for r in rows}),
                      "builds": sorted({r["build"] for r in rows}),
                      "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]})
    lines.sort(key=lambda l: (l["ts"], l["wave"]))
    with open(INDEX, "w") as f:
        for l in lines:
            f.write(json.dumps(l, sort_keys=True) + "\n")


# ───────────────────────── adapters ─────────────────────────
def adapt_playwright(path, wave, ts, build, device):
    """Playwright JSON reporter → e2e_pass_rate + flake_rate. Passed = expected + flaky."""
    d = json.load(open(path))
    st = d.get("stats", {})
    fails, flaky_names = [], []

    def walk(s, title):
        for sp in s.get("specs", []):
            for t in sp.get("tests", []):
                name = f"{title} {sp['title']}".strip()
                if t.get("status") == "unexpected":
                    fails.append(name)
                elif t.get("status") == "flaky":
                    flaky_names.append(name)
        for c in s.get("suites", []):
            walk(c, c.get("title", "") if not title else title)

    for s in d.get("suites", []):
        walk(s, s.get("title", ""))
    exp, unexp, flaky, skipped = (st.get(k, 0) for k in ("expected", "unexpected", "flaky", "skipped"))
    ran = exp + unexp + flaky
    suite = os.path.basename(path).replace(".json", "")
    frm = os.path.relpath(path, ROOT) if path.startswith(ROOT) else path
    return [
        row(wave, ts, "e2e_pass_rate", rate(exp + flaky, ran), build, device, frm, suite=suite, num=exp + flaky, den=ran,
            skipped=skipped, detail={"failed": fails[:20]}),
        row(wave, ts, "flake_rate", rate(flaky, ran), build, device, frm, suite=suite, num=flaky, den=ran,
            detail={"flaky": flaky_names[:20]}),
    ]


def cycle_rows(path, wave, ts, device="phone-sim"):
    c = json.load(open(path))
    frm = os.path.relpath(path, ROOT) if path.startswith(ROOT) else path
    build = f"app{c['app_version']}+sim{c['sim_version']}" if c.get("app_version") else "n/r"
    p, f = c["pass"], c["fail"]
    out = [row(wave, ts, "e2e_pass_rate", rate(p, p + f), build, device, frm, suite="ygg-sim", num=p, den=p + f,
               detail={"ran": c["ran"], "break_ok": c["break_ok"], "known": c["known"], "skip": c.get("skip", 0),
                       "wall_s": c.get("wall_s")})]
    for s in c["scenarios"]:
        if s["name"] == "bridge.handsfree-round":
            m = re.search(r"(\d+)ms", s["headline"])
            if m:
                out.append(row(wave, ts, "voice_rtt", int(m.group(1)), build, device, frm, src_kind="sim",
                               leg="handsfree_turn", n=1, p50=int(m.group(1)), p95=int(m.group(1)),
                               note="whole sim turn (speech in → reply audio out); the 8 s target applies"))
    if isinstance(c.get("slo"), dict):
        out.append(row(wave, ts, "x.slo_held", rate(c["slo"]["held"], c["slo"]["checked"]), build, device, frm,
                       unit="ratio", num=c["slo"]["held"], den=c["slo"]["checked"]))
    out.append(row(wave, ts, "x.scenarios", c["ran"], build, device, frm, unit="count"))
    return out


def adapt_sim(path, wave, ts, build, device):
    return cycle_rows(path, wave, ts, device or "phone-sim")


def parse_agi(path):
    """log.tsv: id date name model start end secs exit status out -. Last row per id wins."""
    last = {}
    for l in open(path):
        c = l.rstrip("\n").split("\t")
        if len(c) >= 9:
            last[c[0]] = c
    return last


def adapt_agi(path, wave, ts, build, device):
    """Lane exits per day (counts only — the log records that a lane exited, not that its gate went green)."""
    last = parse_agi(path)
    by = {}
    for c in last.values():
        by.setdefault(c[1], []).append(c)
    out = []
    frm = os.path.relpath(path, ROOT) if path.startswith(ROOT) else path
    for day, cs in sorted(by.items()):
        if ts and day != ts:
            continue
        ended = [c for c in cs if c[8] != "RUNNING"]
        if not ended:
            continue
        ok = [c for c in ended if c[8] == "OK"]
        secs = [int(c[6]) for c in ended if c[6].isdigit()]
        out.append(row(f"agi-{day}", day, "x.lane_ok_rate", rate(len(ok), len(ended)), build or "n/a", device or "box", frm,
                       unit="ratio", num=len(ok), den=len(ended),
                       detail={"statuses": {s: sum(1 for c in ended if c[8] == s) for s in sorted({c[8] for c in ended})},
                               "median_min": round(statistics.median(secs) / 60, 1) if secs else None,
                               "total_h": round(sum(secs) / 3600, 2)},
                       note="exit status only; whether the lane's gate went green is not in the log"))
    return out


def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    i = (len(xs) - 1) * q
    lo, hi = int(i), min(int(i) + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (i - lo))


def adapt_voice(path, wave, ts, build, device):
    """Nightly digest of `voice.turn {json}` diag lines → p50/p95 per source × leg.
    Dedupes the double-written lines by (run_id, ts-to-the-second); drops dup:true turns from the percentiles
    but counts them. Returns [] when the log has no such line — the metric then reads 'not collected'."""
    seen, turns = set(), []
    for l in open(path):
        m = re.search(r"voice\.turn\s+(\{.*\})", l)
        if not m:
            continue
        try:
            t = json.loads(m.group(1))
        except ValueError:
            continue
        k = (t.get("run_id"), t.get("source"), t.get("release_to_transcript"), t.get("release_to_first_audio"))
        if k in seen:
            continue
        seen.add(k)
        turns.append(t)
    out = []
    frm = os.path.relpath(path, ROOT) if path.startswith(ROOT) else path
    for src in SRC_KINDS:
        ts_ = [t for t in turns if t.get("source") == src]
        if not ts_:
            continue
        dups = sum(1 for t in ts_ if t.get("dup"))
        live = [t for t in ts_ if not t.get("dup")]
        for leg, field in (("transcript", "release_to_transcript"), ("first_audio", "release_to_first_audio")):
            xs = [t[field] for t in live if isinstance(t.get(field), (int, float))]
            if xs:
                out.append(row(wave, ts, "voice_rtt", pct(xs, .5), build, device, frm, src_kind=src, leg=leg, n=len(xs),
                               p50=pct(xs, .5), p95=pct(xs, .95), dup_turns=dups))
    return out


ADAPTERS = {"playwright": adapt_playwright, "sim": adapt_sim, "agi": adapt_agi, "voice": adapt_voice}


# ───────────────────────── the §9.4 backfill ─────────────────────────
# Prose-sourced numbers carry the report they were read from in `from`. Anything the prose does
# not state (fail names, flake counts, build hashes) is left out, not guessed.
R = "docs/reviews/"
E2E = [  # wave, ts, build, device, suite, passed, failed, skipped, from, note
    ("2026-10-19-onboarding-build", "2026-10-19", "sandbox@2026-10-19", "desktop-chromium", "general", 22, 10, 3,
     R + "onboarding-build-report.md", "shared the store with a concurrent repro; 4 of the 10 pass on rerun"),
    ("2026-10-22-door-v3", "2026-10-22", "sandbox@door-v3", "desktop-chromium", "general", 33, 9, 2,
     R + "door-v3-report.md", "0 regressions: 6 yggdrasil-vs-opencode, 2 other lanes' specs"),
    ("2026-10-24-ab1-pre-batch", "2026-10-24", "d7a131e", "desktop-chromium", "general", 35, 4, None,
     R + "v07-gate-final.md#wave-1", "A/B baseline, original specs; the 4 are env, not code"),
    ("2026-10-24-ab2-batch", "2026-10-24", "008d8b4", "desktop-chromium", "general", 42, 4, None,
     R + "v07-gate-final.md#wave-1", "same 4 failures, byte-identical; 7 extra passes are the batch's specs"),
    ("2026-10-24-v07-gate-final", "2026-10-24", "dBAzIRkZMnA43odv0JWmO", "desktop-chromium", "general", 57, 0, 2,
     R + "v07-gate-final.md", "2 skips catalog-conditional (OG-think)"),
]
SUITES_FINAL = [("onboarding", 8, 0), ("mainframe-c", 12, 0), ("herdr-pins", 3, 0)]
LKV = [("2026-09-24", 10, "8 → 10 passed, green ×4"), ("2026-10-23", 45, None), ("2026-10-24", 43, None),
       ("2026-10-25", 45, None), ("2026-10-26", 45, None)]


def cycle_dates():
    out = {}
    for p in sorted(glob.glob(os.path.join(ROOT, "lab/ygg-sim/report/cycles/cycle-*.json"))):
        n = int(re.search(r"cycle-(\d+)", p).group(1))
        try:
            d = subprocess.run(["git", "-C", ROOT, "log", "-1", "--format=%ad", "--date=short", "--", p],
                               capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception:
            d = ""
        out[n] = (p, d or datetime.fromtimestamp(os.path.getmtime(p)).strftime("%Y-%m-%d"))
    return out


def backfill():
    done = []
    # 1) ygg-sim cycles — structured JSON, the only true series
    for n, (p, d) in cycle_dates().items():
        w = f"{d}-sim-c{n}"
        write_wave(w, cycle_rows(p, w, d))
        done.append(w)
    # 2) e2e waves from the wave reports
    for w, ts, build, dev, suite, ok, bad, skip, frm, note in E2E:
        write_wave(w, [row(w, ts, "e2e_pass_rate", rate(ok, ok + bad), build, dev, frm, suite=suite, num=ok, den=ok + bad,
                           skipped=skip, note=note)])
        done.append(w)
    w = "2026-10-24-v07-gate-final"
    cur = read_wave(w)
    for s, ok, bad in SUITES_FINAL:
        cur.append(row(w, "2026-10-24", "e2e_pass_rate", rate(ok, ok + bad), "dBAzIRkZMnA43odv0JWmO", "desktop-chromium",
                       R + "v07-gate-final.md", suite=s, num=ok, den=ok + bad))
    cur.append(row(w, "2026-10-24", "voice_rtt", 804, "dBAzIRkZMnA43odv0JWmO", "desktop-chromium", R + "v07-gate-final.md",
                   src_kind="e2e", leg="transcript", n=1, p50=804, p95=804, note="first real voice turn, release → transcript"))
    write_wave(w, cur)
    # 3) the real chain, measured once (artifacts/agi-loop-metrics.json, n = 3)
    w = "2026-10-04-voice-chain"
    stt = [1221, 918, 584]
    write_wave(w, [row(w, "2026-10-04", "voice_rtt", pct(stt, .5), "n/a", "box", "artifacts/agi-loop-metrics.json",
                       src_kind="e2e", leg="stt", n=3, p50=pct(stt, .5), p95=pct(stt, .95)),
                   row(w, "2026-10-04", "voice_rtt", pct([4953, 7459, 6950], .5), "n/a", "box",
                       "artifacts/agi-loop-metrics.json", src_kind="e2e", leg="brain", n=3,
                       p50=pct([4953, 7459, 6950], .5), p95=pct([4953, 7459, 6950], .95))])
    done.append(w)
    # 4) lk-verify daily — the pass count is recorded, the fail count and the names are not
    for d, passed, note in LKV:
        w = f"{d}-lk-verify"
        write_wave(w, [row(w, d, "e2e_pass_rate", None, "n/r", "desktop-chromium", "docs/environments.md", suite="lk-verify",
                           num=passed, den=None, note=note or "FAILED — fail count and names not recorded")])
        done.append(w)
    # 5) the gate, as assessed in the reflection (§2.1): items ✅ 1, 4, 5 of 8, on the gate-final build
    w = "2026-10-27-v07-reassess"
    write_wave(w, [row(w, "2026-10-27", "gate_green", 0.375, "dBAzIRkZMnA43odv0JWmO", "desktop-chromium",
                       R + "v07-reflection-and-plan.md#21", suite="plan.md gate", num=3, den=8,
                       note="green as written; 4 are 🟡, 1 ❌ (T1 version string); the build moved 15 commits since")])
    done.append(w)
    # 6) .agi-log — lane exits per day
    agi = os.path.join(ROOT, ".agi-log/log.tsv")
    if os.path.exists(agi):
        for r in adapt_agi(agi, "", "", "", ""):
            write_wave(r["wave"], [r])
            done.append(r["wave"])
    rebuild_index()
    return done


# ───────────────────────── report ─────────────────────────
def fmt(r):
    if r["metric"] == "voice_rtt":
        return None
    v = r.get("value")
    if r["metric"] in ("gate_green",):
        return f"{r['num']}/{r['den']}"
    if v is None:
        return f"{r['num']} passed (fails n/r)" if r.get("num") is not None else "n/r"
    if r["metric"] == "wedge_count":
        return f"{v:g} /100 runs"
    return f"{v * 100:.1f} % ({r['num']}/{r['den']})" if r.get("num") is not None and r.get("den") else f"{v * 100:.1f} %"


def cell(w_rows, m):
    rs = [r for r in w_rows if r["metric"] == m]
    if not rs:
        return "— not collected", f"{MISSING[m]}", "—", "—"
    parts, builds, devs = [], set(), set()
    for r in sorted(rs, key=key):
        builds.add(r["build"])
        devs.add(r["device"])
        if m == "voice_rtt":
            s = f"{r['src_kind']} {r['leg']}: p50 {r['p50']} ms" + (f" / p95 {r['p95']} ms" if r.get("n", 1) > 1 else "") + f" (n={r['n']})"
        else:
            s = fmt(r)
            if r.get("suite"):
                s = f"{r['suite']}: {s}"
        parts.append(s)
    return "; ".join(parts), "", ", ".join(sorted(builds)), ", ".join(sorted(devs))


def block(wave):
    rows = read_wave(wave)
    if not rows:
        sys.exit(f"metrics: no rows for wave {wave!r} (docs/metrics/waves/{wave}.jsonl)")
    ts = min(r["ts"] for r in rows)
    out = [f"<!-- metrics:begin {wave} (generated by scripts/metrics.py report --wave {wave}; do not hand-edit) -->",
           f"**Metrics — wave `{wave}`, {ts}**", "",
           "| metric | value | build | device |", "|---|---|---|---|"]
    for m in SIX:
        v, why, b, d = cell(rows, m)
        out.append(f"| {LABEL[m]} | {v}{' *(' + why + ')*' if why else ''} | {b} | {d} |")
    out.append(f"<!-- metrics:end {wave} -->")
    return "\n".join(out)


def table_all(rows):
    waves = {}
    for r in rows:
        waves.setdefault(r["wave"], []).append(r)
    out = ["| wave | date | " + " | ".join(LABEL[m] for m in SIX) + " |", "|---|---|" + "---|" * 6]
    for w in sorted(waves, key=lambda w: (min(r["ts"] for r in waves[w]), w)):
        if not any(r["metric"] in SIX for r in waves[w]):
            continue
        cells = []
        for m in SIX:
            v = cell(waves[w], m)[0]
            cells.append("—" if v.startswith("—") else v)
        out.append(f"| `{w}` | {min(r['ts'] for r in waves[w])} | " + " | ".join(cells) + " |")
    return "\n".join(out)


def check_report(wave, path):
    want = block(wave)
    got = open(path).read().lstrip()
    # the block may follow the H1 title line only
    body = got.split("\n", 1)[1].lstrip() if got.startswith("# ") else got
    if not body.startswith(want):
        print(f"metrics: {path} does not open with the generated block for {wave}", file=sys.stderr)
        return 1
    print(f"metrics: {path} opens with the {wave} block — OK")
    return 0


# ───────────────────────── month + svg ─────────────────────────
def series(rows, metric, suite=None, **flt):
    return sorted([r for r in rows if r["metric"] == metric and (suite is None or r.get("suite") == suite)
                   and all(r.get(k) == v for k, v in flt.items())], key=lambda r: (r["ts"], r["wave"]))


def svg(rows, month):
    sim_p = series(rows, "e2e_pass_rate", "ygg-sim")
    sim_n = series(rows, "x.scenarios")
    hf = series(rows, "voice_rtt", src_kind="sim", leg="handsfree_turn")
    gen = [r for r in series(rows, "e2e_pass_rate", "general") if r.get("den")]
    W, H = 960, 640
    css = ("text{font:12px system-ui,sans-serif;fill:#222}.t{font-size:14px;font-weight:600}.m{fill:#666;font-size:11px}"
           ".ax{stroke:#bbb}.g{stroke:#e6e6e6}.a{stroke:#2a6fdb;fill:none;stroke-width:2}.b{stroke:#c2570c;fill:none;stroke-width:2}"
           ".da{fill:#2a6fdb}.db{fill:#c2570c}.tg{stroke:#b3261e;stroke-dasharray:5 4}.bg{fill:#fff}.bar1{fill:#2a6fdb}.bar2{fill:#b3261e}"
           "@media(prefers-color-scheme:dark){text{fill:#e8e8e8}.m{fill:#9a9a9a}.ax{stroke:#555}.g{stroke:#333}.bg{fill:#14161a}"
           ".a{stroke:#6ea8ff}.da{fill:#6ea8ff}.b{stroke:#ffa05c}.db{fill:#ffa05c}.bar1{fill:#6ea8ff}.bar2{fill:#ff7b72}.tg{stroke:#ff7b72}}")
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-label="Evolution metrics {month}">',
         f"<style>{css}</style>", f'<rect class="bg" width="{W}" height="{H}"/>',
         f'<text class="t" x="24" y="30">Evolution metrics — {month} (generated from docs/metrics/waves/*.jsonl)</text>']

    def panel(x, y, w, h, title, sub, ymax, ticks, fmt_t):
        o.append(f'<text class="t" x="{x}" y="{y - 22}">{title}</text><text class="m" x="{x}" y="{y - 8}">{sub}</text>')
        for t in ticks:
            yy = y + h - h * t / ymax
            o.append(f'<line class="g" x1="{x}" x2="{x + w}" y1="{yy:.1f}" y2="{yy:.1f}"/><text class="m" x="{x - 6}" y="{yy + 4:.1f}" text-anchor="end">{fmt_t(t)}</text>')
        o.append(f'<line class="ax" x1="{x}" x2="{x + w}" y1="{y + h}" y2="{y + h}"/>')

    def xs(i, n, x, w):
        return x + (w * (i + .5) / max(n, 1))

    # panel 1: sim scenarios — ran (line) and passing (line)
    x, y, w, h = 70, 90, 400, 190
    panel(x, y, w, h, "ygg-sim: scenarios ran and passing", "cycles 1–7, 10-04 → 10-07; FAIL 0 except cycle 2 (1)", 32, [0, 8, 16, 24, 32], str)
    for ser, cls, dcls in ((sim_n, "a", "da"), ):
        pts = [(xs(i, len(ser), x, w), y + h - h * r["value"] / 32) for i, r in enumerate(ser)]
        o.append(f'<polyline class="{cls}" points="{" ".join(f"{a:.1f},{b:.1f}" for a, b in pts)}"/>')
        for (a, b), r in zip(pts, ser):
            o.append(f'<circle class="{dcls}" cx="{a:.1f}" cy="{b:.1f}" r="3"><title>{r["wave"]}: {int(r["value"])} ran</title></circle>')
        if pts:
            o.append(f'<text class="m" x="{pts[-1][0]:.1f}" y="{pts[-1][1] - 8:.1f}" text-anchor="end">ran {int(ser[-1]["value"])}</text>')
    pas = [(xs(i, len(sim_p), x, w), y + h - h * r["num"] / 32) for i, r in enumerate(sim_p)]
    o.append(f'<polyline class="b" points="{" ".join(f"{a:.1f},{b:.1f}" for a, b in pas)}"/>')
    for (a, b), r in zip(pas, sim_p):
        o.append(f'<circle class="db" cx="{a:.1f}" cy="{b:.1f}" r="3"><title>{r["wave"]}: {r["num"]} pass</title></circle>')
    if pas:
        o.append(f'<text class="m" x="{pas[-1][0]:.1f}" y="{pas[-1][1] + 16:.1f}" text-anchor="end">pass {sim_p[-1]["num"]}</text>')
    for i, r in enumerate(sim_p):
        o.append(f'<text class="m" x="{xs(i, len(sim_p), x, w):.1f}" y="{y + h + 14}" text-anchor="middle">c{i + 1}</text>')

    # panel 2: hands-free voice turn vs the 8 s target
    x2 = 540
    panel(x2, y, w, h, "Hands-free voice turn in the sim (s)", "target ≤ 8 s — never met; flat for six cycles", 32, [0, 8, 16, 24, 32], str)
    ty = y + h - h * 8 / 32
    o.append(f'<line class="tg" x1="{x2}" x2="{x2 + w}" y1="{ty:.1f}" y2="{ty:.1f}"/><text class="m" x="{x2 + w}" y="{ty - 5:.1f}" text-anchor="end">target 8 s</text>')
    pts = [(xs(i, len(hf), x2, w), y + h - h * (r["value"] / 1000) / 32) for i, r in enumerate(hf)]
    o.append(f'<polyline class="a" points="{" ".join(f"{a:.1f},{b:.1f}" for a, b in pts)}"/>')
    for (a, b), r in zip(pts, hf):
        o.append(f'<circle class="da" cx="{a:.1f}" cy="{b:.1f}" r="3"><title>{r["wave"]}: {r["value"] / 1000:.1f} s</title></circle>')
        o.append(f'<text class="m" x="{a:.1f}" y="{b - 8:.1f}" text-anchor="middle">{r["value"] / 1000:.1f}</text>')

    # panel 3: general suite per wave — passed / failed bars
    x3, y3, w3, h3 = 70, 390, 400, 190
    panel(x3, y3, w3, h3, "General e2e suite: passed and failed per wave", "sandbox, desktop Chromium; failures traced to env, not code", 60, [0, 15, 30, 45, 60], str)
    n = len(gen)
    for i, r in enumerate(gen):
        cx = xs(i, n, x3, w3)
        bw = min(34, w3 / max(n, 1) * .6)
        hp, hf_ = h3 * r["num"] / 60, h3 * (r["den"] - r["num"]) / 60
        o.append(f'<rect class="bar1" x="{cx - bw / 2:.1f}" y="{y3 + h3 - hp:.1f}" width="{bw:.1f}" height="{hp:.1f}"><title>{r["wave"]}: {r["num"]} passed</title></rect>')
        if hf_:
            o.append(f'<rect class="bar2" x="{cx - bw / 2:.1f}" y="{y3 + h3 - hp - hf_:.1f}" width="{bw:.1f}" height="{hf_:.1f}"><title>{r["wave"]}: {r["den"] - r["num"]} failed</title></rect>')
        o.append(f'<text class="m" x="{cx:.1f}" y="{y3 + h3 - hp - hf_ - 5:.1f}" text-anchor="middle">{r["num"]}/{r["den"]}</text>')
        o.append(f'<text class="m" x="{cx:.1f}" y="{y3 + h3 + 14}" text-anchor="middle">{r["ts"][5:]}</text>')
    o.append(f'<rect class="bar1" x="{x3}" y="{y3 + h3 + 28}" width="10" height="10"/><text class="m" x="{x3 + 14}" y="{y3 + h3 + 37}">passed</text>'
             f'<rect class="bar2" x="{x3 + 70}" y="{y3 + h3 + 28}" width="10" height="10"/><text class="m" x="{x3 + 84}" y="{y3 + h3 + 37}">failed</text>')

    # panel 4: what is still dark
    x4 = 540
    o.append(f'<text class="t" x="{x4}" y="{y3 - 22}">Not yet collected</text><text class="m" x="{x4}" y="{y3 - 8}">no value is drawn where there is none</text>')
    present = {m for m in SIX if any(r["metric"] == m and r["ts"].startswith(month) for r in rows)}
    for i, m in enumerate(SIX):
        yy = y3 + 14 + i * 30
        have = m in present
        o.append(f'<text x="{x4}" y="{yy}">{LABEL[m]}</text>'
                 f'<text class="m" x="{x4 + 150}" y="{yy}">{"has rows this month" if have else "— " + MISSING[m].split(" + ")[0].replace("`", "")}</text>')
    o.append("</svg>")
    return "\n".join(o)


def month(mon, svg_path):
    rows = [r for r in all_rows() if r["ts"].startswith(mon)]
    if not rows:
        sys.exit(f"metrics: no rows in {mon}")
    print(f"# Metrics — {mon}\n")
    print(table_all(rows))
    ex = sorted({r["metric"] for r in rows if r["metric"].startswith("x.")})
    if ex:
        print("\nExtra series: " + ", ".join(ex))
    allr = all_rows()
    out = svg_path or os.path.join(ROOT, "artifacts", f"metrics-{mon}.svg")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w").write(svg([r for r in allr if r["ts"].startswith(mon)], mon))
    print(f"\n![metrics {mon}](/api/artifact/{os.path.basename(out)})", file=sys.stderr)


# ───────────────────────── cli ─────────────────────────
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    a = sp.add_parser("append")
    a.add_argument("--wave", required=True)
    a.add_argument("--ts", default=datetime.now().strftime("%Y-%m-%d"))
    a.add_argument("--build")
    a.add_argument("--device")
    a.add_argument("--from", dest="adapter", choices=sorted(ADAPTERS))
    a.add_argument("file", nargs="?")
    a.add_argument("--metric")
    a.add_argument("--value", type=float)
    a.add_argument("--num", type=int)
    a.add_argument("--den", type=int)
    a.add_argument("--suite")
    a.add_argument("--src-kind", choices=SRC_KINDS)
    a.add_argument("--leg")
    a.add_argument("--note")
    a.add_argument("--source", default="manual")
    sp.add_parser("backfill")
    r = sp.add_parser("report")
    r.add_argument("--wave")
    r.add_argument("--md", action="store_true")
    r.add_argument("--check")
    r.add_argument("--all", action="store_true")
    m = sp.add_parser("month")
    m.add_argument("month")
    m.add_argument("--svg")
    sp.add_parser("index")
    ns = ap.parse_args(argv)

    if ns.cmd == "append":
        if ns.adapter:
            if not ns.file:
                ap.error("--from needs a FILE")
            if not ns.build or not ns.device:
                ap.error("--build and --device are required (every row carries both)")
            rows = ADAPTERS[ns.adapter](os.path.abspath(ns.file), ns.wave, ns.ts, ns.build, ns.device)
            if not rows:
                print(f"metrics: {ns.adapter} adapter found nothing in {ns.file} — wave left untouched", file=sys.stderr)
                return 0
            if ns.adapter == "agi":  # agi rows name their own waves
                for x in rows:
                    upsert(x["wave"], [x])
            else:
                upsert(ns.wave, rows)
        else:
            if not (ns.metric and ns.build and ns.device):
                ap.error("manual append needs --metric --build --device")
            val = ns.value if ns.value is not None else (rate(ns.num, ns.den) if ns.den else None)
            upsert(ns.wave, [row(ns.wave, ns.ts, ns.metric, val, ns.build, ns.device, ns.source, suite=ns.suite,
                                 num=ns.num, den=ns.den, src_kind=ns.src_kind, leg=ns.leg, note=ns.note)])
        print(f"metrics: ok ({ns.wave})")
    elif ns.cmd == "backfill":
        done = backfill()
        print(f"metrics: backfilled {len(done)} waves → {os.path.relpath(MET, ROOT)}/waves, index rebuilt")
    elif ns.cmd == "report":
        if ns.check:
            return check_report(ns.wave, ns.check)
        if ns.wave:
            print(block(ns.wave))
        else:
            print(table_all(all_rows()))
    elif ns.cmd == "month":
        month(ns.month, ns.svg)
    elif ns.cmd == "index":
        rebuild_index()
    return 0


if __name__ == "__main__":
    sys.exit(main())
