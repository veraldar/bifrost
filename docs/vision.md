# Vision — one phone, many bridges, one network, many trees

Raised 09-30/10-01 (user), reviewed by veraldar main. This is the product
north star; features below trace to it.

## The structure

```
        one phone
      ┌───────────┐
      │ Bifrost   │  one PWA — swipe between as many bridges as you want
      └─────┬─────┘
   roots:   │   one private network (Tailscale, or its open twin Headscale)
      ┌─────┴──────────────┬──────────────────┐
      ▼                    ▼                  ▼
  Yggdrasil PC          Yggdrasil PC       Yggdrasil PC
  (by the TV:           (game creation)    (building a company)
   "play the movie")     agent core         agent core
   agent core
```

- **Veraldar** = the world (the organisation)
- **Yggdrasil** = the tree = the agent core on each PC (opencode today; a
  Rust-optimized one-click build is the evidence-triggered evolution — the
  shelved bifrostd idea, properly named)
- **Bifrost** = the bridge = this PWA, one per connection, many per phone
- **Tailscale/WebRTC** = the roots and rivers (private networking + media)

## Review verdict (veraldar main)

Agreed — and it is ~80% true today: the PWA + opencode + bootstrap already
deliver "one-click agent core on any PC" and "talk to your code from the
phone". The genuinely NEW engineering piece is the **instance switcher**:
one PWA holding several backends (per-PC identity, swipe to change tree).
That is a real feature candidate — spec before building.

## Commitments traced to this vision

1. Instance switcher (multi-backend PWA) — feature candidate, needs spec
2. Tailscale elevated to a named pillar — research session on trust +
   open alternatives (Headscale/Netbird) in flight
3. Yggdrasil naming for the agent core — brand-level now, engineering stays
   evidence-triggered
4. The story told everywhere — brand session weaving it into lore, website,
   and the narration for a future report/design/movie
5. "What AI can simulate, AI can create." — manifesto line, brand book
