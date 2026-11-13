"""The librarian against a fake root, through its real HTTP interface. `python3 test_librarian.py`."""
import json
import os
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import librarian

NOW = int(time.time() * 1000)
SESSIONS = [
    {"id": "ses_a", "title": "Inventory storage research", "agent": "research",
     "time": {"updated": NOW - 120_000}, "card": {"status": "done", "headline": "SQLite wins over a JSON file"}},
    {"id": "ses_b", "title": "Old lighthouse story", "agent": "build",
     "time": {"updated": NOW - 3 * 3_600_000}, "card": {"status": "done", "headline": "a story"}},
]
MESSAGES = {
    "ses_a": [
        {"info": {"id": "m1", "role": "user", "time": {"created": NOW - 300_000}}, "parts": [{"type": "text", "text": "sqlite or json for the inventory?"}]},
        {"info": {"id": "m2", "role": "assistant", "time": {"created": NOW - 120_000}}, "parts": [
            {"type": "tool", "tool": "webfetch", "state": {"input": {"url": "https://sqlite.org/whentouse.html"}}},
            {"type": "text", "text": "Use SQLite: transactions, concurrent readers, one file. The teal inventory needs it."}]},
    ],
    "ses_b": [{"info": {"id": "m3", "role": "assistant", "time": {"created": NOW - 3 * 3_600_000}}, "parts": [{"type": "text", "text": "The keeper lit the lamp."}]}],
}


class FakeRoot(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        body = SESSIONS if path == "/session" else MESSAGES.get(path.split("/")[2], [])
        b = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


def serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}"


def call(base, tool, **inp):
    req = urllib.request.Request(f"{base}/call/{tool}", data=json.dumps({"input": inp, "session": "ses_x"}).encode(), method="POST")
    return json.load(urllib.request.urlopen(req))


def test_all():
    root = serve(FakeRoot)
    d = tempfile.mkdtemp()
    arts = os.path.join(d, "artifacts")
    os.mkdir(arts)
    open(os.path.join(arts, "report.md"), "w").write("# Review\nThe mutable default in add_item leaks tags.")
    seed = os.path.join(d, "seed.json")
    json.dump({"facts": [{"topic": "garden", "fact": "tomatoes go in the south bed", "days_ago": 6}]}, open(seed, "w"))
    lib = librarian.Library(os.path.join(d, "lib.db"))
    lib.seed(seed)
    assert librarian.index_once(lib, root, arts) == 3, "two sessions + one artifact"
    assert librarian.index_once(lib, root, arts) == 0, "nothing changed: nothing re-indexed"
    base = serve(librarian.handler_for(lib))

    man = json.load(urllib.request.urlopen(f"{base}/manifest"))
    assert [t["name"] for t in man["tools"]] == ["search", "recent", "remember", "recall"]
    assert all(t["scope"] == "self" for t in man["tools"])
    assert "librarian_search" in man["prompt"], "tells agents when to reach for it"

    out = call(base, "search", query="teal inventory")["output"]
    assert '"Inventory storage research"' in out and "[teal]" in out, out
    assert "nothing found" in call(base, "search", query="lighthouse lamp", since_minutes=30)["output"]
    assert "keeper" in call(base, "search", query="lamp")["output"]
    art = call(base, "search", query="mutable default")["output"]
    assert "/api/artifact/report.md" in art, art

    rec = call(base, "recent", minutes=10)["output"]
    assert "1 session(s)" in rec and "SQLite wins" in rec and "keywords:" in rec and "lighthouse" not in rec.lower(), rec

    assert "kept under 'inventory'" in call(base, "remember", topic="inventory", fact="db is sqlite, decided 11-13")["output"]
    assert "db is sqlite" in call(base, "recall", topic="inventory")["output"]
    assert "south bed" in call(base, "recall", topic="garden")["output"], "seeded past memory"
    assert "no facts" in call(base, "recall", topic="nothing-here")["output"]
    assert "error" in call(base, "nope")


if __name__ == "__main__":
    test_all()
    print("ok: librarian")
