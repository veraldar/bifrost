# Lore page — draft copy for the landing page

*BRAND session, 2026-09-30; corrected same day — Veraldar is the brand,
Bifrost is its first product. Ready-to-paste copy for the LAUNCH session.
Target: `/lore`, linked from the landing footer as "lore". Style rules:
`brand.md` (prose capitals; Midgard/Asgard allowed on this page only; terse,
honest, terminal-native). Backdrop note for the builder: per `visual.md` —
dim it or drop it on prose sections.*
*10-30: rewritten to `docs/CONSTRUCT.md` (binding) — root = the brain, trunk
= the private line, branch = the app. The 09-30 map (roots = the private
network) is dead; Midgard/Asgard remain lore-only garnish.*

---

## The lore

> What AI can simulate, AI can create.

the names are old. the code is new.

**Veraldar** — old norse, "the world". the organization. it holds the
products, and products can be anything — hardware or software. we build
self-hosted tools you own outright, name them from the old myths, and
release everything AGPL-3.0, free for everyone.

**Yggdrasil** — a veraldar product: the tree. one per machine. it contains
three parts. **root** — the brain: thinks, remembers; installable on any
computer. **trunk** — the private line between the roots and you; tailscale
today, webrtc next, wireguard after. **branch** — the app in your hand.

**Bifrost** — the branch of the tree; a veraldar product. in the myths the
bridge connects midgard, where humans live, to asgard, where the gods work.
here: the bridge is the app that reaches your tree — your machine, your
keys, the agent working on it. you talk across the branch; the work stays
on the tree.

one phone. one tree. one private line. the machine by the tv turns on
movies. the machine at the desk creates games. the machine in the rack
builds a company. one phone drives them all.

in the myths, bifrost shatters at ragnarök. ours won't — but we'll still tell
you every limit up front. a bridge you can't trust isn't a bridge.

```
veraldar              the world: the org — holds the products
└── yggdrasil         one product: the tree
    ├── root          the brain: thinks, remembers
    ├── trunk         the private line: carries — tailscale → webrtc → wireguard
    └── branch        the app in your hand: bifrost
```

that's the whole map. no mythology in the code — just names that say what a
thing is.

Bifrost is a Veraldar product. AGPL-3.0. free for everyone. your hardware,
your words.

---

### Builder notes (not page copy)

- Render name paragraphs with the bold name in Commit Mono, `--oz-text`; body
  in `--oz-dim`.
- The ASCII diagram goes in a `pre` on `--oz-surface` with 1px `--oz-border`.
- If the page needs a brand block separate from the product, the closing line
  is the pattern: "Bifrost is a Veraldar product. AGPL-3.0. Free for
  everyone." (Part 2 of `brand.md` — attribution phrases are fixed.)
- Do not add rainbow/gradient anything. No emoji. No exclamation marks.
- Keep the page under ~40 lines rendered; lore, not a novel.
