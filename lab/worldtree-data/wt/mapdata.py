"""Map data: Natural Earth 110m -> catalog/iso_map.csv (entity/geo keys -> iso3) + data/countries-paths.json.

Run `python3 -m wt mapdata` after fetching source `ne` (raw/ne/ne110/<ts>.geojson).
Deterministic; provenance rides the raw sidecar + manifest (assets entry)."""
import json
import sys
from pathlib import Path

from .common import REALMS, catalog_dir, load_sources, root, sha256_file, write_json, write_text
from .extract import snapshot

W, H = 720, 360
MIN_RING = 4          # drop rings with fewer kept points
TOL = 1.5             # px: keep a point only if it moves >= this far from the last kept point
MAX_PATHS_KB = 80


def _ne_snapshot():
    metas = []
    d = root() / "raw" / "ne" / "ne110"
    for sc in sorted(d.glob("*.geojson.prov.json")):
        metas.append(json.loads(sc.read_text()))
    if not metas:
        raise SystemExit("no ne110 snapshot — run: python3 -m wt fetch --source ne")
    return root() / max(metas, key=lambda m: (m["retrieved_at"], m["path"]))["path"]


def iso_rows(geojson):
    """One row per country polygon: iso3, iso2, m49, name (NE property names)."""
    rows, seen = [], set()
    for f in geojson["features"]:
        p = f["properties"]
        iso3 = (p.get("ISO_A3_EH") or p.get("ISO_A3") or p.get("ADM0_A3") or "").strip()
        if iso3 in ("", "-99"):
            iso3 = p.get("ADM0_A3", "")
        if not iso3 or iso3 in seen or iso3 in ("ATA",):
            continue
        seen.add(iso3)
        rows.append({
            "iso3": iso3,
            "iso2": (p.get("ISO_A2_EH") or p.get("ISO_A2") or "").strip(),
            "m49": (str(p.get("M49_ISO") or p.get("UN_M49") or "")).strip().zfill(3),
            "name": p.get("NAME") or p.get("NAME_LONG") or iso3,
        })
    return sorted(rows, key=lambda r: r["iso3"])


def project_ring(ring):
    """Lon/lat -> equirectangular px ring, decimated by TOL (first and last points always kept)."""
    out, lx = [], None
    for lon, lat in ring:
        x, y = round((lon + 180) * W / 360, 1), round((90 - lat) * H / 180, 1)
        if out and abs(x - lx) < TOL and abs(y - out[-1][1]) < TOL:
            continue
        out.append((x, y))
        lx = x
    if len(out) > 1 and out[0] == out[-1] and len(out) > MIN_RING:
        out[-1] = out[0]
    return out


def ring_to_path(ring):
    d = f"M{ring[0][0]:g} {ring[0][1]:g}"
    for x, y in ring[1:]:
        d += f"L{x:g} {y:g}"
    return d + ("Z" if ring[0] == ring[-1] else "Z")


def build():
    ne_path = _ne_snapshot()
    geojson = json.loads(ne_path.read_text(encoding="utf-8"))
    rows = iso_rows(geojson)

    # 1) catalog/iso_map.csv — the entity/M49 -> iso3 key every geo extractor uses
    header = ["iso3", "iso2", "m49", "name"]
    write_text(catalog_dir() / "iso_map.csv",
               ",".join(header) + "\n" + "\n".join(",".join(r[k] for k in header) for r in rows) + "\n")

    # 2) data/countries-paths.json — the page's map layer (per-iso3 svg paths, px space)
    by_iso = {r["iso3"]: r for r in rows}
    paths, total = {}, 0
    for f in geojson["features"]:
        p = f["properties"]
        iso3 = (p.get("ISO_A3_EH") or p.get("ISO_A3") or p.get("ADM0_A3") or "").strip()
        if iso3 not in by_iso or iso3 == "ATA":
            continue
        geom = f["geometry"]
        rings = geom["coordinates"] if geom["type"] == "Polygon" else [r for poly in geom["coordinates"] for r in poly]
        parts = []
        for ring in sorted(rings, key=len, reverse=True):
            pr = project_ring(ring)
            if len(pr) >= MIN_RING:
                parts.append(ring_to_path(pr))
            if len(parts) >= 3:  # largest 3 rings per country: mainland + biggest islands
                break
        if parts:
            paths[iso3] = "".join(parts)
    total = sum(len(v) for v in paths.values())
    if total > MAX_PATHS_KB * 1024:
        print(f"mapdata: paths {total}B exceed {MAX_PATHS_KB}KB budget — raise TOL", file=sys.stderr)
        return 1
    write_json(root() / "data" / "countries-paths.json", {
        "schema": "worldtree.map/1",
        "projection": "equirectangular 720x360 (x=(lon+180)*2, y=(90-lat)*2)",
        "source": load_sources()["ne"]["attribution"],
        "source_url": "https://github.com/nvkelso/natural-earth-vector (110m admin-0, public domain)",
        "ne_sha256": sha256_file(ne_path),
        "n_countries": len(paths),
        "paths": paths,
    })
    print(f"mapdata OK {len(paths)} countries, {len(rows)} iso rows, paths {total}B ({total/1024:.0f}KB)")
    return 0
