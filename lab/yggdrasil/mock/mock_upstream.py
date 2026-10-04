#!/usr/bin/env python3
"""Throwaway upstream mock, both dialects on one port. Usage: mock_upstream.py [port]
OpenAI dialect: POST .../chat/completions, streams a canned reply (echoing the last user
message) as SSE chunks.
Slow mode: if the last user message starts with "slow" (or "count from 1 to"), the reply is
long and each chunk is delayed 0.2s (~10s total) so clients can abort mid-stream.
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
  across two chunks so the server must reassemble them. TOOL-FINAL also reports
  [pruned: P] = tool messages whose content is the roll-up prune stub.
Slice 6b roll-up: a request whose system message starts with "[yggdrasil roll-up]" gets a
  JSON reply "MOCK-SUMMARY: <first USER line of the transcript> | <N> chars".
Slice 7 anthropic dialect: POST .../v1/messages. The request is validated the way the real
  API validates (headers x-api-key + Bearer + anthropic-version, max_tokens, strict
  user/assistant alternation starting with user, no empty text blocks, every tool_use
  answered by a tool_result first in the next user turn, tools declared when tool blocks are
  present, {name, description, input_schema} tools) -> 400 invalid_request_error otherwise.
  A valid request is mapped back to the OpenAI shape and answered by the SAME reply logic,
  encoded as block SSE (message_start, ping, content_block_start/delta/stop with text_delta
  and input_json_delta, message_delta stop_reason end_turn|tool_use, message_stop) or as a
  JSON message — so equal histories get equal replies in both dialects. tool_use ids are
  realistic `toolu_...` ids. Keys "mock-401" / "mock-429" simulate an invalid key and a
  zai-style balance rejection.
Real-upstream dry run: "use the bash tool to run `CMD`" -> one bash call, then
  "The command printed: <output>".
GET /calls -> request counters: chat/summary/summary_with_tools (openai dialect), a_* (anthropic
  dialect; a_max_tokens = last max_tokens seen), disconnects (client dropped mid-stream)."""
import os
import json, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CALLS = {"chat": 0, "summary": 0, "summary_with_tools": 0, "a_chat": 0, "a_summary": 0,
         "a_summary_with_tools": 0, "a_rejected": 0, "a_max_tokens": 0, "disconnects": 0}
NL_TOOL = re.compile(r"use the bash tool to run `([^`]+)`", re.I)
TOOL_ID = re.compile(r"^[a-zA-Z0-9_-]+$")


def plan(body):
    """Dialect-neutral reply for an OpenAI-shaped body."""
    msgs = body["messages"]
    first = msgs[0]
    if first["role"] == "system" and str(first["content"]).startswith("[yggdrasil roll-up]"):
        tr = msgs[-1]["content"]
        head = next((l for l in tr.splitlines() if l.startswith("USER: ")), "")
        return {"kind": "summary", "text": f"MOCK-SUMMARY: {head} | {len(tr)} chars"}
    users = [i for i, m in enumerate(msgs) if m["role"] == "user"]
    if users and msgs[users[-1]]["content"].startswith("tool:"):
        return tool_plan(body, users[-1])
    if users and NL_TOOL.search(msgs[users[-1]]["content"]):
        cmd = NL_TOOL.search(msgs[users[-1]]["content"]).group(1)
        results = [m for m in msgs[users[-1] + 1:] if m["role"] == "tool"]
        if not results:
            return {"kind": "tools", "text": "", "calls": [("call_nl_0", "bash", json.dumps({"command": cmd}))]}
        return {"kind": "text", "text": f"The command printed: {results[-1]['content'].strip()}", "chunk": 8}
    last = msgs[-1]["content"]
    reply = f"MOCK-REPLY: you said '{last}' ({len(msgs)} msgs)"
    slow = last.startswith("slow") or bool(re.match(r"count from 1 to", last, re.I))
    exact = re.search(r"reply(?: with exactly)?:\s*(\S+)", last, re.I)
    if exact:
        reply = exact.group(1).rstrip(".")
    nap = re.search(r"\bsleep (\d+)", last)
    if slow:
        reply += " " + "lorem ipsum " * 30 + "SLOW-END"
    return {"kind": "text", "text": reply, "chunk": 8, "slow": slow, "latency": True,
            "nap": int(nap.group(1)) if nap else 0}


def tool_plan(body, ui):
    msgs = body["messages"]
    spec = msgs[ui]["content"][len("tool:"):].strip()
    step = sum(1 for m in msgs[ui + 1:] if m["role"] == "assistant" and m.get("tool_calls"))
    if spec == "forever":
        calls = [["bash", {"command": "echo loop >> loop.txt"}]]
    else:
        script = json.loads(spec)
        calls = script[step] if step < len(script) else None
    if calls is None:
        last_tool = next((m["content"] for m in reversed(msgs) if m["role"] == "tool"), "")
        n_tools = len(body.get("tools") or [])
        k = sum(1 for m in msgs if m["role"] == "tool")
        pruned = sum(1 for m in msgs if m["role"] == "tool" and m["content"].startswith("[old tool output pruned"))
        reply = f"TOOL-FINAL: {last_tool} [tools declared: {n_tools}] [tool msgs in history: {k}] [pruned: {pruned}]"
        return {"kind": "text", "text": reply, "chunk": 64}
    return {"kind": "tools", "text": f"step {step}.",
            "calls": [(f"call_{step}_{j}", n, json.dumps(a)) for j, (n, a) in enumerate(calls)]}


def a2o(body):
    """Anthropic request -> the OpenAI-shaped body the reply logic reads."""
    msgs = []
    system = body.get("system")
    if isinstance(system, list):
        system = "".join(b.get("text", "") for b in system)
    if system:
        msgs.append({"role": "system", "content": system})
    for m in body["messages"]:
        blocks = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
        if m["role"] == "user":
            for b in blocks:
                if b["type"] == "tool_result":
                    c = b.get("content", "")
                    if isinstance(c, list):
                        c = "".join(x.get("text", "") for x in c)
                    msgs.append({"role": "tool", "tool_call_id": b["tool_use_id"], "content": c})
                elif b["type"] == "text":
                    msgs.append({"role": "user", "content": b["text"]})
        else:
            text = "".join(b["text"] for b in blocks if b["type"] == "text")
            calls = [{"id": b["id"], "type": "function", "function": {"name": b["name"], "arguments": json.dumps(b["input"])}}
                     for b in blocks if b["type"] == "tool_use"]
            o = {"role": "assistant", "content": text or None}
            if calls:
                o["tool_calls"] = calls
            msgs.append(o)
    out = {"model": body.get("model"), "messages": msgs, "stream": body.get("stream", False)}
    if body.get("tools"):
        out["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""),
                                                          "parameters": t["input_schema"]}} for t in body["tools"]]
    return out


def validate(body, headers):
    errs = []
    key, auth = headers.get("x-api-key"), headers.get("Authorization") or ""
    if not key:
        errs.append("x-api-key header missing")
    if auth != f"Bearer {key}":
        errs.append("Authorization: Bearer <same key> missing")
    if not headers.get("anthropic-version"):
        errs.append("anthropic-version header missing")
    if not isinstance(body.get("max_tokens"), int) or body["max_tokens"] < 1:
        errs.append("max_tokens: required positive integer")
    msgs = body.get("messages") or []
    if not msgs or msgs[0].get("role") != "user":
        errs.append("messages: first message must use the user role")
    pending, any_tool = None, False
    for i, m in enumerate(msgs):
        role = m.get("role")
        if role not in ("user", "assistant"):
            errs.append(f"messages.{i}.role: {role!r} not allowed")
            continue
        if i and msgs[i - 1].get("role") == role:
            errs.append(f"messages.{i}: roles must alternate")
        blocks = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
        if not blocks:
            errs.append(f"messages.{i}: empty content")
        for b in blocks:
            if b.get("type") == "text" and not str(b.get("text", "")).strip():
                errs.append(f"messages.{i}: text content blocks must contain non-whitespace text")
        results = [b for b in blocks if b.get("type") == "tool_result"]
        uses = [b for b in blocks if b.get("type") == "tool_use"]
        any_tool |= bool(results or uses)
        if role == "user":
            if pending is not None:
                if sorted(b["tool_use_id"] for b in results) != sorted(pending):
                    errs.append(f"messages.{i}: tool_use ids {pending} need tool_result blocks")
                if blocks[:len(results)] != results:
                    errs.append(f"messages.{i}: tool_result blocks must come first")
            elif results:
                errs.append(f"messages.{i}: tool_result without a preceding tool_use")
            pending = None
        else:
            if results:
                errs.append(f"messages.{i}: tool_result in an assistant turn")
            for b in uses:
                if not TOOL_ID.match(b.get("id", "")) or not isinstance(b.get("input"), dict):
                    errs.append(f"messages.{i}: bad tool_use {b}")
            pending = [b["id"] for b in uses] or None
    if pending:
        errs.append("last assistant tool_use has no tool_result")
    if any_tool and not body.get("tools"):
        errs.append("requests with tool_use/tool_result blocks must define tools")
    for t in body.get("tools") or []:
        if not t.get("name") or not isinstance(t.get("input_schema"), dict) or "function" in t:
            errs.append(f"bad tool definition {str(t)[:80]}")
    return errs


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/calls":
            self.send_error(404); return
        self.json(200, CALLS)

    def json(self, code, obj):
        out = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.endswith("/v1/messages"):
            return self.anthropic(body)
        if not self.path.endswith("/chat/completions"):
            self.send_error(404); return
        p = plan(body)
        if p["kind"] == "summary":
            CALLS["summary"] += 1
            CALLS["summary_with_tools"] += bool(body.get("tools"))
            return self.json(200, {"choices": [{"message": {"role": "assistant", "content": p["text"]}}]})
        CALLS["chat"] += 1
        stream = body.get("stream")
        if p["kind"] == "text":
            if not stream:
                return self.json(200, {"choices": [{"message": {"role": "assistant", "content": p["text"]}}]})
            chunks = [{"content": p["text"][i:i + p["chunk"]]} for i in range(0, len(p["text"]), p["chunk"])]
        else:
            tcs = [{"id": cid, "type": "function", "function": {"name": n, "arguments": a}} for cid, n, a in p["calls"]]
            if not stream:
                return self.json(200, {"choices": [{"message": {"role": "assistant", "content": p["text"], "tool_calls": tcs},
                                                    "finish_reason": "tool_calls"}]})
            chunks = [{"content": p["text"]}] if p["text"] else []
            for j, tc in enumerate(tcs):
                args = tc["function"]["arguments"]; h = len(args) // 2
                chunks.append({"tool_calls": [{"index": j, "id": tc["id"], "type": "function",
                                               "function": {"name": tc["function"]["name"], "arguments": args[:h]}}]})
                chunks.append({"tool_calls": [{"index": j, "function": {"arguments": args[h:]}}]})
        frames = [f"data: {json.dumps({'choices': [{'index': 0, 'delta': d}]})}\n\n" for d in chunks]
        self.stream(p, frames + ["data: [DONE]\n\n"], range(len(frames)))

    def stream(self, p, frames, paced):
        """Writes SSE frames; in slow mode each frame index in `paced` is followed by 0.2s."""
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        try:
            if p.get("latency"):
                time.sleep(float(os.environ.get("MOCK_LATENCY", "0")))
            time.sleep(p.get("nap", 0))
            for i, f in enumerate(frames):
                self.wfile.write(f.encode()); self.wfile.flush()
                if p.get("slow") and i in paced: time.sleep(0.2)
        except (BrokenPipeError, ConnectionResetError):
            CALLS["disconnects"] += 1
            print("mock: client disconnected mid-stream", file=sys.stderr)

    def anthropic(self, body):
        key = self.headers.get("x-api-key")
        if key == "mock-401":
            return self.json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        if key == "mock-429":
            return self.json(429, {"error": {"code": "1113", "message": "Insufficient balance or no resource package. Please recharge."}})
        errs = validate(body, self.headers)
        if errs:
            CALLS["a_rejected"] += 1
            print("mock: anthropic request rejected: " + "; ".join(errs), file=sys.stderr)
            return self.json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "; ".join(errs)}})
        CALLS["a_max_tokens"] = body["max_tokens"]
        p = plan(a2o(body))
        msg = {"id": "msg_mock", "type": "message", "role": "assistant", "model": body.get("model"),
               "stop_sequence": None, "usage": {"input_tokens": len(json.dumps(body)) // 4, "output_tokens": 1}}
        if p["kind"] == "summary":
            CALLS["a_summary"] += 1
            CALLS["a_summary_with_tools"] += bool(body.get("tools"))
            return self.json(200, {**msg, "content": [{"type": "text", "text": p["text"]}], "stop_reason": "end_turn"})
        CALLS["a_chat"] += 1
        if p["kind"] == "text":
            content, stop = [{"type": "text", "text": p["text"]}], "end_turn"
        else:
            content = [{"type": "text", "text": p["text"]}] if p["text"] else []
            content += [{"type": "tool_use", "id": f"toolu_01Mock{cid.replace('_', '')}", "name": n, "input": json.loads(a)}
                        for cid, n, a in p["calls"]]
            stop = "tool_use"
        if not body.get("stream"):
            return self.json(200, {**msg, "content": content, "stop_reason": stop})
        ev = lambda t, d: f"event: {t}\ndata: {json.dumps({'type': t, **d})}\n\n"
        frames = [ev("message_start", {"message": {**msg, "content": [], "stop_reason": None}}), ev("ping", {})]
        paced = range(0)
        for i, b in enumerate(content):
            if b["type"] == "text":
                frames.append(ev("content_block_start", {"index": i, "content_block": {"type": "text", "text": ""}}))
                step = p.get("chunk", 64)
                deltas = [ev("content_block_delta", {"index": i, "delta": {"type": "text_delta", "text": b["text"][k:k + step]}})
                          for k in range(0, len(b["text"]), step)]
                paced = range(len(frames), len(frames) + len(deltas))
                frames += deltas
            else:
                args = json.dumps(b["input"]); h = len(args) // 2
                frames.append(ev("content_block_start", {"index": i, "content_block": {**b, "input": {}}}))
                frames += [ev("content_block_delta", {"index": i, "delta": {"type": "input_json_delta", "partial_json": s}})
                           for s in (args[:h], args[h:])]
            frames.append(ev("content_block_stop", {"index": i}))
        frames += [ev("message_delta", {"delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 1}}),
                   ev("message_stop", {})]
        self.stream(p, frames, paced)  # slow mode paces the text deltas


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 18080), H).serve_forever()
