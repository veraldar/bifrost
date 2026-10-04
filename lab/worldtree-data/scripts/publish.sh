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
BYTES=$(du -sb "$D" | cut -f1)
[ "$BYTES" -lt 20000000 ] || { echo "data payload $BYTES B ≥ 20 MB — refusing"; exit 1; }
# Caddy serves index.txt for /data/ (no directory browsing): DATA.md + file list with sha256
{ cat DATA.md; echo; echo "## Files (sha256  path)"; (cd "$D" && find . -type f ! -name index.txt | sort | sed 's|^\./||' | xargs sha256sum); } > "$D/index.txt"
ssh "$H" "rm -rf $W/data.new"
scp -qr "$D" "$H:$W/data.new"
ssh "$H" "find $W/data.new -type d -exec chmod 755 {} + && find $W/data.new -type f -exec chmod 644 {} + \
  && rm -rf $W/data.old && { [ ! -d $W/data ] || mv $W/data $W/data.old; } && mv $W/data.new $W/data && rm -rf $W/data.old"
LINE="Open data: https://veraldar.org/data/ (series CSVs + catalog + per-number provenance)"
ssh "$H" "grep -qxF '$LINE' $W/llms.txt || printf '\n%s\n' '$LINE' >> $W/llms.txt"

# history before realms.json: the realms.json history.sha256 pointer must never dangle
scp -q out/realms-history.json "$H:$W/"
scp -q out/realms.provenance.json "$H:$W/"
scp -q out/realms.json "$H:$W/"
scp -q /tmp/wt-feed.xml "$H:$W/feed.xml"
# country layer (expansion E3/E4): per-country scores next to realms.json, map paths under /data/
[ -f out/countries.json ] && scp -q out/countries.json "$H:$W/countries.json"
[ -f data/countries-paths.json ] && scp -q data/countries-paths.json "$H:$W/data/countries-paths.json"
ssh "$H" "chmod 644 $W/realms.json $W/realms.provenance.json $W/realms-history.json $W/feed.xml && chmod 644 $W/countries.json $W/data/countries-paths.json 2>/dev/null || true"
echo "published: $(python3 -c "import json;print(json.load(open('out/realms.json'))['updated'])")"
