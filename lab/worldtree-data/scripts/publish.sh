#!/usr/bin/env bash
# Publish out/realms.json + provenance to veraldar.org (rsync over ssh) and
# regenerate feed.xml (same RSS schema the old news pipeline emitted).
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

scp -q out/realms.json out/realms.provenance.json "$H:$W/"
scp -q /tmp/wt-feed.xml "$H:$W/feed.xml"
ssh "$H" "chmod 644 $W/realms.json $W/realms.provenance.json $W/feed.xml"
echo "published: $(python3 -c "import json;print(json.load(open('out/realms.json'))['updated'])")"
