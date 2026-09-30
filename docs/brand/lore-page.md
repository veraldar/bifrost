# Lore page — draft copy for the landing page

*BRAND session, 2026-09-30; corrected same day — Veraldar is the brand,
Bifrost is its first product. Ready-to-paste copy for the LAUNCH session.
Target: `/lore`, linked from the landing footer as "lore". Style rules:
`brand.md` (prose capitals; Midgard/Asgard allowed on this page only; terse,
honest, terminal-native). Backdrop note for the builder: per `visual.md` —
dim it or drop it on prose sections.*

---

## The lore

the names are old. the code is new.

**Veraldar** — old norse, "the world". the brand, and the org behind it. we
build self-hosted tools you own outright, name them from the old myths, and
release everything AGPL-3.0, free for everyone. the world holds everything
else on this page.

**Yggdrasil** — the world tree. your box. one trunk that hosts everything:
the agent, the speech models, the services. the mark draws the tree as
circuit traces, because that's what it is.

**Bifrost** — our first product. a bridge. in the myths it connects midgard,
where humans live, to asgard, where the gods work. here: midgard is your
phone in your pocket; asgard is your box with your keys, and the agent
working on it. you talk across the bridge; the work stays on the tree.

in the myths, bifrost shatters at ragnarök. ours won't — but we'll still tell
you every limit up front. a bridge you can't trust isn't a bridge.

```
veraldar — the world
  yggdrasil — the tree: hosts
  bifrost   — the bridge: a veraldar product
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
