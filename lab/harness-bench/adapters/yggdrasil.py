"""Adapter for yggdrasil (the world tree) — http://127.0.0.1:4100.

API: POST /session -> {id}; POST /session/{id}/message with Accept: text/event-stream
streams `message.part.delta` events and ends with `message.completed`.
"""
from __future__ import annotations

import json
from .base import Harness, http, sse_post

BASE = "http://127.0.0.1:4100"


class Yggdrasil(Harness):
    NAME = "yggdrasil"

    def create_session(self) -> str:
        st, _, body = http("POST", f"{BASE}/session", body={"title": "[LAB] harness-bench"})
        if st != 200:
            raise RuntimeError(f"yggdrasil create_session: HTTP {st}: {body[:200]!r}")
        return json.loads(body)["id"]

    def send(self, sid: str, text: str) -> str:
        """Consume the SSE relay; concatenate delta text; fall back to completed message."""
        parts, final = [], None
        for event, data, _ in sse_post(f"{BASE}/session/{sid}/message",
                                       body={"parts": [{"type": "text", "text": text}]}):
            if event == "message.part.delta" and isinstance(data, dict) and data.get("text"):
                parts.append(data["text"])
            elif event == "message.completed":
                final = data
        if final:  # prefer the authoritative stored message
            try:
                msgs = final.get("info", {}).get("parts") or final.get("parts") or []
                text = "".join(p.get("text", "") for p in msgs if isinstance(p, dict)
                               and p.get("type") == "text")
                if text.strip():
                    return text
            except (AttributeError, TypeError):
                pass
        return "".join(parts)

    def stream_first_byte_ms(self, text: str) -> int:
        sid = self.create_session()
        try:
            for event, data, ttfb in sse_post(f"{BASE}/session/{sid}/message",
                                              body={"parts": [{"type": "text", "text": text}]}):
                if event == "message.part.delta" and isinstance(data, dict) and data.get("text"):
                    return ttfb  # first reply byte on the wire
            return -1
        finally:
            http("DELETE", f"{BASE}/session/{sid}")
