"""github trend: measure ai growth on github — repos created per year by topic,
star totals, top repos. unauthenticated search api (10 req/min, plenty at 6h)."""
import json, os, time, urllib.request

UA = {"User-Agent": "veraldar-pipeline/0.1", "Accept": "application/vnd.github+json"}
TOPICS = ["ai", "llm", "ai-agents", "rag"]
YEARS = list(range(2019, 2027))
OUT = os.environ.get("VERALDAR_GITHUB", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "out", "github.json"))

CACHE = os.environ.get("VERALDAR_GH_CACHE", "/opt/veraldar-pipeline/gh-cache.json")
def _load_cache():
    try:
        with open(CACHE) as f: return json.load(f)
    except Exception: return {}
def _get(url):
    cache = _load_cache()
    if url in cache: return cache[url]
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            cache[url] = data
            with open(CACHE, "w") as f: json.dump(cache, f)
            time.sleep(8)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 403 or e.code == 429:
                print("rate limited, waiting 75s...", flush=True)
                time.sleep(75)
            else:
                raise
    raise RuntimeError("rate limited after retries: " + url)

def topic_year(topic, year):
    q = f"topic:{topic}+created:{year}-01-01..{year}-12-31"
    d = _get(f"https://api.github.com/search/repositories?q={q}&per_page=1")
    return d.get("total_count", 0)

def topic_stars(topic):
    q = f"topic:{topic}+stars:%3E200"
    d = _get(f"https://api.github.com/search/repositories?q={q}&sort=stars&order=desc&per_page=30")
    items = [{"name": r["full_name"], "stars": r["stargazers_count"]} for r in d.get("items", [])]
    return items, sum(i["stars"] for i in items)

def main():
    out = {"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "note": "ai growth on github: repos created per year per topic (search counts) + current star mass",
           "topics": {}, "top": {}}
    for t in TOPICS:
        per = {}
        for y in YEARS:
            per[str(y)] = topic_year(t, y)
        time.sleep(1)
        items, stars = topic_stars(t)
        out["topics"][t] = {"repos_per_year": per, "stars_in_top30": stars}
        out["top"][t] = items[:10]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f: json.dump(out, f, indent=1)
    os.replace(tmp, OUT)
    print(json.dumps(out["topics"], indent=1)[:600])

if __name__ == "__main__":
    main()
