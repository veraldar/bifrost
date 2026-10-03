"""Shared paths, constants and file helpers."""
import csv
import hashlib
import io
import json
import os
from pathlib import Path

REALMS = ["utopia", "divergence", "drift", "control", "terminus", "stagnation", "transcendence"]
UA = "worldtree-data/0.1 (+https://veraldar.org; dweeb.xyz@gmail.com)"
FETCHER = "wt.fetch 0.1.0"
LOCK = "/tmp/worldtree-data.lock"


def root() -> Path:
    return Path(os.environ.get("WT_ROOT") or Path(__file__).resolve().parent.parent).resolve()


def rel(p: Path) -> str:
    return Path(p).resolve().relative_to(root()).as_posix()


def sha256_file(p) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def dumps(obj) -> str:
    """Generated JSON: UTF-8, 1-space indent, sorted keys, trailing newline."""
    return json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def write_text(p, text: str):
    """Atomic write (tmp + rename)."""
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, p)


def write_json(p, obj):
    write_text(p, dumps(obj))


def csv_text(header, rows) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def read_csv(p):
    with open(p, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def append_csv(p, header, row):
    p = Path(p)
    new = not p.exists()
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        if new:
            w.writerow(header)
        w.writerow(row)


def catalog_dir() -> Path:
    return root() / "catalog"


def mapping_path() -> Path:
    """WT_CATALOG overrides mapping.csv (a file) or the whole catalog dir (a dir)."""
    o = os.environ.get("WT_CATALOG")
    if o:
        o = Path(o)
        return o / "mapping.csv" if o.is_dir() else o
    return catalog_dir() / "mapping.csv"


def series_path() -> Path:
    o = os.environ.get("WT_CATALOG")
    if o and Path(o).is_dir():
        return Path(o) / "series.csv"
    return catalog_dir() / "series.csv"


def load_series():
    return {r["series_id"]: r for r in read_csv(series_path())}


def load_mapping():
    return read_csv(mapping_path())


def load_sources():
    return json.loads((catalog_dir() / "sources.json").read_text(encoding="utf-8"))


def method_version() -> str:
    return (root() / "method" / "VERSION").read_text().strip()


def parse_params(s: str) -> dict:
    out = {}
    for kv in filter(None, (s or "").split(";")):
        k, v = kv.split("=", 1)
        out[k.strip()] = v.strip()
    return out
