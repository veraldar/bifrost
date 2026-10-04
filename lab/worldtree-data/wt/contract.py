"""Page contract for realms.json: mirrors world-tree.html's fetch handler, plus the realm contract (plan.md step 7)."""
import datetime as dt
import json
import math
import re

from .common import REALMS, load_mapping, root

UPDATED_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _seven(d, name):
    if not isinstance(d, dict):
        return f"{name}: not an object"
    for k in REALMS:
        if k not in d:
            return f"{name}.{k}: missing"
        if not _finite(d[k]):
            return f"{name}.{k}: not a finite number ({d[k]!r})"
    return None


def _sum100(d, name):
    tenths = [d[k] * 10 for k in REALMS]
    if any(abs(t - round(t)) > 1e-6 for t in tenths):
        return f"{name}: not at 0.1 resolution"
    if sum(round(t) for t in tenths) != 1000:
        return f"{name}: sum {sum(d[k] for k in REALMS):.1f} != 100.0"
    return None


def check(j, now=None):
    """Return None if valid, else the first violation."""
    now = now or dt.datetime.now(dt.timezone.utc)
    if not isinstance(j, dict):
        return "not a JSON object"
    for name in ("weights", "world_weights"):
        if name not in j:
            return f"{name}: missing"
        e = _seven(j[name], name) or _sum100(j[name], name)
        if e:
            return e
    u = j.get("updated")
    if not isinstance(u, str) or not UPDATED_RE.match(u):
        return f"updated: bad format ({u!r})"
    t = dt.datetime.strptime(u, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    if t > now:
        return f"updated: in the future ({u})"
    c = j.get("colors")
    if not isinstance(c, dict) or any(not isinstance(c.get(k), str) or not COLOR_RE.match(c[k]) for k in REALMS):
        return "colors: need 7 × #rrggbb"
    static = json.loads((root() / "catalog" / "realms.static.json").read_text(encoding="utf-8"))
    if j.get("definitions") != static["definitions"]:
        return "definitions: differ from catalog/realms.static.json"
    w = j.get("window")
    if not isinstance(w, str):
        return "window: not a string"
    if re.search(r"items", w, re.I):
        return "window: contains 'items' (page items() regex would misread it)"
    d = j.get("dimensions")
    if not isinstance(d, dict) or any(not isinstance(k, str) or not _finite(v) for k, v in d.items()):
        return "dimensions: need object of finite numbers"
    top = j.get("top")
    if not isinstance(top, dict):
        return "top: not an object"
    for k, v in top.items():
        if k not in REALMS:
            return f"top.{k}: unknown realm"
        if not isinstance(v, list) or len(v) > 2 or any(not isinstance(x, str) for x in v):
            return f"top.{k}: need list[str] of ≤ 2"
    s = j.get("sources")
    if not isinstance(s, dict) or any(
            not isinstance(k, str) or not isinstance(v, int) or isinstance(v, bool) or v < 0 for k, v in s.items()):
        return "sources: need {str: int ≥ 0}"
    f = j.get("feeds")
    if not isinstance(f, list):
        return "feeds: missing or not a list"
    for x in f:
        if not isinstance(x, dict) or not isinstance(x.get("name"), str) or not isinstance(x.get("state"), str):
            return "feeds: need list of {name: str, state: str}"
    n = len({r["series_id"] for r in load_mapping()})
    if len(f) != n:
        return f"feeds: {len(f)} entries, expected {n} (one per mapped series)"
    return None
