#!/usr/bin/env bash
# M3 step 1: re-prove the four M3 sources from this host (sources.md §M3 proof URLs, one line each).
set -u
UA='worldtree-data/0.1 (+https://veraldar.org; dweeb.xyz@gmail.com)'
p() { curl -sSgL -A "$UA" --max-time 30 --retry 2 -o /dev/null -w "%{http_code} $2\n" "$1" || echo "000 $2"; }
p "https://export.arxiv.org/api/query?search_query=cat:cs.AI&max_results=1" "arxiv:cs.AI"
p "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=artificial+intelligence&retmode=json&rettype=count" "pubmed:ai_biomed"
p "https://www.federalregister.gov/api/v1/documents.json?conditions[term]=%22artificial+intelligence%22&per_page=1&fields[]=publication_date" "fedreg:ai_documents"
p "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv" "noaa_gml:co2_mm_mlo"
