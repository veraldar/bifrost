import json, random, os, argparse

FIRST = ["Ada","Ben","Cleo","Dara","Eli","Fay","Gus","Hana","Ivo","Juno","Kip","Lena","Milo","Nia","Omar","Pia","Quin","Rosa","Sami","Tessa"]
FILLER_VERBS = ["reviewed","refactored","skimmed","documented","renamed","moved","archived","tested","queued","revisited"]

TOPICS = [
    {"name":"bifrost","lex":["proxy","route","upstream","latency","endpoint","gateway","ttl","rewrite","header","cache"]},
    {"name":"voice-agent","lex":["pipeline","utterance","barge-in","transcript","vad","latency","prompt","turn","stream","agent"]},
    {"name":"homelab","lex":["vlan","docker","backup","nas","fan","uptime","firmware","raid","snapshot","service"]},
    {"name":"notes-app","lex":["editor","sync","conflict","index","note","tag","schema","vault","import","export"]},
    {"name":"trading-bot","lex":["order","fill","slippage","signal","feed","position","risk","candle","queue","hedge"]},
    {"name":"photoblog","lex":["gallery","thumb","upload","exif","album","crop","cache","feed","layout","css"]},
    {"name":"weather-station","lex":["sensor","calibration","reading","firmware","mqtt","battery","dashboard","plot","sampling","offset"]},
    {"name":"keyboard-fw","lex":["keymap","debounce","layer","chord","scan","matrix","firmware","rgb","latency","flash"]},
    {"name":"recipe-site","lex":["recipe","search","index","scrape","schema","tag","crawl","render","import","seo"]},
    {"name":"game-tracker","lex":["lobby","match","elo","poll","api","sheet","rank","session","bot","chart"]},
]

SUFFIX = ["module","queue","limiter","worker","cache","layer","hook","job","path","util","guard","loop"]

B_WORDS = {
    "broke": ["broke", "crashed", "fell over", "died", "fell apart"],
    "demo": ["demo", "presentation", "showcase", "screening", "live run"],
    "deadline": ["deadline", "due date", "hard stop", "cut-off", "launch window"],
    "confusing": ["confusing", "puzzling", "cryptic", "opaque", "bewildering"],
    "slow": ["slow", "sluggish", "creeping", "glacial", "dragging"],
}

def fact_templates_A():
    return [
        "decided {a} should use {w0} instead of the old path, {w1} was the reason and {w2} confirmed it",
        "plan for {a}: keep {w0} as default, treat {w1} as fallback, log {w2} on every call",
        "{a} got migrated today, {w0} handled the edge cases, {w1} still needs a pass, {w2} is done",
        "agreed to revert {a} to {w0} after {w1} showed regressions, {w2} takes over maintenance",
        "wrote up docs for {a}, covered {w0}, {w1} and the {w2} case",
    ]

def fact_templates_B():
    return [
        "{a} {b0} again right before the {b1}, nobody knew what to say",
        "spent the whole {b1} unblocked because {a} {b0} mid-run",
        "{a} {b0} and it felt {b2}, we punted the fix",
        "reminder that {a} {b0}, flag it before the next {b1}",
        "{a} {b0} on stage, {name} covered for it, felt {b2}",
    ]

def filler_templates():
    return [
        "{name} {v} the {t} folder, nothing merged",
        "quick {t} sync with {name}, {lex0} and {lex1} discussed, no decisions",
        "trim backlog in {t}: kept {lex0}, dropped {lex1}, parked {lex2}",
        "{t} weekly notes: {lex0} stable, {lex1} noisy, {lex2} pending",
        "chat with {name} about {t}, mostly {lex0} gossip",
        "cleanup day in {t}, {lex1} renamed, {lex2} deleted",
        "read {t} issue tracker, {lex0} closed, {lex1} stale, {lex2} new",
        "{name} asked about {t} {lex0}, answered with the usual {lex1} doc",
    ]

def gen(seed, n_concepts, n_filler, bridge_p=0.4):
    rng = random.Random(seed)
    topics = rng.sample(TOPICS, 8)
    old_topics, new_topics = topics[:6], topics[6:]
    concepts, sessions, sid = [], [], 0

    def add(day, topic_name, text, tag, concept_id=None):
        nonlocal sid
        sessions.append({"id": f"s{sid:04d}", "day": day, "topic": topic_name, "text": text, "tag": tag, "concept": concept_id})
        sid += 1

    names = rng.sample(FIRST, 12)

    def alias(topic, used):
        while True:
            al = "the " + rng.choice(topic["lex"]) + " " + rng.choice(SUFFIX)
            if al not in used:
                used.add(al)
                return al

    for ci in range(n_concepts):
        topic = rng.choice(old_topics)
        used = set()
        alA, alB = alias(topic, used), alias(topic, used)
        lex = topic["lex"]
        tA = rng.choice(fact_templates_A()).format(a=alA, w0=rng.choice(lex), w1=rng.choice(lex), w2=rng.choice(lex))
        keys = rng.sample(list(B_WORDS), 3)
        tB = rng.choice(fact_templates_B()).format(
            a=alB, b0=rng.choice(B_WORDS[keys[0]]), b1=rng.choice(B_WORDS[keys[1]]),
            b2=rng.choice(B_WORDS[keys[2]]), name=rng.choice(names))
        day_a = rng.randrange(0, 400)
        day_b = day_a + rng.randrange(30, 200)
        cid = f"c{ci:03d}"
        add(day_a, topic["name"], f"{tA}.", "target", cid)
        add(day_b, topic["name"], f"{tB}.", "probe", cid)

        bridged = rng.random() < bridge_p
        if bridged:
            add(rng.randrange(day_a, day_b), topic["name"],
                f"migrated {alA} onto {alB} today, {rng.choice(lex)} unaffected.".replace("the the ", "the "), "bridge", cid)
            add(rng.randrange(day_a, day_b), topic["name"],
                f"{rng.choice(names)} asked whether {alB} replaced {alA}; yes.".replace("the the ", "the "), "bridge", cid)

        same_topic_aliases = [c for c in concepts if c["topic"] == topic["name"]] if concepts else []
        for j in range(rng.randrange(2, 4)):
            mention_pool = [alA, alB] + [c["aliasA"] for c in rng.sample(same_topic_aliases, min(2, len(same_topic_aliases)))] if same_topic_aliases else [alA, alB]
            rng.shuffle(mention_pool)
            add(rng.randrange(0, 620), topic["name"],
                f"on-call note: {', '.join(mention_pool)} all flapped during the night, {rng.choice(lex)} team pinged.".replace("the the ", "the "),
                "comention", cid)

        concepts.append({"id": cid, "aliasA": alA, "aliasB": alB, "topic": topic["name"], "bridged": bridged,
                         "target_session": f"s{sid-2-0:04d}" if False else None})

    all_concept_sessions = {}
    for s in sessions:
        if s["concept"]:
            all_concept_sessions.setdefault(s["concept"], []).append(s["id"])
    for c in concepts:
        ids = all_concept_sessions[c["id"]]
        c["target_session"] = next(s["id"] for s in sessions if s["id"] in ids and s["tag"] == "target")
        c["probe_session"] = next(s["id"] for s in sessions if s["id"] in ids and s["tag"] == "probe")

    for i in range(n_filler):
        topic = rng.choice(old_topics + new_topics)
        lex = topic["lex"]
        add(rng.randrange(0, 620), topic["name"],
            rng.choice(filler_templates()).format(
                name=rng.choice(names), v=rng.choice(FILLER_VERBS), t=topic["name"],
                lex0=rng.choice(lex), lex1=rng.choice(lex), lex2=rng.choice(lex)) + ".",
            "filler")

    sessions.sort(key=lambda s: (s["day"], s["id"]))
    for i, s in enumerate(sessions):
        s["pos"] = i

    heldout = {}
    for s in sessions:
        if s["tag"] in ("target", "probe", "bridge", "comention"):
            continue
        key = "new" if s["topic"] in [t["name"] for t in new_topics] else "old"
        if rng.random() < 0.12:
            heldout.setdefault(key, []).append(s["id"])

    associations = []
    for c in concepts:
        target = next(s for s in sessions if s["id"] == c["target_session"])
        pool = [x for x in concepts if x["id"] != c["id"] and x["topic"] == c["topic"]]
        decoy_ids = [d["target_session"] for d in rng.sample(pool, min(9, len(pool)))]
        associations.append({
            "concept": c["id"], "aliasA": c["aliasA"], "aliasB": c["aliasB"], "bridged": c["bridged"],
            "probe": next(s for s in sessions if s["id"] == c["probe_session"]),
            "target": target,
            "decoys": [next(s for s in sessions if s["id"] == d) for d in decoy_ids],
        })

    return {"sessions": sessions, "concepts": concepts, "associations": associations,
            "heldout": heldout, "topics": {"old": [t["name"] for t in old_topics], "new": [t["name"] for t in new_topics]}}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--concepts", type=int, default=80)
    ap.add_argument("--filler", type=int, default=6000)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    data = gen(a.seed, a.concepts, a.filler)
    with open(os.path.join(a.out, "ledger.json"), "w") as f:
        json.dump(data, f)
    os.makedirs(os.path.join(a.out, "sessions"), exist_ok=True)
    for s in data["sessions"]:
        with open(os.path.join(a.out, "sessions", s["id"] + ".md"), "w") as f:
            f.write(f"day {s['day']} topic {s['topic']}\n{s['text']}\n")
    with open(os.path.join(a.out, "stream_old.txt"), "w") as f:
        f.write("\n".join(f"day {s['day']} topic {s['topic']}\n{s['text']}" for s in data["sessions"] if s["topic"] in data["topics"]["old"]))
    with open(os.path.join(a.out, "stream_new.txt"), "w") as f:
        f.write("\n".join(f"day {s['day']} topic {s['topic']}\n{s['text']}" for s in data["sessions"] if s["topic"] in data["topics"]["new"]))
    chars = sum(len(s["text"]) for s in data["sessions"])
    nb = sum(1 for c in data["concepts"] if not c["bridged"])
    print(f"sessions={len(data['sessions'])} concepts={len(data['concepts'])} (unbridged={nb}) chars={chars}")
    print("sample target:", next(s["text"] for s in data["sessions"] if s["tag"]=="target")[:110])
    print("sample probe: ", next(s["text"] for s in data["sessions"] if s["tag"]=="probe")[:110])

if __name__ == "__main__":
    main()
