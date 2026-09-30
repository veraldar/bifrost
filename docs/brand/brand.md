# Veraldar brand book

*BRAND session, 2026-09-30; corrected same day — Veraldar is the brand,
Bifrost is one product under it. This file is the identity source of truth.*

## Handoff — read this first

Part 1 is the brand system every Veraldar product inherits unchanged. Part 2
is how products plug into the brand. Any future model/session: work inside
this structure; don't fork Part 1 per product.

| File | Part | What | Status |
|---|---|---|---|
| `docs/brand/brand.md` | 1 + 2 | lore, voice, word list, do/dont + namespacing | done — this file |
| `docs/brand/tokens.md` | 1 | color/type/space/motion system | done |
| `docs/brand/visual.md` | 1 | mark, iconography, backdrop direction | done |
| `docs/brand/lore-page.md` | copy | landing lore draft for LAUNCH | drafted |

Coordination contract:

- **LAUNCH session** owns `docs/launch/*` and the landing page. It reads this
  dir; we never edit their files. This book wins on voice and naming;
  `docs/launch/positioning.md` wins on launch-specific claims and gates.
- **Token values** live upstream: veraldar-theme (W3C DTCG source) →
  `scripts/build.sh` → `pwa/styles/tokens.css` (generated — never edit).
  Bifrost is the first shipper, not the owner. See `tokens.md`.

---

# Part 1 — the Veraldar brand system

## 1. The lore

Veraldar is the brand: an organisation that builds self-hosted tools people
own outright. Its products take Norse names — but the myth is a naming map,
not decoration. Every name must say what the thing *is*.

```
veraldar — the world (the org; the brand; everything lives inside it)
  yggdrasil — the tree (your box; the trunk everything runs on)
  bifrost   — the bridge (a product: phone ⇄ voice ⇄ box)
```

- **Veraldar** — Old Norse, "the world". The organisation and its brand. The
  world contains the tree and everything built on it. When we speak with one
  voice — READMEs, landing pages, releases — it is Veraldar speaking.
- **Yggdrasil** — the world tree, the ash that holds the nine worlds. Your
  box: the one trunk that hosts the agent, the speech models, the services.
  The circuit-tree mark (`pwa/public/yggdrasil_final.svg` — tree drawn as
  circuit traces) is the Veraldar brand image: hardware and myth, one drawing.
- **Bifrost** — the first product: the bridge between Midgard (where you are:
  a phone in a pocket) and Asgard (where the agent works: your box, your keys).
  In the myths the bridge shatters at Ragnarök. Ours won't — but we still
  state every limit up front, because a bridge you can't trust isn't a bridge.

Rules of the lore:

1. **The myth is a map.** We never sell mythology; we sell ownership of *your*
   tools on *your* hardware. Names only explain relationships.
2. **Future products are future Norse names** (see Part 2), each with a
   one-line meaning written down before any code ships under it.
3. **Midgard/Asgard are lore-copy only** — landing lore pages and prose that
   explains the architecture metaphor. Never in UI, errors, or behavior docs.

## 2. Tone of voice

Three words: **terse, honest, terminal-native.**

- **Terse.** Every word pays rent. Fragments beat sentences. If a line reads
  fine without an adjective, delete the adjective.
- **Honest.** Limits are stated unprompted, in the same breath as the claim.
  Never bury a caveat.
- **Terminal-native.** Write like the CLI: lowercase commands, exact paths,
  exact durations. Concrete verbs — talk, type, run, paste, clone. Second
  person: *your box, your keys, your words*.

Never say: "revolutionary", "seamless", "AI-powered", "magic", "empower",
"cutting-edge", "enterprise-grade", "blazing fast", "game-changing". No
exclamation marks in brand copy. No emoji in brand copy. At most one
descriptor per noun ("voice-first", "self-hosted" — used once, not stacked).

Always: name the license (AGPL-3.0, free for everyone), name the hardware
requirement, name the manual steps. Honesty is the differentiator — the big
dogs can't copy it.

## 3. The word list

Two registers, one rule:

- **Prose register:** names are proper nouns — **Veraldar**, **Bifrost**,
  **Yggdrasil** — capitalized in sentences and headlines.
- **Code register:** commands, packages, repo slugs stay lowercase —
  `bifrost`, `veraldar/bifrost`, `yggdrasil-bifrost` (legacy slug). Display
  wordmarks use the lowercase mono treatment (see `visual.md`); that is
  display, not prose.

| Term | Write it | Notes |
|---|---|---|
| the brand / org | **Veraldar** | the world; one voice across products |
| the tree | **Yggdrasil** | your box; lowercase only in slugs |
| product #1 | **Bifrost** (prose) / `bifrost` (code) | the bridge |
| attribution | **a Veraldar product** | the canonical phrase — see Part 2 |
| the agent | **the agent** | never "the AI", never "our model" |
| your machine | **your box** | never "server infrastructure" |
| one exchange | **turn** | one voice (or typed) input + the agent's answer |
| a conversation | **session** | never "chat", never "conversation" |
| the live connection | **room** | LiveKit room; technical term |
| hold-to-talk | **PTT** / **push-to-talk** | spell out once, then PTT |
| always-listening | **hands-free** | two words, lowercase |
| typing mode | **keyboard mode** | |
| linking phone | **pairing** | "paste one link, say 'set it up'" |
| network stance | **tailnet-private** | "tailnet-only, nothing public" |
| license | **AGPL-3.0** | always named; "free for everyone" |
| speech | **local speech models** | MLX Qwen3 / speaches when specifics help |

Forbidden phrasing: "our AI", "we trained", "smart", "intelligent",
"assistant", "copilot" (someone else's brand), "just" ("just paste a link" —
nothing is just; say what it actually takes).

## 4. Do / don't

Hero (product):

- DON'T: 🚀 "Bifrost — Revolutionary AI-Powered Voice Control for Your Coding Workflow!"
- DO: `bifrost — talk to your coding agent from your phone.`

Attribution (brand):

- DON'T: "Bifrost™ by Veraldar Labs — part of the Veraldar™ suite of solutions."
- DO: "bifrost — a Veraldar product."

Explaining the pitch:

- DON'T: "Seamlessly empower your development cycle with enterprise-grade AI integration."
- DO: "Paste one link, say 'set it up'. One manual step: `opencode auth login` — your key; nothing mints that for you."

Privacy:

- DON'T: "Our cutting-edge local AI guarantees complete privacy."
- DO: "Speech runs local (MLX Qwen3 / speaches). Your LLM key is yours to choose. Tailnet-only; nothing public."

The lore:

- DON'T: "Veraldar ecosystem leverages Yggdrasil infrastructure synergies."
- DO: "The tree hosts. The bridge connects."

Error / status copy (UI voice: lowercase fragments, exact facts):

- DON'T: "Oops! Something went wrong 😅 Please try again later."
- DO: `still connecting — poll took 22s, retrying`

Release notes:

- DON'T: "v0.4.0 — our biggest update yet, packed with features!"
- DO: "v0.4.0 — hands-free: auto-listen speaks once per turn; mic is liveness-aware. PTT remains the battle-tested mode."

Honest limits (the brand move competitors can't make):

- DON'T: hide the install friction, imply one-click.
- DO: "v0.4.0 is the enthusiast release: one Linux box, Docker, Node ≥ 22, your own LLM key. If that's not you yet, star it and come back."

---

# Part 2 — product namespacing

## The rule

**One brand, many products.** Veraldar owns the identity (Part 1: lore, voice,
tokens, iconography, backdrops, motion). Products are namespaced under it and
inherit all of it unchanged. A product earns one thing: its name, and the one
line that says what it is.

## GitHub and repos

- Org: **`veraldar`** (lowercase). Repos: `veraldar/<product>`.
- Repo slugs are the bare product name, lowercase, hyphenated if multiword:
  `veraldar/bifrost`. No family prefixes (`veraldar-product-bifrost` — never).
- Shared infrastructure repos follow the same pattern: `veraldar/theme`
  (the DTCG source), `veraldar/brand` (this book, if split out).
- Migration note: the current repo `yggdrasil-bifrost` predates the rule.
  Rename to `veraldar/bifrost` when the org lands; keep the old slug as a
  GitHub redirect; no doc rewrites before then.

## Attribution patterns

Canonical phrases, pick by context:

- Subtitle/footer under a product name: **"a Veraldar product."**
- Prose attribution: **"Bifrost is a Veraldar product."**
- Cross-product ("built by the same people"): **"from Veraldar."**
- License line, always attached: **"AGPL-3.0. Free for everyone."**

Never: "Veraldar's Bifrost™", "a Veraldar solution", "the Veraldar family of
products", "powered by Veraldar". No ™, no suite-language, no "ecosystem"
as a noun of self-praise.

## Naming a future product

1. Find a Norse name whose meaning **is** the product's job, in one line.
   Bifrost = bridge → the product is a bridge. If the one line needs "kind
   of" or "sort of like", the name is wrong.
2. Write the one line here before shipping anything under the name:

   | Product | Name means | One line |
   |---|---|---|
   | Bifrost | the bridge between worlds | talk to your agent from your phone |
   | *(next)* | | |

3. Check the name against Part 1: passes tone rules, no trademark collision,
   reads as lowercase slug without ugly ambiguity.
4. Names are never reused, and a product's name never changes its meaning
   line — if the product pivots, it earns a new name.

## What products may not change

Part 1 is inherited, not forked: tone of voice, word-list rules, the ten
`--oz-*` roles, type, motion vocabulary, icon family, backdrop rules, license
stance. A product may choose its **default theme** from the shipped set and
may propose new themes upstream (via the DTCG source) — it may not restyle
locally. Brand-level art (the circuit-tree mark, backdrops) is shared; a
product's own visuals are variations inside those rules, not new systems.
