"""Method v0.1.0 (prediction.md §3–§4). Pure functions, no I/O.

A series is a list of (period, date, value) with period text per cadence
("2025" | "2025-09" | "2025-09-30"), date ISO, value float, sorted by date.
"""
import datetime as dt
import math

REALMS = ["utopia", "divergence", "drift", "control", "terminus", "stagnation", "transcendence"]
W_FULL = 6
FLOOR = {"annual": 8, "monthly": 24, "weekly": 24}  # weekly (0.3.1): same 24-point floor as monthly
LOGIT_CLAMP = (0.5, 99.5)


class Excluded(Exception):
    """Indicator gate failure: reason ∈ {short_history, no_value}, detail free text."""

    def __init__(self, reason, detail=""):
        super().__init__(reason, detail)
        self.reason, self.detail = reason, detail


def pidx(period, cadence):
    """Integer index so that `t - lag` is exactly `lag` periods earlier."""
    if cadence == "annual":
        return int(period)
    if cadence == "monthly":
        y, m = period.split("-")
        return int(y) * 12 + int(m) - 1
    if cadence == "weekly":  # period = week-end date; consecutive weeks → consecutive integers
        return dt.date.fromisoformat(period).toordinal() // 7
    return dt.date.fromisoformat(period).toordinal()


def f_scale(x, diff):
    """`diff` scale; None ⇒ row dropped."""
    if diff == "abs":
        return x
    if diff == "log":
        return math.log(x) if x > 0 else None
    if diff == "logit":
        p = min(max(x, LOGIT_CLAMP[0]), LOGIT_CLAMP[1])
        return math.log(p / (100.0 - p))
    raise ValueError(f"unknown diff {diff}")


def prepare(rows, cadence, params, total=None):
    """norm → agg → diff. Returns {period index: f(x)} (undefined rows absent)."""
    x = {pidx(p, cadence): v for p, _, v in rows}
    if params.get("norm"):  # `total` (wiki.en_total) or, since 0.6.0, any normaliser series — per million of it
        tot = {pidx(p, cadence): v for p, _, v in (total or [])}
        x = {t: v / tot[t] * 1e6 for t, v in x.items() if t in tot and tot[t]}
    if params.get("agg") == "mean3":
        x = {t: (x[t] + x[t - 1] + x[t - 2]) / 3.0 for t in x if t - 1 in x and t - 2 in x}
    elif params.get("agg"):
        raise ValueError(f"unknown agg {params['agg']}")
    out = {}
    for t, v in x.items():
        fv = f_scale(v, params.get("diff", "abs"))
        if fv is not None:
            out[t] = fv
    return out


def pct(R, y):
    """Mid-rank percentile of y within reference set R."""
    lt = sum(1 for r in R if r < y)
    eq = sum(1 for r in R if r == y)
    return (lt + 0.5 * eq) / len(R)


def rank_score(ys, t_star, h, cadence, direction):
    """ys: {t: y}. Returns (score, pct, y*, ref_n)."""
    if t_star not in ys:
        raise Excluded("no_value", "latest y undefined")
    y = ys[t_star]
    R = [ys[t] for t in sorted(t for t in ys if t < t_star)][-h:]
    floor = FLOOR[cadence]
    if len(R) < floor:
        raise Excluded("short_history", f"ref_n {len(R)} < {floor}")
    p = pct(R, y)
    return (p if direction > 0 else 1.0 - p), p, y, len(R)


def rank_delta(rows, cadence, params, direction, total=None):
    fx = prepare(rows, cadence, params, total)
    lag = int(params["lag"])
    ys = {t: fx[t] - fx[t - lag] for t in fx if t - lag in fx}
    return rank_score(ys, pidx(rows[-1][0], cadence), int(params["h"]), cadence, direction)


def rank_level(rows, cadence, params, direction, total=None):
    ys = prepare(rows, cadence, params, total)
    return rank_score(ys, pidx(rows[-1][0], cadence), int(params["h"]), cadence, direction)


def logistic_delta(rows, params, direction):
    """Returns (score, None, d_per_year, ref_n=1)."""
    span = int(params["span_days"])
    diff = params.get("diff", "abs")
    d0, k = float(params["d0"]), float(params["k"])
    _, ld, lv = rows[-1]
    latest = dt.date.fromisoformat(ld)
    cut = latest - dt.timedelta(days=span)
    ref = [r for r in rows if dt.date.fromisoformat(r[1]) <= cut]
    if not ref:
        raise Excluded("short_history", f"no row on/before {cut.isoformat()} (span {span} d)")
    _, rd, rv = ref[-1]
    days = (latest - dt.date.fromisoformat(rd)).days
    fl, fr = f_scale(lv, diff), f_scale(rv, diff)
    if fl is None or fr is None:
        raise Excluded("no_value", "diff scale undefined")
    d = (fl - fr) * 365.25 / days
    s_raw = 1.0 / (1.0 + math.exp(-(d - d0) / k))
    return (s_raw if direction > 0 else 1.0 - s_raw), None, d, 1


def score(transform, rows, cadence, params, direction, total=None):
    """Dispatch; score rounded to 4 dp. Raises Excluded."""
    if not rows:
        raise Excluded("no_value", "empty series")
    if transform == "rank_delta":
        s, p, y, n = rank_delta(rows, cadence, params, direction, total)
    elif transform == "rank_level":
        s, p, y, n = rank_level(rows, cadence, params, direction, total)
    elif transform == "logistic_delta":
        s, p, y, n = logistic_delta(rows, params, direction)
    else:
        raise ValueError(f"unknown transform {transform}")
    return {"score": round(s, 4), "pct": None if p is None else round(p, 4), "y_latest": round(y, 4), "ref_n": n}


def aggregate(used, w_map):
    """used: list of (w, s). Returns dict(w_used, mean_score, coverage, mass, evidence)."""
    w_used = sum(w for w, _ in used)
    m = sum(w * s for w, s in used) / w_used if w_used else 0.5
    mass = min(1.0, w_used / W_FULL)
    return {"w_used": w_used, "w_map": w_map, "mean_score": m, "coverage": w_used / w_map if w_map else 0.0,
            "mass": mass, "evidence": 0.5 + mass * (m - 0.5)}


def contribution(w, s, mass, w_used):
    return w * (s - 0.5) * mass / w_used if w_used else 0.0


def largest_remainder(e, order=REALMS):
    """{realm: e} → {realm: weight} at 0.1 resolution, Σ == 100.0 exactly."""
    tot = sum(e[k] for k in order)
    u = {k: 1000.0 * e[k] / tot for k in order}
    units = {k: math.floor(u[k]) for k in order}
    left = 1000 - sum(units.values())
    rank = sorted(order, key=lambda k: (-(u[k] - units[k]), order.index(k)))
    for k in rank[:left]:
        units[k] += 1
    return {k: units[k] / 10 for k in order}
