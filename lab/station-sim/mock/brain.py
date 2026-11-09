#!/usr/bin/env python3
"""Fake brain sink for station-sim. usage: brain.py PORT BRAIN_DIR
GET /session  -> $BRAIN_DIR/sessions.json (default: one "[MAIN]" session)
POST /session/<id>/message -> logs one JSON line to $BRAIN_DIR/posts.log with the HTTP code
returned; $BRAIN_DIR/mode = "ok" (default, 200) or "503" (flip per case). "Down" = the case
stops/starts this process."""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, BD = int(sys.argv[1]), sys.argv[2]
DEFAULT = [{"id": "ses_main", "title": "[MAIN]", "time": {"updated": 1}}]

def mode():
    try:
        return open(os.path.join(BD, "mode")).read().strip() or "ok"
    except OSError:
        return "ok"

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body=b"{}"):
        self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path.startswith("/session"):
            try: data = json.load(open(os.path.join(BD, "sessions.json")))
            except Exception: data = DEFAULT
            return self._send(200, json.dumps(data).encode())
        self._send(404)
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); raw = self.rfile.read(n)
        code = 503 if mode() == "503" else 200
        try: text = json.loads(raw)["parts"][0]["text"]
        except Exception: text = "<unparseable>"
        sid = self.path.split("/")[2] if self.path.count("/") >= 3 else "?"
        with open(os.path.join(BD, "posts.log"), "a") as f:
            f.write(json.dumps({"t": time.time(), "sid": sid, "code": code, "text": text}) + "\n")
        self._send(code)

ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
