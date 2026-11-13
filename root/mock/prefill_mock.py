# fold-tighten-r1: OpenAI-shape SSE mock whose ttfb scales with the request size (a stand-in for
# upstream prefill). PREFILL_BYTES_PER_MS (default 20) bytes of body cost 1 ms before the first
# chunk. GET /last = the last request body.
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
RATE = float(os.environ.get("PREFILL_BYTES_PER_MS", "20"))
LAST = {}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        b = json.dumps(LAST.get("b", {})).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        raw = self.rfile.read(int(self.headers["content-length"]))
        LAST["b"] = json.loads(raw)
        time.sleep(len(raw) / RATE / 1000)
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        def ev(d): self.wfile.write(b"data: " + json.dumps(d).encode() + b"\n\n"); self.wfile.flush()
        ev({"choices": [{"delta": {"content": "ok noted"}}]})
        ev({"choices": [{"delta": {}, "finish_reason": "stop"}]}); self.wfile.write(b"data: [DONE]\n\n")
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
