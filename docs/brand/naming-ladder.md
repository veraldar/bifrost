# The naming ladder: one meaning per name, earned in order

*FILM-NAMING session, 2026-10-22. Proposed; the user may veto. Public copy on
veraldar.org, both doors and both films follows this file. The lore table in
`brand.md` §1 is the original 09-30 map (there, roots = the network). This
file supersedes it for public copy until the user decides.*

## The rule

A first-timer learns **what it does** before learning **any name**. Every
name after that is the plain thing first, then its name, taught where it
first appears. A name is never used before it is taught. Depth is on demand:
"why these names?" opens it, and nothing on the main path asks for it.

## The ladder (first-timer order)

| Rung | Word | Means | Where it is earned |
|---|---|---|---|
| 0 | — | "Talk to your own computer from your phone. It does the work." | hero, first sentence; the door's greeting |
| 1 | **bifrost** | the app in your hand | hero, second line; the door's first gloss |
| 2 | **tree** | your computer, working for you | the hero drawing ("hold to start"); the film, chapter 1 |
| 3 | **root** | its brain: the model it thinks with (a cloud service you pick, or your own computer) | the film, chapter 3; the door's brain step |
| 4 | **the private line** | only your devices on it (tailscale, today) | the film, chapter 3; the door's last step |
| 5 | **trunk** · **branch** · **yggdrasil** · **veraldar** | trunk = the private line, branch = bifrost, yggdrasil = the tree's own name (what the install puts on your computer), veraldar = the world that holds your trees, and the people who make these tools | on demand: "one tree, up close" (the 15 s film, the `$ tree`), "why these names?" |

Two words do the shared work across both films. **"The app in your hand"**
(bifrost) and **"the private line"** (the trunk) appear in the film's chapter 3
and in the 15 s film, word for word.

## One meaning per name (the conflicts this fixed)

- **yggdrasil = the tree, never "the brain".** The brain is the tree's root.
  The install step reads "it installs your tree (yggdrasil)". On /start, the
  wording "no root" (no admin rights) became "no sudo", because root means
  the brain here.
- **"your tree" = your own computer, the one the door sets up.** The 15 s
  film is "one tree, up close": the close-up of the film, "what it does".
- **Midgard and Asgard are cut from public pages.** brand.md already keeps
  them to lore copy only. The myth is a map, not the product.

## The two films: one story

- **"what it does"** (`#&film`, ~1 min 45) is the wide shot. It shows what
  works today: you talk, the desk computer works, the work stays there. Every
  computer can grow its own tree with its own root, on one private line. The
  one limit is said out loud. Anything not shipped is marked *growing* (trees
  passing work to each other, the "put it on the tv" test). It ends on your
  tree, which opens the door.
- **"one tree, up close"** (`#&tree`, 15 s) is the close-up. Tree, root,
  trunk, branch, then you hold the branch and the words make the trip down to
  the root and back. The poster's single pulse on veraldar.org is that same
  trip.

## Referee

- `bifrost-sandbox/pwa/e2e/site-door.spec.ts`, test "one naming ladder"
  (RED on the 10-22 pre-fix site, GREEN after)
- `bifrost-sandbox/scripts/naming-audit.mjs [URL]`: the reading-order first
  appearance of every name on a phone, plus how many names come before the
  page says what it does (10-22: 14 and never said → 3)
