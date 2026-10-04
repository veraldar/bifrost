#!/usr/bin/env bash
# Step 1: re-prove the four core sources from this host (27 URLs, one line each).
set -u
UA='worldtree-data/0.1 (+https://veraldar.org; dweeb.xyz@gmail.com)'
END=$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y%m%d)   # last day of previous month
q='?v=1&csvType=full&useColumnShortNames=true'
p() { curl -sSL -A "$UA" --max-time 30 --retry 2 -o /dev/null -w "%{http_code} $2\n" "$1" || echo "000 $2"; }
for s in share-of-population-in-extreme-poverty life-expectancy electoral-democracy-index \
         deaths-in-armed-conflicts-by-region estimated-share-people-generative-ai \
         cumulative-number-of-large-scale-ai-systems-by-country private-investment-in-artificial-intelligence \
         share-companies-using-artificial-intelligence ai-frontiermath-over-time; do
  p "https://ourworldindata.org/grapher/$s.csv$q" "owid:$s.csv"
  p "https://ourworldindata.org/grapher/$s.metadata.json$q" "owid:$s.metadata.json"
done
for c in NY.GDP.PCAP.KD SL.UEM.TOTL.ZS; do
  p "https://api.worldbank.org/v2/country/WLD/indicator/$c?format=json&per_page=100" "worldbank:$c"
done
p "https://epoch.ai/data/notable_ai_models.csv" "epoch:notable_ai_models"
for a in Deepfake Synthetic_media Regulation_of_artificial_intelligence \
         Existential_risk_from_artificial_intelligence Artificial_general_intelligence; do
  p "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/$a/monthly/20150701/$END" "wikimedia:$a"
done
p "https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/en.wikipedia/all-access/user/monthly/2015070100/${END}00" "wikimedia:_aggregate"
