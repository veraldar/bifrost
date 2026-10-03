#!/usr/bin/env python3
"""Throwaway OpenAI-compatible mock: POST /v1/chat/completions, streams a canned
reply (echoing the last user message) as SSE chunks. Usage: mock_upstream.py [port]
Slow mode: if the last user message starts with "slow", the reply is long and each
chunk is delayed 0.2s (~10s total) so clients can abort mid-stream.
Slice 3 (bifrost e2e prompts): "sleep N" anywhere delays the first chunk N seconds
(stands in for a long tool run); "reply with exactly: X" makes the whole reply X
(echo of the instruction, as a compliant model would answer).
MOCK_LATENCY=<seconds> (env, default 0) delays every first chunk like a real provider's
time-to-first-token.
Slice 6a tool mode (last user message starts with "tool:"):
  "tool:forever"       every step requests bash `echo loop >> loop.txt` (never stops)
  "tool:<json>"        a script: list of steps, each a list of [name, args] calls; step k
                       = number of assistant tool_call turns since that user message. When
                       the script is exhausted, the reply is final text:
                       TOOL-FINAL: <last tool result> [tools declared: N] [tool msgs in history: K]
  Each tool step streams a short text ("step k.") before its tool_calls; arguments are split
  across two chunks so the server must reassemble them."""
import os
import json, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_error(404); return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        users = [i for i, m in enumerate(body["messages"]) if m["role"] == "user"]
        if users and body["messages"][users[-1]]["content"].startswith("tool:"):
            return self.tool_mode(body, users[-1])
        last = body["messages"][-1]["content"]
        reply = f"MOCK-REPLY: you said '{last}' ({len(body['messages'])} msgs)"
        slow = last.startswith("slow")
        exact = re.search(r"reply(?: with exactly)?:\s*(\S+)", last, re.I)
        if exact:
            reply = exact.group(1).rstrip(".")
        nap = re.search(r"\bsleep (\d+)", last)
        if slow:
            reply += " " + "lorem ipsum " * 30 + "SLOW-END"
        if not body.get("stream"):
            out = json.dumps({"choices": [{"message": {"role": "assistant", "content": reply}}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out); return
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        try:
            time.sleep(float(os.environ.get("MOCK_LATENCY", "0")))
            if nap:
                time.sleep(int(nap.group(1)))
            for i in range(0, len(reply), 8):
                chunk = {"choices": [{"index": 0, "delta": {"content": reply[i:i+8]}}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode()); self.wfile.flush()
                if slow: time.sleep(0.2)
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            print("mock: client disconnected mid-stream", file=sys.stderr)

    def tool_mode(self, body, ui):
        msgs = body["messages"]
        spec = msgs[ui]["content"][len("tool:"):].strip()
        step = sum(1 for m in msgs[ui + 1:] if m["role"] == "assistant" and m.get("tool_calls"))
        if spec == "forever":
            calls = [["bash", {"command": "echo loop >> loop.txt"}]]
        else:
            script = json.loads(spec)
            calls = script[step] if step < len(script) else None
        stream = body.get("stream")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if stream else "application/json")
        if calls is None:
            last_tool = next((m["content"] for m in reversed(msgs) if m["role"] == "tool"), "")
            n_tools = len(body.get("tools") or [])
            k = sum(1 for m in msgs if m["role"] == "tool")
            reply = f"TOOL-FINAL: {last_tool} [tools declared: {n_tools}] [tool msgs in history: {k}]"
            if not stream:
                out = json.dumps({"choices": [{"message": {"role": "assistant", "content": reply}}]}).encode()
                self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out); return
            self.end_headers()
            chunks = [{"content": reply[i:i+64]} for i in range(0, len(reply), 64)]
        else:
            tcs = [{"id": f"call_{step}_{j}", "type": "function",
                    "function": {"name": n, "arguments": json.dumps(a)}} for j, (n, a) in enumerate(calls)]
            if not stream:
                out = json.dumps({"choices": [{"message": {"role": "assistant", "content": f"step {step}.",
                                                           "tool_calls": tcs}, "finish_reason": "tool_calls"}]}).encode()
                self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out); return
            self.end_headers()
            chunks = [{"content": f"step {step}."}]
            for j, tc in enumerate(tcs):
                args = tc["function"]["arguments"]; h = len(args) // 2
                chunks.append({"tool_calls": [{"index": j, "id": tc["id"], "type": "function",
                                               "function": {"name": tc["function"]["name"], "arguments": args[:h]}}]})
                chunks.append({"tool_calls": [{"index": j, "function": {"arguments": args[h:]}}]})
        try:
            for d in chunks:
                self.wfile.write(f"data: {json.dumps({'choices': [{'index': 0, 'delta': d}]})}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 18080), H).serve_forever()
