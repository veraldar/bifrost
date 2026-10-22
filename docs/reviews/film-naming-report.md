# Film naming report: the film says what we sell, with one set of names

*Session FILM-NAMING, 2026-10-22. From the user's 10-22 concern: "the far vision" is the wrong framing, the two
films need one story, and there are too many names.*

**Live now on veraldar.org** (deployed, verified). Also in the app's door on the sandbox (:8443). I didn't touch the
live stack (`lk-pwa`, `lk-agent`) or `docs/urd/`.

![before / after, on a phone](/api/artifact/film-naming-before-after.png)

## The verdict in four lines

1. **The cosmology is good. The order was the problem.** On a phone, a first-timer met **14 names** (world-tree,
   Bifrost, far vision, root, brain, private line, yggdrasil, Midgard, Asgard, trunk, branch…). The page **never**
   said in one sentence what the product does. Now: 3 words come before that sentence (the masthead and the
   world-tree strap), and the names after it come in one order.
2. **Three tree maps were live at once, and they disagreed.** The brand book said roots = the network. Door v3 said
   root = the brain. The film said root = brain, but drew the private line under the roots, like the brand book.
   **"yggdrasil" meant both "the tree" and "the brain"** (the install step, the products card, /start). Now there is
   one map, written down: `docs/brand/naming-ladder.md`.
3. **"The far vision" sold a dream.** It opened with "many trees … what they can do together", and said "one app
   reaches them all", which hasn't shipped. It's now **"what it does · one phone · your computers · today"**. It
   opens on what works now. What isn't built yet is still marked *growing*.
4. **The two films are now the wide shot and the close-up.** "what it does" (1 min 45) is the wide shot, and the
   15-second film is **"one tree, up close"**. The section between them has the same title, and both films use the
   same words: *the app in your hand* (bifrost) and *the private line* (the trunk).

## The ladder

Rule: say **what it does** before **any name**. Show the plain thing first, then its name, at the moment it first
appears. Never use a name before it's taught. The deeper names wait behind "why these names?".

| Order | Word | Means | Taught where |
|---|---|---|---|
| 0 | none | "Talk to your own computer from your phone. It does the work." | hero, first sentence |
| 1 | **bifrost** | the app in your hand | hero, second line |
| 2 | **tree** | your computer, working for you | the hero drawing; the film |
| 3 | **root** | its brain (a cloud service you pick, or your own computer) | the film, chapter 3; the door's brain step |
| 4 | **the private line** | only your devices on it (tailscale, today) | the film, chapter 3; the door's last step |
| 5 | trunk · branch · yggdrasil · veraldar | the names of the parts | on demand: "one tree, up close", the 15 s film, "why these names?" |

**My judgement on each name:**
- **bifrost:** keep. It's the one name a buyer needs, and it's now taught in the hero.
- **tree:** keep. It carries the whole idea and the drawing teaches it.
- **root = brain:** keep. It matches your "roots on different hardware": each tree's brain can sit somewhere different.
- **trunk, branch:** keep, but only in the close-up. A first-timer gets "the private line" and "the app in your hand"
  in plain words first.
- **yggdrasil:** keep, as the tree's own name and what the install puts on your computer. It's never "the brain"
  any more. A first-timer meets it only in the close-up and the install line.
- **veraldar:** keep. It's the address, the masthead and the film's signature.
- **Midgard / Asgard:** cut from the site. The brand book already limits them to lore.

## What changed

**veraldar.org** (deployed):

| Where | Before | Now |
|---|---|---|
| Hero | "The old names. The new code. Tools you own outright — starting with Bifrost." | "**Talk to your own computer from your phone. It does the work.**" then "Your computer is the tree. Bifrost is the app in your hand. No accounts, no cloud in the middle, source on the table." |
| Film section | "the film / **the far vision** · many trees · one phone"; lead opened on "One phone, many computers…" | "**what it does** · one phone · your computers · today"; the lead opens on you talking and the desk computer working; the note says "a short film of what works today" |
| Poster's one pulse | ran desk → tv (the part still *growing*) | runs **phone → the desk tree → down its trunk to the root**, the trip that works today (the 15 s film's trip) |
| "three names" | three Norse names first (plus Midgard and Asgard); the `$ tree` glosses were cut off on a phone, leaving five bare names | "**one tree, up close**": the `$ tree` as rows that wrap, with every plain word visible; the Old Norse names sit behind "**why these names?**" (the door's own phrase) |
| Products card | "v0.7 its own brain (yggdrasil)", "no tailnet needed", "Your own LLM key" | "v0.7 its own **tree** (yggdrasil), any brain", "no **tailscale** needed", "a brain: your own key, or a model at home"; network = "the private line (tailscale)" |
| Door, install step | "it installs **the brain** (yggdrasil)" | "it installs **your tree** (yggdrasil)" (EN+FR) |
| /start | "1 · THE BRAIN — YGGDRASIL", "no root, no docker" | "1 · **THE TREE** — YGGDRASIL", "the agent that does the work (**no sudo**, no docker)"; the settings step names the brain as the tree's root |
| The 15 s film from the page | "back to the door" (no door was open) | "back to the page" |

**Both films** (one source in the sandbox, copied to the site):

| Film | Change |
|---|---|
| what it does (was the far vision) | Title, subtitle and note EN+FR. Chapter 3's label is now "bifrost · the app in your hand". 2 lines re-recorded: **fv_open** "one phone, your own computer. here is what they do today." and **fv_bridge** "bifrost is the app in your hand. it reaches each tree on that line." (was "one app … reaches them all", which hasn't shipped) |
| one tree, up close (was YOUR TREE) | Header EN+FR. 1 line re-recorded: **name_tree** "the tree is your computer, working for you. its name is yggdrasil." (it opened on "yggdrasil is…") |

The **app door** gets the new name_tree automatically ("hear it", the 15 s film), because it reads the same script.
Its copy already followed the ladder.

![the films: start cards EN/FR, chapter 3, the close-up's header EN/FR](/api/artifact/film-naming-films.png)

![one tree, up close — with "why these names?" open](/api/artifact/film-naming-close-up.png)

## What I kept, and why

- **The poster's three trees, and chapters 3 and 4 of the film.** That's the cosmology you like. Several computers,
  each running its own tree, is true today: you install it on each one. Only trees passing work to each other is
  marked *growing*, and that's honest.
- **"trunk"**, in the close-up only. You like it, and it's taught there right where it appears.
- **The `#&film` link and the file name `far-vision.html`.** Links, caches and tests point at them. Nobody sees the
  file name.
- **All other voice lines** (48 of 51). Only words that changed were re-recorded.

## What I recommend NOT changing (you may veto)

- **Don't rename veraldar, bifrost or yggdrasil.** The problem was the order and the double meanings, not the names.
- **Don't bring "roots = the network" back.** It's the brand book's 09-30 map. It clashes with root = brain, which
  the door, both films and your "roots on different hardware" all use. I left a pointer in `brand.md` instead of
  rewriting your canon.
- **Don't add more names to the film** (grove, midgard, trunk). The film works with tree, root, the private line and
  bifrost.

## Your calls: noticed, not changed

1. **The world-tree strap** ("the world-tree terminus leads · 30.7%") is the 2nd line a first-timer reads. "World
   tree" is literally yggdrasil, but this is an unrelated data page. It's another project's surface, so I left it.
   **My recommendation:** move it below the product, or give it its own name.
2. **"the root … thinks and remembers"** (door gloss and name_root). With a cloud brain, this suggests the cloud
   keeps the memory, but the memory lives on your computer. The internal plan says "per-root wells". A fix needs one
   gloss plus 2 re-recordings. I'd do it next, if you agree that memory belongs to the tree.
3. **"your trees never publish on their own"** (film, chapter 5). That's only as true as the agent's permissions
   (edge gates). Worth checking before you sell it.
4. **`narration.md`**, the 10-02 movie script, still uses the old map. It's superseded in practice. Rewrite or
   retire it: your call.

## Evidence

| What | Result |
|---|---|
| Naming audit (`scripts/naming-audit.mjs`, phone 360×780, reading order) | **Before:** 14 names, the product never said in one sentence. **After (live):** 3 before "Talk to your own computer from your phone", then bifrost → root/brain → private line → yggdrasil/trunk/branch → tailscale. Midgard, Asgard, far vision and tailnet are gone. |
| New e2e "one naming ladder" (site-door.spec) | **RED on the old live site** ("the page says what it does": null). **GREEN** on the working copy and on live. |
| site-door on the working copy | 7 passed, 1 skipped (needs the app URL) |
| site-door on **live veraldar.org** + the app at :8443 | **8/8**, including site → app → back |
| Sandbox door + films (build `7kyRLgWEyTqYyfWxIFjg8`) | **8/8**: tree-first 4/4, voice-wait 3/3, first-turn 1/1 (transcript 853 ms, reply 9.3 s). Greeting first audio was 138 ms on the first run after the restart (cold), then **65 / 70 ms** warm. Confirmation 16 ms. |
| Voice | 6 renders (3 lines × EN/FR), the referee heard them back at **0.91–1.0**. The only misses were the ASR's spelling of "yggdrasil" and FR "appli" heard as "appeler". |
| Deploy | 12 files, **sha-identical** over https. /start 308 → 200. Service worker v10, so phones drop the old audio. |
| Not rerun | The sandbox's general suite. This diff touches only the door's script text and the films, and their specs ran. The phone-class repro wasn't rerun either; greeting latency was measured above. |

## Commits and rollback

- **sandbox** `lab/sandbox`: `1d5c734` script + 6 voice files · `3982b50` both films + sync script · `d7a131e` e2e
  ladder + audit
- **veraldar-site**: `9f6ba79` page copy (hero, film, names, products, door, /start) · `47b61c1` films + voice + sw
  v10, **deployed**
- **bifrost**: this report, `docs/brand/naming-ladder.md` (new), and a pointer in `docs/brand/brand.md`
- **Rollback (site):** on the host, restore `index.pre-naming.bak.html`, `start.pre-naming.bak.html`,
  `sw.pre-naming.bak.js` and `onboarding.pre-naming.bak/`.

## Try it on your phone (3 steps)

1. **Open veraldar.org.** Read only the first screen. It should tell you what it does before it names anything but
   itself.
2. **Scroll to "what it does", watch the poster, then tap ▸ watch.** One pulse travels from the phone down into the
   desk tree's root. The film opens with "one phone, your own computer. here is what they do today." In chapter 3,
   bifrost is "the app in your hand".
3. **Scroll to "one tree, up close", then tap "watch it · 15 s".** It opens "the tree is your computer, working for
   you. its name is yggdrasil." Its way out says "back to the page". Tap "why these names?" for the Old Norse
   meanings.
