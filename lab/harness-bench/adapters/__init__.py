"""harness-bench adapters — one module per harness, one shared interface (base.Harness)."""
from .base import Harness, http, sse_post
from .yggdrasil import Yggdrasil
from .opencode import OpenCode
from .yggdrasil_scratch import YggdrasilScratch

REGISTRY = {h.NAME: h for h in (Yggdrasil, OpenCode, YggdrasilScratch)}

__all__ = ["Harness", "http", "sse_post", "REGISTRY", "Yggdrasil", "OpenCode", "YggdrasilScratch"]
