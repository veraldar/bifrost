#!/usr/bin/env bash
# Step 8: the agent query contract (schema.md §5), verbatim except: no `less` pager,
# and the runs/A vs runs/B diff uses the last two run dirs.
set -euo pipefail
cd "$(dirname "$0")/.."

# current numbers (what the page shows)
jq '.weights' out/realms.json

# why is terminus where it is — per-indicator trail
jq '.realms.terminus | {weight, evidence, coverage,
     used: [.indicators[] | {series_id, score, weight, direction, latest_period, source_url}],
     excluded}' out/realms.provenance.json

# which series feed a realm, with weights and rationale
grep -E '^terminus,' catalog/mapping.csv
column -s, -t < catalog/mapping.csv

# verify the raw trail of every published number (all lines must say OK)
jq -r '.realms[].indicators[].snapshot | "\(.sha256)  \(.path)"' out/realms.provenance.json \
  | sort -u | sha256sum -c

# verify every raw file in the repo against the manifest
jq -r '.raw[] | "\(.sha256)  \(.path)"' manifest.json | sha256sum -c --quiet && echo ALL-RAW-OK

# what is stale / excluded right now
jq '[.series[] | select(.stale)] | map(.series_id)' manifest.json
jq '.realms | to_entries | map({realm: .key, excluded: .value.excluded})' out/realms.provenance.json

# a series' recent values
tail -n 5 series/wb.unemployment.csv

# sqlite3 (preinstalled)
sqlite3 :memory: -cmd '.mode csv' -cmd '.import series/owid.extreme_poverty.csv s' \
  'select period, value from s order by date desc limit 5;'

# duckdb, no install needed (uv fetches it)
uv run --quiet --with duckdb python -c "import duckdb; print(duckdb.sql(\"select realm, count(*) n, sum(weight) w from 'catalog/mapping.csv' group by realm order by realm\"))"

# duckdb across all series at once
uv run --quiet --with duckdb python -c "import duckdb; print(duckdb.sql(r\"select regexp_extract(filename, 'series/(.*)[.]csv', 1) id, max(date) last_date from read_csv('series/*.csv', filename=true, union_by_name=true) group by 1 order by 2\"))"

# pandas: history of the seven numbers
uv run --quiet --with pandas python -c "import pandas as pd; \
  print(pd.read_csv('out/history.csv').query('published==1').tail(10))"

# what changed between two runs
A=$(ls -1d runs/*/ | tail -2 | head -1); B=$(ls -1d runs/*/ | tail -1)
diff <(jq -S .weights ${A}realms.json) <(jq -S .weights ${B}realms.json) || true
