# line: latency-clocktail-terse
fork: time-awareness-cap-slice @ dfda8dcf (2026-11-08, session LAT-FIX-R1)
purpose: [RUN] latency round 1 per artifacts/latency-fix-round1.md brief — (1) clock header
from position-0 system → tail of the message array (INSIDE the last user turn; convert()
hoists system roles into the top-level system string, so a tail system message still
breaks the provider prefix-cache), with a fully static SYSTEM_PREAMBLE at position 0;
prior turns' headers reconstructed byte-stably from stored timestamps so turn-2 requests
stay append-only → provider cache.read > 0; (2) LAT log landed in the brain working tree
(already code-ready from dfda8dcf) — deployed at the next standard brain deploy, NOT
restarted now; (3) terse one-liner in the static preamble (answers 2-4× longer than the
v0.6-Mac path on identical prompts).
known missing: NONE — fork at lane HEAD dfda8dcf (release binary 10-06 = stale; rebuilt on
this branch for the GAP-0 stage proof).
