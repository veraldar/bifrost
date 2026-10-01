# Design review — for the user's personal pass

*BRAND session, 2026-09-30, revised for brief v2 (freedom-first). Two parts:
Part 1 chooses a direction among three propositions (cheap, gut-driven).
Part 2 is the ship gate after the chosen direction is built (one cycle, then
launch). Anything unchecked in part 2 is a blocker.*

## Part 1 — choosing a direction (phase 1 review)

Open the three `design-*-<name>.html` artifacts cold, phone in hand. For each,
answer in one word:

1. Does it feel like **the world tree's product** — Nordic, minimal, alive?
2. Does it feel like a **terminal in your pocket**, not a chat app with dark mode?
3. Could you show it to a friend without apologizing for anything?

Then the three discriminators:

- **Pixel or geometry?** Which direction answered the pixel-art question the way you actually feel?
- **Palettes.** Same three palettes in all three — did any direction use them better than you expected?
- **The tree.** In which direction does the tree feel most like the core (and least like wallpaper)?
- **Does anything try to keep you?** Guilt on exit, cuteness at a consent moment, a mascot performing for attention — any of those disqualify a direction (loyalty clause, `brand.md` §3).

Pick one. Optionally steal one element from a loser ("the 2 settings screen,
the 1 tree treatment") — say so plainly; phase 2 folds it in.

No other judgment in phase 1. The propositions are deliberately free — do not
score them against old rules (motion vocab, radii, fonts): those constraints
were lifted on purpose.

## Part 2 — ship gate (phase 2, after the build)

### A. Gut (cold, first 30 seconds)

- [ ] Feels like **one thing** across app, website, icons, backdrops
- [ ] Terminal-in-the-pocket, not dark-mode-chat-app
- [ ] The tree is present, never in the way
- [ ] Nothing on screen would embarrass the word "honest"

### B. Voice & lore (against `brand.md`)

- [ ] No rainbow gradients, no ™, no suite/family/solution language, no emoji/exclamations in brand copy
- [ ] Prose capitals (Bifrost, Veraldar), code lowercase (`bifrost`, `veraldar/bifrost`)
- [ ] Attribution reads "a Veraldar product." where product meets brand
- [ ] Limits stated as boldly as claims (install steps, hardware, hands-free status)
- [ ] Midgard/Asgard only in lore copy, never UI

### C. Color & states

- [ ] The three shipped palettes are the palettes — no rogue colors
- [ ] State law holds on every theme: green=alive, amber=heard, red=stop, sky=know
- [ ] "Amber means you are heard, dim means you are not" — the mic states prove it on every theme
- [ ] Contrast: body text readable everywhere, dim never on actions, color never the only signal

### D. Loyalty clause (binding — `brand.md` §3)

- [ ] No copy implies the system has needs or feelings ("I'm happy to", "don't go", "I'll miss you", "companion", "buddy")
- [ ] Exit/abort copy is neutral — no guilt, no longing, no waiting-that-reads-as-sadness
- [ ] Consent/credential/prod screens: no mascot, no favor-framing — verb + object + scope + duration, signing not begging
- [ ] Mascot (where present) reads as calm guardian: edge presence, no attention-begging, no invented emotional states — states map to real system states only
- [ ] Memories/agents exportable, and the copy says so plainly (possession is named)

### E. Screens (sweep, one by one)

- [ ] Session list: readable at a glance; working dots follow state law
- [ ] Chat: text-first; code readable; nothing widens the column
- [ ] Voice states ×4: idle / listening / speaking / working — each unambiguous
- [ ] Mic button (mid-right): tap states clear
- [ ] Settings + session settings: coherent with the language, not generic-web
- [ ] Undo-toast: timed escape visible

### F. veraldar.org

- [ ] Reads as the brand surface; lore page lands (the "names are old, code is new" beat)
- [ ] Landing hero would survive `brand.md` §4 do/don't
- [ ] Animation serves meaning, not spectacle

### G. Red flags (auto-fail)

- Corporate fluff ("seamless", "empower", "revolutionary", "AI-powered")
- Color as the only state signal, anywhere
- A pixel/geometry hybrid that commits to neither
- Any emotional-state metric or engagement-scoring vibe; the mascot inside a permission/credential dialog
- Copy that gives the system feelings ("I'm happy to", "I'll miss you", guilt on exit)
- Corporate fluff in the docs: `docs/brand/` describing a different product than the one on screen
