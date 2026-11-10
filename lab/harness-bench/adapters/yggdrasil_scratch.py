"""Adapter for a SCRATCH yggdrasil root (TOOL-SCOPE, 10-28) — never the live :4100.

Same API as `yggdrasil.py`; the base comes from HB_YGG_BASE (default 127.0.0.1:4121) and
HB_YGG_PROFILE (optional) selects the session tool profile at POST /session. HB_YGG_TOOLLOG
(optional path) appends one JSON line per session with the tool names the model called and
how many calls the profile denied — the surface-familiarity lab's raw signal.
"""
from __future__ import annotations

import json
import os
from .base import Harness, http, sse_post

BASE = os.environ.get("HB_YGG_BASE", "http://127.0.0.1:4121")
PROFILE = os.environ.get("HB_YGG_PROFILE") or None
TOOLLOG = os.environ.get("HB_YGG_TOOLLOG") or None

if BASE.rstrip("/").endswith(":4100"):
    raise SystemExit("yggdrasil-scratch refuses the live root (:4100); use the `yggdrasil` adapter")


class YggdrasilScratch(Harness):
    NAME = "yggdrasil-scratch"

    def create_session(self) -> str:
        body = {"title": "[LAB] harness-bench (scratch)"}
        if PROFILE:
            body["profile"] = PROFILE
        st, _, raw = http("POST", f"{BASE}/session", body=body)
        if st != 200:
            raise RuntimeError(f"yggdrasil-scratch create_session: HTTP {st}: {raw[:200]!r}")
        return json.loads(raw)["id"]

    def send(self, sid: str, text: str) -> str:
        parts, final, calls = [], None, []
        for event, data, _ in sse_post(f"{BASE}/session/{sid}/message",
                                       body={"parts": [{"type": "text", "text": text}]}):
            if event == "message.part.delta" and isinstance(data, dict) and data.get("text"):
                parts.append(data["text"])
            elif event == "message.part.updated" and isinstance(data, dict):
                p = data.get("part") or {}
                st = (p.get("state") or {})
                if p.get("type") == "tool" and st.get("status") in ("completed", "error"):
                    calls.append({"tool": p.get("tool"), "status": st.get("status"),
                                  "denied": bool((st.get("metadata") or {}).get("denied")),
                                  "unknown": str(st.get("output", "")).startswith("unknown tool")})
            elif event == "message.completed":
                final = data
        if TOOLLOG:
            with open(TOOLLOG, "a") as f:
                f.write(json.dumps({"sid": sid, "profile": PROFILE, "prompt": text[:80], "calls": calls}) + "\n")
        if final:
            try:
                msgs = final.get("info", {}).get("parts") or final.get("parts") or []
                out = "".join(p.get("text", "") for p in msgs if isinstance(p, dict) and p.get("type") == "text")
                if out.strip():
                    return out
            except (AttributeError, TypeError):
                pass
        return "".join(parts)

    def stream_first_byte_ms(self, text: str) -> int:
        sid = self.create_session()
        try:
            for event, data, ttfb in sse_post(f"{BASE}/session/{sid}/message",
                                              body={"parts": [{"type": "text", "text": text}]}):
                if event == "message.part.delta" and isinstance(data, dict) and data.get("text"):
                    return ttfb
            return -1
        finally:
            http("DELETE", f"{BASE}/session/{sid}")
