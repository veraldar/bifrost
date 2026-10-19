#!/usr/bin/env bash
# onboard-voice-site — copy the door lines veraldar.org speaks from the app's
# pack (pwa/public/onboarding, scripts/onboard-voice.mjs) into the site repo:
# the same files, so the site door and the app door are one voice by
# construction. Lines marked "on": ["site", …] in the manifest only.
#   scripts/onboard-voice-site.sh [SITE_DIR]   (default ~/Work/veraldar-site)
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
PACK=$HERE/pwa/public/onboarding
SITE=${1:-$HOME/Work/veraldar-site}
OUT=$SITE/onboarding
[ -f "$PACK/manifest.json" ] || { echo "no pack at $PACK — run scripts/onboard-voice.mjs" >&2; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT/en" "$OUT/fr"
python3 - "$PACK" "$OUT" <<'PY'
import json, shutil, sys
pack, out = sys.argv[1], sys.argv[2]
m = json.load(open(f"{pack}/manifest.json"))
keep = {k: v for k, v in m["lines"].items() if "site" in v.get("on", [])}
n = 0
for lid, e in keep.items():
    for lang in ("en", "fr"):
        if lang in e:
            shutil.copyfile(f"{pack}/{e[lang]['file']}", f"{out}/{e[lang]['file']}")
            n += 1
m["lines"] = keep
m["about"] = "copy of the bifrost app's onboarding pack (site lines only) — scripts/onboard-voice-site.sh; do not edit here"
json.dump(m, open(f"{out}/manifest.json", "w"), indent=2, ensure_ascii=False)
open(f"{out}/manifest.json", "a").write("\n")
print(f"{n} files, {len(keep)} lines → {out}")
PY
chmod -R a+rX "$OUT"
