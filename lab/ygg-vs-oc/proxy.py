#!/usr/bin/env python3
"""YGG-VS-OC metering proxy: one instance per brain, between the brain and z.ai.

Forwards every request byte-for-byte (path preserved, auth headers passed through — the proxy
never holds a key), streams the response back as it arrives, and logs one JSON line per
upstream call: model, request size, time to headers / first byte / first text / first think
token, and the provider's own usage numbers (anthropic `message_start`/`message_delta`, openai
final-chunk `usage`). The same instrument for both brains = token counts that compare.

Usage: proxy.py --port 18281 --tag B --log ~/.cache/ygg-vs-oc/proxy-B.jsonl [--upstream https://api.z.ai]
"""
import argparse
import http.client
import json
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOP = {"host", "connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding",
       "proxy-connection", "te", "trailer", "upgrade"}
LOCK = threading.Lock()


class Meter:
    """Incremental SSE/JSON reader that pulls timing + usage out of either dialect."""

    def __init__(self, t0):
        self.t0 = t0
        self.buf = b""
        self.first_text = None
        self.first_think = None
        self.first_tool = None
        self.usage = {}
        self.blocks = {}
        self.stop = None
        self.err = None
        self.text_chars = 0
        self.think_chars = 0

    def _ms(self):
        return round((time.time() - self.t0) * 1000)

    def feed(self, chunk):
        self.buf += chunk
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            line = line.strip()
            if line.startswith(b"data:"):
                data = line[5:].strip()
                if data and data != b"[DONE]":
                    try:
                        self.event(json.loads(data))
                    except ValueError:
                        pass

    def event(self, v):
        t = v.get("type")
        if t == "message_start":  # anthropic
            u = v.get("message", {}).get("usage", {})
            self.usage.update({k: u[k] for k in u if isinstance(u[k], (int, float))})
        elif t == "content_block_start":
            bt = v.get("content_block", {}).get("type", "?")
            self.blocks[bt] = self.blocks.get(bt, 0) + 1
            if bt == "tool_use" and self.first_tool is None:
                self.first_tool = self._ms()
        elif t == "content_block_delta":
            d = v.get("delta", {})
            if d.get("type") == "text_delta" and d.get("text"):
                self.text_chars += len(d["text"])
                if self.first_text is None:
                    self.first_text = self._ms()
            elif d.get("type") == "thinking_delta" and d.get("thinking"):
                self.think_chars += len(d["thinking"])
                if self.first_think is None:
                    self.first_think = self._ms()
        elif t == "message_delta":
            u = v.get("usage", {})
            self.usage.update({k: u[k] for k in u if isinstance(u[k], (int, float))})
            self.stop = v.get("delta", {}).get("stop_reason") or self.stop
        elif t == "error":
            self.err = json.dumps(v.get("error", v))[:300]
        elif "choices" in v or "usage" in v:  # openai-compatible chunk
            for c in v.get("choices") or []:
                d = c.get("delta") or c.get("message") or {}
                if d.get("content"):
                    self.text_chars += len(d["content"])
                    if self.first_text is None:
                        self.first_text = self._ms()
                rc = d.get("reasoning_content") or d.get("reasoning")
                if rc:
                    self.think_chars += len(rc)
                    if self.first_think is None:
                        self.first_think = self._ms()
                if d.get("tool_calls") and self.first_tool is None:
                    self.first_tool = self._ms()
                if c.get("finish_reason"):
                    self.stop = c["finish_reason"]
            u = v.get("usage")
            if isinstance(u, dict):
                flat = {k: u[k] for k in u if isinstance(u[k], (int, float))}
                for sub in ("prompt_tokens_details", "completion_tokens_details"):
                    for k, x in (u.get(sub) or {}).items():
                        if isinstance(x, (int, float)):
                            flat[f"{sub.split('_')[0]}.{k}"] = x
                self.usage.update(flat)

    def finish_json(self, body):
        """A non-streamed reply (roll-up summaries): one JSON object."""
        try:
            v = json.loads(body)
        except ValueError:
            return
        if v.get("type") == "message":
            self.usage.update({k: x for k, x in (v.get("usage") or {}).items() if isinstance(x, (int, float))})
            for b in v.get("content") or []:
                self.blocks[b.get("type", "?")] = self.blocks.get(b.get("type", "?"), 0) + 1
            self.stop = v.get("stop_reason")
        else:
            self.event(v)


def make_handler(upstream, tag, log_path):
    up = urllib.parse.urlsplit(upstream)

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _proxy(self):
            t0 = time.time()
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            rec = {"tag": tag, "t0": round(t0, 3), "method": self.command, "path": self.path, "req_bytes": len(body)}
            try:
                j = json.loads(body) if body else {}
                rec["model"] = j.get("model")
                msgs = j.get("messages") or []
                rec["n_messages"] = len(msgs)
                sysp = j.get("system")
                rec["sys_chars"] = len(json.dumps(sysp)) if sysp else sum(
                    len(json.dumps(m.get("content"))) for m in msgs if m.get("role") == "system")
                rec["tools_n"] = len(j.get("tools") or [])
                rec["stream"] = bool(j.get("stream"))
                for k in ("reasoning_effort", "thinking", "stream_options", "max_tokens", "temperature"):
                    if k in j:
                        rec[k] = j[k]
            except ValueError:
                pass
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
            headers["Accept-Encoding"] = "identity"
            headers["Host"] = up.netloc
            meter = Meter(t0)
            status = 0
            try:
                conn = http.client.HTTPSConnection(up.netloc, timeout=900) if up.scheme == "https" \
                    else http.client.HTTPConnection(up.netloc, timeout=900)
                conn.request(self.command, up.path.rstrip("/") + self.path, body=body or None, headers=headers)
                resp = conn.getresponse()
                status = resp.status
                rec["t_hdr"] = round((time.time() - t0) * 1000)
                self.send_response(resp.status)
                for k, v in resp.getheaders():
                    if k.lower() not in HOP:
                        self.send_header(k, v)
                self.send_header("Connection", "close")
                self.end_headers()
                ctype = resp.getheader("Content-Type", "")
                whole = b""
                first = True
                while True:
                    chunk = resp.read1(65536)
                    if not chunk:
                        break
                    if first:
                        rec["t_first_byte"] = round((time.time() - t0) * 1000)
                        first = False
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    if "event-stream" in ctype:
                        meter.feed(chunk)
                    else:
                        whole += chunk
                if whole:
                    meter.finish_json(whole)
                    if status >= 400:
                        rec["err_body"] = whole[:400].decode("utf-8", "replace")
                conn.close()
            except Exception as e:  # noqa: BLE001 — logged, never swallowed silently
                rec["exc"] = f"{type(e).__name__}: {e}"[:300]
                if not status:
                    try:
                        self.send_error(502, "proxy upstream failure")
                    except Exception:  # noqa: BLE001
                        pass
            rec.update({"status": status, "t_end": round((time.time() - t0) * 1000), "t_first_text": meter.first_text,
                        "t_first_think": meter.first_think, "t_first_tool": meter.first_tool, "usage": meter.usage,
                        "blocks": meter.blocks, "stop": meter.stop, "text_chars": meter.text_chars,
                        "think_chars": meter.think_chars})
            if meter.err:
                rec["stream_err"] = meter.err
            with LOCK, open(log_path, "a") as f:
                f.write(json.dumps(rec) + "\n")
            self.close_connection = True

        do_POST = do_GET = _proxy

    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--upstream", default="https://api.z.ai")
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(a.upstream, a.tag, a.log))
    srv.daemon_threads = True
    print(f"proxy {a.tag} :{a.port} -> {a.upstream} log {a.log}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
