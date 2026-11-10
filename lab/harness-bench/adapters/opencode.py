"""Adapter for opencode (reference rival, READ-ONLY store) — http://127.0.0.1:4096.

Verified probe (28 Oct): POST /session works and does not disturb existing sessions;
POST /session/{id}/message BLOCKS and returns the final assistant message as JSON
({info, parts}). No per-request SSE — TTFB comes from the global event bus on
GET /event (server-sent), filtering message.part.updated deltas for the session.
Sessions created by the adapter are deleted afterwards (opencode supports DELETE).
"""
from __future__ import annotations

import json
import threading
import time
import urllib.request
from .base import Harness, http

BASE = "http://127.0.0.1:4096"
UA = "harness-bench/1.0"


class OpenCode(Harness):
    NAME = "opencode"

    def create_session(self) -> str:
        st, _, body = http("POST", f"{BASE}/session", body={"title": "[LAB] harness-bench"})
        if st not in (200, 201):
            raise RuntimeError(f"opencode create_session: HTTP {st}: {body[:200]!r}")
        return json.loads(body)["id"]

    def send(self, sid: str, text: str) -> str:
        st, _, body = http("POST", f"{BASE}/session/{sid}/message", timeout=300.0,
                           body={"parts": [{"type": "text", "text": text}]})
        if st != 200:
            raise RuntimeError(f"opencode send: HTTP {st}: {body[:300]!r}")
        v = json.loads(body)
        return "".join(p.get("text", "") for p in v.get("parts", [])
                       if isinstance(p, dict) and p.get("type") == "text")

    def stream_first_byte_ms(self, text: str) -> int:
        sid_holder: dict = {}
        first_byte: dict = {}
        stop = threading.Event()
        bus = urllib.request.Request(f"{BASE}/event",
                                     headers={"accept": "text/event-stream", "user-agent": UA})

        def listen():
            try:
                with urllib.request.urlopen(bus, timeout=120) as r:
                    for raw in r:
                        if stop.is_set():
                            return
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            v = json.loads(line[5:].strip())
                        except ValueError:
                            continue
                        props = v.get("properties") or {}
                        if props.get("sessionID") != sid_holder.get("sid"):
                            continue
                        # delta shape: {"type":"message.part.delta",
                        #               properties:{field:"text", delta:"The"}}
                        if v.get("type") == "message.part.delta" and props.get("field") == "text" \
                                and props.get("delta"):
                            first_byte["ms"] = round(
                                (time.perf_counter() - t0_holder["t0"]) * 1000)
                            stop.set()
                            return
            except Exception:
                pass  # bus ended or timed out — main flow reports -1

        t0_holder: dict = {}
        t = threading.Thread(target=listen, daemon=True)
        t.start()
        time.sleep(0.4)  # let the bus subscription land server-side
        t0 = time.perf_counter()
        t0_holder["t0"] = t0
        sid = self.create_session()
        sid_holder["sid"] = sid
        try:
            http("POST", f"{BASE}/session/{sid}/message", timeout=300.0,
                 body={"parts": [{"type": "text", "text": text}]})
            t.join(timeout=5)
            return first_byte.get("ms", -1)
        finally:
            stop.set()
            http("DELETE", f"{BASE}/session/{sid}")
