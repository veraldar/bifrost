#!/usr/bin/env python3
"""Throwaway OpenAI-compatible mock: POST /v1/chat/completions, streams a canned
reply (echoing the last user message) as SSE chunks. Usage: mock_upstream.py [port]
Slow mode: if the last user message starts with "slow", the reply is long and each
chunk is delayed 0.2s (~10s total) so clients can abort mid-stream."""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_error(404); return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        last = body["messages"][-1]["content"]
        reply = f"MOCK-REPLY: you said '{last}' ({len(body['messages'])} msgs)"
        slow = last.startswith("slow")
        if slow:
            reply += " " + "lorem ipsum " * 30 + "SLOW-END"
        if not body.get("stream"):
            out = json.dumps({"choices": [{"message": {"role": "assistant", "content": reply}}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out); return
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        try:
            for i in range(0, len(reply), 8):
                chunk = {"choices": [{"index": 0, "delta": {"content": reply[i:i+8]}}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode()); self.wfile.flush()
                if slow: time.sleep(0.2)
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            print("mock: client disconnected mid-stream", file=sys.stderr)

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 18080), H).serve_forever()
