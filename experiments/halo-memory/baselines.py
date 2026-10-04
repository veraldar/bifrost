import json, math, re, argparse
from collections import Counter

def toks(s):
    return re.findall(r"[a-z0-9]+", s.lower())

def header(s):
    return f"day {s['day']} topic {s['topic']}\n{s['text']}"

def score_docs(query_tokens, docs):
    qt = Counter(query_tokens)
    out = []
    for d in docs:
        out.append((sum(qt[w] for w in d["tk"]), d))
    out.sort(key=lambda x: -x[0])
    return out

def rank_of(label, ranked):
    for i, (_, d) in enumerate(ranked):
        if d["label"] == label:
            return i + 1
    return len(ranked)

def bm25_ranks(query, docs, k1=1.5, b=0.75):
    q = toks(query)
    N = len(docs)
    avgdl = sum(len(x["tk"]) for x in docs) / N
    df = Counter()
    for d in docs:
        for w in set(d["tk"]):
            df[w] += 1
    out = []
    for d in docs:
        tf = Counter(d["tk"])
        s = 0.0
        for w in q:
            if w not in tf:
                continue
            idf = math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5))
            s += idf * tf[w] * (k1 + 1) / (tf[w] + k1 * (1 - b + b * len(d["tk"]) / avgdl))
        out.append((s, d))
    out.sort(key=lambda x: -x[0])
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    a = ap.parse_args()
    data = json.load(open(f"{a.data}/ledger.json"))
    sessions = {s["id"]: s for s in data["sessions"]}

    ledger_docs = [{"tk": toks(header(sessions[s["id"]])), "label": 0} for s in data["sessions"]]

    res = {"grep": [0, 0.0], "bm25": [0, 0.0], "grep1hop": [0, 0.0]}
    res_b = {k: [0, 0.0] for k in res}
    res_u = {k: [0, 0.0] for k in res}
    n = n_b = n_u = 0

    for asso in data["associations"]:
        probe, target = asso["probe"], asso["target"]
        decoys = [sessions[d["id"]] for d in asso["decoys"]]
        q = header(probe)

        docs = [{"tk": toks(header(d)), "label": 0} for d in decoys]
        docs.append({"tk": toks(header(target)), "label": 1})

        ranked = score_docs(toks(q), docs)
        r = rank_of(1, ranked)
        for bucket, cnt in [(res, None), (res_b if asso["bridged"] else res_u, None)]:
            bucket["grep"][0] += (r == 1)
            bucket["grep"][1] += 1.0 / r

        ranked = bm25_ranks(q, docs)
        r = rank_of(1, ranked)
        for bucket in [res, res_b if asso["bridged"] else res_u]:
            bucket["bm25"][0] += (r == 1)
            bucket["bm25"][1] += 1.0 / r

        first = [d for s, d in score_docs(toks(q), ledger_docs) if s > 0][:5]
        expanded = set(toks(q))
        for d in first:
            expanded.update(d["tk"])
        ranked = score_docs(list(expanded), docs)
        r = rank_of(1, ranked)
        for bucket in [res, res_b if asso["bridged"] else res_u]:
            bucket["grep1hop"][0] += (r == 1)
            bucket["grep1hop"][1] += 1.0 / r

        n += 1
        if asso["bridged"]:
            n_b += 1
        else:
            n_u += 1

    def show(name, bucket, cnt):
        if cnt == 0:
            return
        print(f"  {name}: " + "  ".join(f"{k} hit@1={v[0]/cnt:.3f} mrr={v[1]/cnt:.3f}" for k, v in bucket.items()))

    print(f"probes={n} (bridged={n_b} unbridged={n_u})  chance hit@1=0.100")
    def show_all(title, bucket, cnt):
        print(title)
        for k, v in bucket.items():
            print(f"  {k:9s} hit@1={v[0]/cnt:.3f} mrr={v[1]/cnt:.3f}")
    show_all("all:", res, n)
    print("bridged (direct rename note exists):")
    show_all("", res_b, n_b)
    print("unbridged (association only via noisy co-mentions):")
    show_all("", res_u, n_u)

if __name__ == "__main__":
    main()
