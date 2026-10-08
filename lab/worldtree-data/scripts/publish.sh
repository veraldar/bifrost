#!/usr/bin/env bash
# Publish out/realms.json + provenance + realms-history.json to veraldar.org (scp; host has no rsync),
# regenerate feed.xml (same RSS schema the old news pipeline emitted) and the open-data dir /data/
# (series CSVs + catalog + manifest + method + provenance; raw/ stays local). Idempotent.
# Rollback on the host: /var/www/veraldar/realms.news-pipeline.bak.json
set -e
cd "$(dirname "$0")/.."
H=veraldar
W=/var/www/veraldar
[ -f out/realms.json ] || { echo "no out/realms.json — run first"; exit 1; }
# github-trends.json (model-side curves + the 0.5.0 tools block) ships only if its provenance file still chains (sha256)
if [ -f out/github-trends.json ]; then
  python3 -c "import hashlib,json; d=json.load(open('out/github-trends.json')); assert hashlib.sha256(open('out/github-trends.provenance.json','rb').read()).hexdigest()==d['provenance']['sha256']" \
    || { echo "github-trends.json → provenance sha256 chain broken — refusing"; exit 1; }
fi

python3 - "$W" <<'PY' > /tmp/wt-feed.xml
import json, sys, email.utils, datetime
r = json.load(open('out/realms.json'))
w = r['weights']; webroot = sys.argv[1]
lead = max(w, key=w.get)
items = ' · '.join(f"{k} {v}%" for k, v in w.items())
desc = (f"{r['window']} · method {r.get('method_version','?')} · per-number provenance: "
        f"https://veraldar.org/realms.provenance.json")
updated = r['updated'].replace('Z', '+0000')
dt = datetime.datetime.strptime(updated, '%Y-%m-%dT%H:%M:%S%z')
print(f'<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Veraldar — the world-tree</title>'
      f'<link>https://veraldar.org</link><description>Where is civilization heading with AI? Realm weights from open data.</description>'
      f'<item><title>{lead} leads · {w[lead]}%</title><link>https://veraldar.org/world-tree.html</link>'
      f'<description>{items}</description><guid isPermaLink="false">worldtree-{r["updated"]}</guid>'
      f'<pubDate>{email.utils.format_datetime(dt)}</pubDate></item>'
      f'</channel></rss>')
PY

# /data/: repo-relative layout (budget 20MB per expansion-ceiling.md §5) so DATA.md's query commands run unchanged on a download
D=/tmp/wt-data
rm -rf "$D"; mkdir -p "$D/out"
cp -r series catalog method "$D/"
cp manifest.json DATA.md "$D/"
cp out/realms.provenance.json out/realms-history.json out/realms-history.provenance.json "$D/out/"
[ -f out/github-trends.json ] && cp out/github-trends.json out/github-trends.provenance.json "$D/out/"
BYTES=$(du -sb "$D" | cut -f1)
[ "$BYTES" -lt 20000000 ] || { echo "data payload $BYTES B ≥ 20 MB — refusing"; exit 1; }
# Caddy serves index.txt for /data/ (no directory browsing): DATA.md + file list with sha256
{ cat DATA.md; echo; echo "## Files (sha256  path)"; (cd "$D" && find . -type f ! -name index.txt | sort | sed 's|^\./||' | xargs sha256sum); } > "$D/index.txt"
# frictionless datapackage.json (PATH A adoptable: specs.frictionlessdata.io) — machine-readable /data/ for any standard tooling
python3 - "$D" <<'PY2'
import csv, datetime, hashlib, json, os, sys
D = sys.argv[1]
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()
srcs = json.load(open(os.path.join(D, "catalog", "sources.json")))
lic = sorted({v["license"] for v in srcs.values()})
resources = []
for root, _, files in os.walk(D):
    for f in sorted(files):
        if f in ("datapackage.json", "index.txt"):
            continue
        p = os.path.join(root, f)
        rel = os.path.relpath(p, D)
        med = "text/csv" if f.endswith(".csv") else "application/json" if f.endswith(".json") else "text/markdown" if f.endswith(".md") else "text/plain"
        resources.append({"path": rel, "mediatype": med, "format": f.rsplit(".", 1)[-1],
                          "bytes": os.path.getsize(p), "hash": "sha256:" + sha(p)})
pkg = {
    "name": "worldtree-data",
    "title": "worldtree-data — the open data behind veraldar.org's civilization-outcomes tree",
    "description": ("Per-year and per-country scores for seven AI-civilization outcomes, computed from free/open "
                    "sources only. Every number traces: output file -> series CSV -> sha256 sidecar -> raw snapshot -> source URL + license. "
                    "Method versioned; see catalog/ and method/."),
    "homepage": "https://veraldar.org",
    "version": open("method/VERSION").read().strip(),
    "created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "licenses": [{"name": l} for l in lic],
    "sources": [{"title": v["title"], "path": v.get("homepage", "")} for v in sorted(srcs.values(), key=lambda x: x["title"])],
    "keywords": ["ai", "world-data", "open-data", "provenance", "civilization", "forecasting"],
    "resources": sorted(resources, key=lambda r: r["path"]),
}
with open(os.path.join(D, "datapackage.json"), "w") as f:
    json.dump(pkg, f, indent=1, sort_keys=True, ensure_ascii=False)
    f.write("\n")
print(f"datapackage.json: {len(resources)} resources, {len(lic)} licenses")
PY2
ssh "$H" "rm -rf $W/data.new"
scp -qr "$D" "$H:$W/data.new"
ssh "$H" "find $W/data.new -type d -exec chmod 755 {} + && find $W/data.new -type f -exec chmod 644 {} + \
  && rm -rf $W/data.old && { [ ! -d $W/data ] || mv $W/data $W/data.old; } && mv $W/data.new $W/data && rm -rf $W/data.old"
LINE="Open data: https://veraldar.org/data/ (series CSVs + catalog + per-number provenance)"
ssh "$H" "grep -qxF '$LINE' $W/llms.txt || printf '\n%s\n' '$LINE' >> $W/llms.txt"

# history before realms.json: the realms.json history.sha256 pointer must never dangle
scp -q out/realms-history.json "$H:$W/"
# GitHub evolution speed (method 0.4.1) + the tools block (0.5.0): the AI EVOLUTION tab, next to realms.json
[ -f out/github-trends.json ] && scp -q out/github-trends.json "$H:$W/github-trends.json"
scp -q out/realms.provenance.json "$H:$W/"
scp -q out/realms.json "$H:$W/"
scp -q /tmp/wt-feed.xml "$H:$W/feed.xml"
# country layer (expansion E3/E4): per-country scores next to realms.json, map paths under /data/
[ -f out/countries.json ] && scp -q out/countries.json "$H:$W/countries.json"
[ -f data/countries-paths.json ] && scp -q data/countries-paths.json "$H:$W/data/countries-paths.json"
ssh "$H" "chmod 644 $W/realms.json $W/realms.provenance.json $W/realms-history.json $W/feed.xml && chmod 644 $W/github-trends.json 2>/dev/null; true"
ssh "$H" "chmod 644 $W/realms.json $W/realms.provenance.json $W/realms-history.json $W/feed.xml && chmod 644 $W/countries.json $W/data/countries-paths.json 2>/dev/null || true"
echo "published: $(python3 -c "import json;print(json.load(open('out/realms.json'))['updated'])")"
