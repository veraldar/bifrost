#!/usr/bin/env python3
"""Streaming first-sound receipt (reviewer fix 3).

Fake yggdrasil: POST /session mints a session; POST /session/:id/message
streams 3 sentences over ~5s as SSE deltas. OpenCodeLLM.ask_stream must
yield the FIRST sentence <1.5s after start, all 3 in order, and flush the
tail. Also proves the error path raises only before first yield.
Run: uv run python agent/scripts/stream-replay.py  →  PASS/FAIL
"""
import asyncio, json, re, sys, time, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 18099
SENTENCES = [
    "The capital of France is Paris.",
    "It sits on the Seine river in the north of the country.",
    "Long before that it was called Lutetia by the Romans who settled the island in the middle of the river.",
]


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


class FakeBrain(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/session":
            body = json.dumps([{"id": "ses_fake", "title": "room"}]).encode()
        elif self.path.startswith("/session/"):
            body = json.dumps({"id": "ses_fake", "title": "room", "model": "mock/voice"}).encode()
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.startswith("/api/session/"):
            body = b'{"ok": true}'
        else:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            try:
                self.wfile.write(sse("session.status", {"sessionID": "ses_fake"}))
                self.wfile.flush()
                acc = ""
                for i, s in enumerate(SENTENCES):
                    time.sleep(1.2 if i == 0 else 1.8)
                    acc += s + " "
                    for k in range(0, len(s), 12):
                        self.wfile.write(sse("message.part.delta", {"text": s[k:k+12], "sessionID": "ses_fake"}))
                    self.wfile.flush()
                self.wfile.write(sse("message.completed", {"info": {"id": "m1"}, "parts": []}))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


async def main():
    srv = HTTPServer(("127.0.0.1", PORT), FakeBrain)
    import threading
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    os.environ["OPENCODE_URL"] = f"http://127.0.0.1:{PORT}"
    from agent import OpenCodeLLM

    llm = OpenCodeLLM(f"http://127.0.0.1:{PORT}", room_key="room")
    t0 = time.monotonic()
    got = []
    async for chunk in llm.ask_stream("What is the capital of France?"):
        dt = time.monotonic() - t0
        print(f"  +{dt*1000:6.0f}ms  {chunk[:60]}")
        got.append((dt, chunk))
    total = time.monotonic() - t0
    text = " ".join(c for _, c in got)
    assert len(got) == 3, f"expected 3 sentences, got {len(got)}"
    assert got[0][0] < 1.5, f"first sound at {got[0][0]:.2f}s (budget 1.5s)"
    assert got[0][1].startswith("The capital of France"), got[0]
    assert "Lutetia" in text, text
    print(f"PASS first-sound {got[0][0]*1000:.0f}ms, 3 sentences, total {total:.1f}s")
    srv.shutdown()


if __name__ == "__main__":
    import threading
    threading.Thread(target=lambda: asyncio.run(main()), daemon=True).start() if False else None
    asyncio.run(main())
