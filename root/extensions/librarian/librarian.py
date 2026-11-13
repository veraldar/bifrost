#!/usr/bin/env python3
"""librarian — a yggdrasil extension (outside the core): the root's memory.

A loop indexes everything said in every session of a root (and its artifacts folder) into SQLite
full-text search, with the keywords of each session; agents also keep facts per topic. Four tools,
served through the extension interface (yggdrasil src/ext.rs), all scope "self":

  search(query, limit, since_minutes)  find what was said, in any session, with where and when
  recent(minutes)                      what happened lately: every session that changed, its agent,
                                       status, headline and keywords
  remember(topic, fact)                keep a fact for later (a decision, a preference, a path)
  recall(topic)                        the facts kept for a topic, newest first

Run:   python3 librarian.py --root http://127.0.0.1:4101 --port 4310 --db librarian.db \
           [--artifacts DIR] [--poll 20] [--seed seed.json]
Root:  YGG_EXTENSIONS=librarian=http://127.0.0.1:4310   (YGG_EXT_TOKEN on both sides, optional)
Standard library only.
"""
import argparse
import html
import json
import os
import re
import sqlite3
import threading
import time
import urllib.request
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("YGG_EXT_TOKEN", "")
STOP = set(
    """this that with from have will what when your there their about would could should which
    into than then them they been were also just like more some only over very here want need
    make made done does dont didnt cant wont yes okay sure please thanks thank reply answer
    session sessions user agent tool tools output file files text line lines dans pour avec
    cette sont mais plus fait faire nous vous elle read keep tell mode short write created""".split()
)

MANIFEST = {
    "name": "librarian",
    "description": "the root's memory: everything said in every session, what happened lately, and facts kept per topic",
    # joins every agent's shared prompt while the librarian is up (yggdrasil ext.rs)
    "prompt": "The user's past work lives here — what was said in every session (older and closed ones too), decisions and facts. Before saying you don't know or don't remember, look with librarian_search / librarian_recall; keep decisions and preferences the user states with librarian_remember.",
    "tools": [
        {"name": "search", "scope": "self",
         "description": "Full-text search over every session's messages, cards and the artifacts, ranked; each hit says which session, who said it and how long ago.",
         "parameters": {"type": "object", "properties": {
             "query": {"type": "string", "description": "words to look for"},
             "limit": {"type": "integer", "description": "max hits (default 8)"},
             "since_minutes": {"type": "integer", "description": "only what was said in the last N minutes"}},
             "required": ["query"]}},
        {"name": "recent", "scope": "self",
         "description": "What happened lately: every session that changed in the last N minutes with its agent, status, headline and keywords.",
         "parameters": {"type": "object", "properties": {
             "minutes": {"type": "integer", "description": "how far back (default 60)"}}}},
        {"name": "remember", "scope": "self",
         "description": "Keep a fact for later under a topic (a project name, a person, a preference): decisions, choices, paths, conventions.",
         "parameters": {"type": "object", "properties": {
             "topic": {"type": "string"}, "fact": {"type": "string"}}, "required": ["topic", "fact"]}},
        {"name": "recall", "scope": "self",
         "description": "The facts kept for a topic (or containing the words), newest first.",
         "parameters": {"type": "object", "properties": {
             "topic": {"type": "string"}}, "required": ["topic"]}},
    ],
}


def now_ms():
    return int(time.time() * 1000)


def ago(ms):
    s = max(0, (now_ms() - int(ms or 0)) // 1000)
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if s >= n:
            return f"{s // n}{unit} ago"
    return f"{s}s ago"


def keywords(text, n=6):
    text = re.sub(r"\S*[/\\]\S*|\S+\.\w{1,4}\b", " ", text)  # paths and file names are not topics
    words = re.findall(r"[a-zà-ÿ][a-zà-ÿ0-9_-]{3,}", text.lower())
    return [w for w, _ in Counter(w for w in words if w not in STOP).most_common(n)]


class Library:
    def __init__(self, path):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript("""
                CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
                    body, title, key UNINDEXED, session UNINDEXED, kind UNINDEXED, ts UNINDEXED);
                CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, title TEXT, agent TEXT,
                    status TEXT, headline TEXT, updated INTEGER, keywords TEXT);
                CREATE TABLE IF NOT EXISTS seen(key TEXT PRIMARY KEY, mark INTEGER);
                CREATE TABLE IF NOT EXISTS facts(id INTEGER PRIMARY KEY, topic TEXT, fact TEXT,
                    ts INTEGER, session TEXT);
            """)

    # ── indexing ──────────────────────────────────────────────────────────────────────────────
    def changed(self, key, mark):
        with self.lock:
            row = self.db.execute("SELECT mark FROM seen WHERE key=?", (key,)).fetchone()
        return not row or row[0] != mark

    def put_session(self, info, messages):
        sid, title = info["id"], info.get("title") or info["id"]
        card = info.get("card") or {}
        rows, words = [], []
        for m in messages:
            mi = m.get("info") or {}
            parts = []
            for p in m.get("parts") or []:
                if p.get("type") == "text" and p.get("text"):
                    parts.append(p["text"])
                elif p.get("type") == "tool":
                    inp = (p.get("state") or {}).get("input") or {}
                    key = next((str(inp[k]) for k in ("title", "query", "command", "filePath", "path", "url", "brief") if inp.get(k)), "")
                    parts.append(f"[tool {p.get('tool')}] {key[:300]}")
            body = "\n".join(parts).strip()
            if body:
                rows.append((body, title, mi.get("id", ""), sid, mi.get("role", ""), int((mi.get("time") or {}).get("created") or 0)))
                words.append(body)
        cardtext = " · ".join(str(card[k]) for k in ("topic", "brief", "headline", "summary", "needs") if card.get(k))
        if cardtext:
            rows.append((cardtext, title, f"card:{sid}", sid, "card", int((info.get("time") or {}).get("updated") or 0)))
        updated = int((info.get("time") or {}).get("updated") or 0)
        with self.lock, self.db:
            self.db.execute("DELETE FROM docs WHERE session=?", (sid,))
            self.db.executemany("INSERT INTO docs(body,title,key,session,kind,ts) VALUES(?,?,?,?,?,?)", rows)
            self.db.execute("INSERT OR REPLACE INTO sessions VALUES(?,?,?,?,?,?,?)", (
                sid, title, info.get("agent") or "", card.get("status") or "", card.get("headline") or "",
                updated, ", ".join(keywords("\n".join(words)))))
            self.db.execute("INSERT OR REPLACE INTO seen VALUES(?,?)", (f"s:{sid}", updated))

    def put_artifact(self, name, text, mtime):
        with self.lock, self.db:
            self.db.execute("DELETE FROM docs WHERE key=?", (f"artifact:{name}",))
            self.db.execute("INSERT INTO docs(body,title,key,session,kind,ts) VALUES(?,?,?,?,?,?)",
                            (text, name, f"artifact:{name}", "", "artifact", mtime))
            self.db.execute("INSERT OR REPLACE INTO seen VALUES(?,?)", (f"a:{name}", mtime))

    # ── the tools ────────────────────────────────────────────────────────────────────────────
    def search(self, query, limit=8, since_minutes=None):
        words = re.findall(r"\w+", query or "")
        if not words:
            return "say what to look for"
        since = now_ms() - int(since_minutes) * 60_000 if since_minutes else 0
        for joiner in (" AND ", " OR "):  # all the words first, then any of them
            q = joiner.join('"' + w.replace('"', "") + '"' for w in words)
            with self.lock:
                hits = self.db.execute(
                    "SELECT title, session, kind, ts, key, snippet(docs, 0, '[', ']', '…', 14) FROM docs "
                    "WHERE docs MATCH ? AND CAST(ts AS INTEGER) >= ? ORDER BY bm25(docs) LIMIT ?",
                    (q, since, max(1, min(int(limit or 8), 25)))).fetchall()
            if hits:
                break
        if not hits:
            return f"nothing found for {query!r}" + (f" in the last {since_minutes} minutes" if since_minutes else "")
        out = []
        for title, sid, kind, ts, key, snip in hits:
            snip = " ".join(snip.split())
            if kind == "artifact":
                out.append(f"- artifact {title} ({ago(ts)}): {snip} — [{title}](/api/artifact/{title})")
            else:
                out.append(f'- "{title}" ({kind}, {ago(ts)}, id={sid}): {snip}')
        return "\n".join(out)

    def recent(self, minutes=60):
        minutes = int(minutes or 60)
        with self.lock:
            rows = self.db.execute(
                "SELECT id, title, agent, status, headline, updated, keywords FROM sessions WHERE updated >= ? "
                "ORDER BY updated DESC LIMIT 40", (now_ms() - minutes * 60_000,)).fetchall()
            said = dict(self.db.execute(
                "SELECT session, count(*) FROM docs WHERE kind IN ('user','assistant') AND CAST(ts AS INTEGER) >= ? "
                "GROUP BY session", (now_ms() - minutes * 60_000,)).fetchall())
        if not rows:
            return f"nothing changed in the last {minutes} minutes"
        out = [f"{len(rows)} session(s) changed in the last {minutes} minutes:"]
        for sid, title, agent, status, head, upd, kw in rows:
            out.append(f'- "{title}" [{agent or "?"}, {status or "idle"}, {ago(upd)}, {said.get(sid, 0)} message(s)] '
                       f'{head or ""}' + (f" — keywords: {kw}" if kw else "") + f" (id={sid})")
        return "\n".join(out)

    def remember(self, topic, fact, session=""):
        topic, fact = (topic or "").strip(), (fact or "").strip()
        if not topic or not fact:
            return "need a topic and a fact"
        with self.lock, self.db:
            self.db.execute("INSERT INTO facts(topic,fact,ts,session) VALUES(?,?,?,?)", (topic, fact, now_ms(), session))
        return f"kept under {topic!r}"

    def recall(self, topic):
        t = f"%{(topic or '').strip()}%"
        with self.lock:
            rows = self.db.execute("SELECT topic, fact, ts FROM facts WHERE topic LIKE ? OR fact LIKE ? "
                                   "ORDER BY ts DESC LIMIT 20", (t, t)).fetchall()
        if not rows:
            return f"no facts kept for {topic!r} — try search for what was said about it"
        return "\n".join(f"- [{tp}] {fact} ({ago(ts)})" for tp, fact, ts in rows)

    def seed(self, path):
        """Past memory for simulations: {"facts": [{topic, fact, days_ago}], "docs": [{title, body, days_ago}]}."""
        d = json.load(open(path))
        day = 86_400_000
        with self.lock, self.db:
            for f in d.get("facts", []):
                self.db.execute("INSERT INTO facts(topic,fact,ts,session) VALUES(?,?,?,?)",
                                (f["topic"], f["fact"], now_ms() - int(f.get("days_ago", 1) * day), "seed"))
            for i, x in enumerate(d.get("docs", [])):
                ts = now_ms() - int(x.get("days_ago", 1) * day)
                self.db.execute("INSERT INTO docs(body,title,key,session,kind,ts) VALUES(?,?,?,?,?,?)",
                                (x["body"], x["title"], f"seed:{i}", x.get("session", "seed"), x.get("kind", "assistant"), ts))


def fetch(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def index_once(lib, root, artifacts=None):
    """One pass: every session whose update mark moved, every artifact whose mtime moved."""
    n = 0
    for info in fetch(f"{root}/session"):
        mark = int((info.get("time") or {}).get("updated") or 0)
        if lib.changed(f"s:{info['id']}", mark):
            lib.put_session(info, fetch(f"{root}/session/{info['id']}/message?internal=1", 30))
            n += 1
    if artifacts and os.path.isdir(artifacts):
        for name in os.listdir(artifacts):
            p = os.path.join(artifacts, name)
            if not name.lower().endswith((".md", ".txt", ".html", ".json", ".csv")) or not os.path.isfile(p):
                continue
            if os.path.getsize(p) > 1_000_000:
                continue
            mtime = int(os.path.getmtime(p) * 1000)
            if lib.changed(f"a:{name}", mtime):
                text = open(p, errors="ignore").read()
                if name.endswith(".html"):
                    text = html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"(?s)<(script|style).*?</\1>", " ", text)))
                lib.put_artifact(name, " ".join(text.split()), mtime)
                n += 1
    return n


def handler_for(lib):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def send(self, code, body):
            b = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def authorized(self):
            return not TOKEN or self.headers.get("x-ygg-ext") == TOKEN

        def do_GET(self):
            if not self.authorized():
                return self.send(401, {"error": "bad extension token"})
            if self.path == "/manifest":
                return self.send(200, MANIFEST)
            if self.path == "/health":
                with lib.lock:
                    n = lib.db.execute("SELECT count(*) FROM docs").fetchone()[0]
                return self.send(200, {"ok": True, "docs": n})
            self.send(404, {"error": "not found"})

        def do_POST(self):
            if not self.authorized():
                return self.send(401, {"error": "bad extension token"})
            m = re.fullmatch(r"/call/(\w+)", self.path)
            if not m:
                return self.send(404, {"error": "not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                a = body.get("input") or {}
                tool = m.group(1)
                if tool == "search":
                    out = lib.search(a.get("query", ""), a.get("limit", 8), a.get("since_minutes"))
                elif tool == "recent":
                    out = lib.recent(a.get("minutes", 60))
                elif tool == "remember":
                    out = lib.remember(a.get("topic", ""), a.get("fact", ""), body.get("session", ""))
                elif tool == "recall":
                    out = lib.recall(a.get("topic", ""))
                else:
                    return self.send(200, {"error": f"no tool {tool}"})
                self.send(200, {"output": out})
            except Exception as e:  # noqa: BLE001 — an extension answers, never crashes the call
                self.send(200, {"error": f"librarian: {e}"})
    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=os.environ.get("LIB_ROOT", "http://127.0.0.1:4100"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("LIB_PORT", "4310")))
    ap.add_argument("--db", default=os.environ.get("LIB_DB", "librarian.db"))
    ap.add_argument("--artifacts", default=os.environ.get("LIB_ARTIFACTS"))
    ap.add_argument("--poll", type=float, default=float(os.environ.get("LIB_POLL", "20")))
    ap.add_argument("--seed")
    a = ap.parse_args()
    lib = Library(a.db)
    if a.seed:
        lib.seed(a.seed)

    def loop():
        while True:
            try:
                n = index_once(lib, a.root.rstrip("/"), a.artifacts)
                if n:
                    print(f"indexed {n} change(s)", flush=True)
            except Exception as e:  # noqa: BLE001 — the root may be restarting
                print(f"index pass failed: {e}", flush=True)
            time.sleep(a.poll)

    threading.Thread(target=loop, daemon=True).start()
    print(f"librarian on :{a.port} for {a.root} (db {a.db})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), handler_for(lib)).serve_forever()


if __name__ == "__main__":
    main()
