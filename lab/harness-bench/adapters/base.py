"""Harness adapter interface — the point of harness-bench.

A harness adapter exposes THREE callables. Future roots = one new file, zero suite changes:

    class MyRoot(Harness):
        NAME = "myroot"
        def create_session(self) -> str: ...          # -> session id
        def send(self, sid, text) -> str: ...          # -> full reply text (blocking)
        def stream_first_byte_ms(self, text) -> int: ...  # -> TTFB of a fresh session, ms

Contract:
  - send() must return the assistant's visible text (no tool chatter, no reasoning).
  - stream_first_byte_ms() opens a NEW session, sends `text`, returns ms until the first
    reply byte arrives on the wire, then discards the session. It must not poison `sid`.
  - Adapters never mutate existing sessions they did not create.
  - All HTTP stays on loopback. No auth on either v1 harness.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod

UA = "harness-bench/1.0"


def http(method: str, url: str, body: dict | None = None, headers: dict | None = None,
         timeout: float = 180.0):
    """One request. Returns (status, headers, bytes). No retries — benchmarks measure truth."""
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json", "user-agent": UA}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:  # non-2xx is data, not an adapter crash
        return e.code, dict(e.headers), e.read()


def sse_post(url: str, body: dict, timeout: float = 300.0):
    """POST with Accept: text/event-stream; yields (event_name, data_dict, ttfb_ms_so_far)."""
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json",
                                          "accept": "text/event-stream", "user-agent": UA},
                                 method="POST")
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        event, data = None, None
        for raw in r:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                chunk = line[5:].strip()
                try:
                    data = json.loads(chunk) if chunk else None
                except ValueError:
                    data = {"raw": chunk}
                yield event, data, round((time.perf_counter() - t0) * 1000)
                event, data = None, None


class Harness(ABC):
    NAME: str = "?"

    @abstractmethod
    def create_session(self) -> str: ...

    @abstractmethod
    def send(self, sid: str, text: str) -> str: ...

    @abstractmethod
    def stream_first_byte_ms(self, text: str) -> int: ...
