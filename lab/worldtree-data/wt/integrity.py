"""Integrity: every sidecar's sha256 matches its raw file."""
import json

from .common import root, sha256_file


def check_sidecar(sc_path):
    sc = json.loads(sc_path.read_text())
    p = root() / sc["path"]
    if not p.exists():
        return f"{sc['path']}: missing"
    if sha256_file(p) != sc["sha256"]:
        return f"{sc['path']}: sha256 mismatch"
    return None


def check_all():
    bad, n = [], 0
    for sc in sorted((root() / "raw").rglob("*.prov.json")):
        n += 1
        e = check_sidecar(sc)
        if e:
            bad.append(e)
    return bad, n
