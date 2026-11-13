import json, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_POST(self):
        b=json.loads(self.rfile.read(int(self.headers['content-length'])))
        ms=b["messages"]; last=[m for m in ms if m["role"]=="user"][-1]["content"]
        done=any(m["role"]=="tool" for m in ms[ms.index([m for m in ms if m["role"]=="user"][-1]):])
        import time
        if "NAP4" in last: time.sleep(4)
        self.send_response(200); self.send_header('content-type','text/event-stream'); self.end_headers()
        def ev(d): self.wfile.write(b"data: "+json.dumps(d).encode()+b"\n\n"); self.wfile.flush()
        m=re.search(r"RUN: (.+)$", last, re.M)
        if m and not done:
            ev({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"bash","arguments":json.dumps({"command":m.group(1)})}}]}}]})
        else:
            tool=[x["content"] for x in ms if x["role"]=="tool"][-1:] 
            ev({"choices":[{"delta":{"content":("TOOL-DONE "+tool[0][:80].replace("\n"," ")) if tool else "ECHO "+last.replace("\n"," ")}}]})
        ev({"choices":[{"delta":{},"finish_reason":"stop"}]}); self.wfile.write(b"data: [DONE]\n\n")
ThreadingHTTPServer(("127.0.0.1",int(sys.argv[1])),H).serve_forever()
