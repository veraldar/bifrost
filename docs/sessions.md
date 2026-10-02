# Session fleet & routing (veraldar main = coordinator)

The user talks to **veraldar main** (this product session). Off-topic input
gets **re-sent verbatim to the correct session**, not answered here.

| Topic | Session | Route |
|---|---|---|
| product, releases, bugs, roadmap, priorities | veraldar main (here) | stays |
| brand, design, identity, themes | veraldar brand | forward |
| channels, YouTube, Reddit, X, merch, posts | veraldar comms | forward |
| the launch moment, announcements | bifrost launch | forward |
| website build/veraldar.org | veraldar org website | forward |
| legal, org, donations, governance | bifrost org (dormant) | forward |
| android emulator lab, device testing | bifrost android-lab | forward |

Rules: forward the user's message essentially verbatim (context they have,
the target session lacks — prepend one routing line if needed); product
session keeps coordination + release gates; report back to the user what was
forwarded and where.
