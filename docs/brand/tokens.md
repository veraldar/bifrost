# Veraldar design tokens — the codified system

*BRAND session, 2026-09-30. Rules extracted from the shipped themes. Values
shown are a snapshot for reference; the source of truth is upstream. This is
Part 1 of the brand system: Veraldar owns it, every product inherits it
unchanged — Bifrost is simply the first shipper.*

## Where truth lives (the chain)

```
veralldar-theme (W3C DTCG source)  ← edit HERE to change a value
  → scripts/build.sh
    → pwa/styles/tokens.css        ← generated, header says "do not edit"
      → pwa/styles/globals.css     ← wires tokens + backdrops + motion
```

`docs/brand/` documents the rules that survive regeneration. Never edit
`tokens.css` by hand; never re-pick a color locally.

## The ten roles

Every theme must define exactly these `--oz-*` roles — no role additions
without a rule here, no one-off hexes in components.

| Role | Meaning | Law of use |
|---|---|---|
| `--oz-bg` | page background | one per theme; the terminal void |
| `--oz-surface` | panels, cards, input wells | darker (or lighter in drift) than bg; no borders of its own — pair with `--oz-border` |
| `--oz-surface-hover` | interactive hover only | never used as a static fill |
| `--oz-border` | 1px hairlines, dividers, outlines | always an rgba alpha over bg, never a solid pick |
| `--oz-text` | primary text | the loudest color on screen; body copy only |
| `--oz-dim` | secondary text, labels, meta, timestamps | never for actions, never for body copy |
| `--oz-success` | **alive**: mic live, TTS speaking, progress, PTT hold | green in every theme |
| `--oz-active` | **attention — "you are heard"** | amber in every theme; glow + ring effects only ship in amber |
| `--oz-danger` | destructive, abort | red family; never decorative |
| `--oz-info` | informational hints, links | the only cool accent allowed next to text |

The state-color law (this is the core brand rule, from req 09-30):

> **green = alive. amber = you are heard, dim = you are not. red = stop.
> sky = know this.**

Color is never the only signal — pair it with motion (see below) or text.

## The three themes (personalities)

- **aether** — flagship and default (`:root`). Deep-space terminal: near-black
  blue `#080810` bg, pure-black `#000000` surface, white text, `#888` dim.
  Accents are the bright 400-series (green `#4ade80`, amber `#fbbf24`, red
  `#f87171`, sky `#38bdf8`). Maximal contrast; this is the brand as first seen.
- **terminus** — warm dark CRT: plum-black `#100c14` bg, warm beige text
  `#cfc8bd`, teal success `#7ad8c8`, amber `#ffb24a`. The retro-terminal mood.
- **drift** — the one light theme: lavender paper `#ece8f8`, ink `#1c1838`,
  muted teal/gold/rust accents. Must keep `color-scheme: light` working (it
  flips per-theme in globals.css) — any new theme declares its scheme.

Rules for any new theme: all ten roles defined; scheme declared in
`globals.css`; a backdrop SVG shipped in `pwa/public/backdrops/` and wired by
`data-theme`; passes the state-color law (green/amber/red keep their meanings).

## Type

- **Identity font: Commit Mono** (shipped: `commit-mono-400-regular.woff`).
  Anything that *looks like the product* is mono — the `.oz` surface, status
  lines, the wordmark.
- Sans stack (`--font-public-sans` / Everett fallback) is utility-only for
  non-terminal surfaces. It never appears in the terminal voice.
- No new display fonts, ever. Weight and size carry hierarchy; the mono does
  the rest. Fallback chain stays: Commit Mono → ui-monospace → Courier.

## Space and shape

Spacing is not tokenized upstream yet — these are the observed, codified
values from the shipped surface:

- **Base grid: 4px.** Gaps, padding, offsets land on multiples (2px allowed
  inside micro-components like the EQ strip).
- **Radii:** shells use `--radius` (0.625rem / 10px). Inside the terminal
  surface, small radii only: 3px on tracks/bars, 1px on EQ bars. No pill
  buttons in the terminal voice; circles only for dots/indicators.
- **Borders: 1px hairlines** (`--oz-border`), no 2px outlines except focus.
- **Scrollbar: 4px**, `#333` thumb — thin by identity, not by neglect.
- Odd values (the 7px ring inset, 18px glow) are optical corrections. Use each
  once, where it already exists; don't multiply them into a scale.

## Motion — the whole vocabulary is four moves

Nothing else in the product animates. New motion must map to one of these
meanings or be cut.

| Pattern | Meaning | Spec |
|---|---|---|
| pulse (`oz-pulse`) | alive / working | opacity 1 → 0.45, ease-in-out, 1.2s (busy) or 0.9s (PTT hold) |
| ring (`oz-free-ring`) | you are heard | amber ring expands + fades, 1.6s; amber glow via box-shadow — the only shadow in the system |
| shrink (`oz-shrink`) | time running out | scaleX 1 → 0, linear, 3s (undo window) |
| equalizer (`oz-eq`) | speaking | scaleY bounce, 0.7s, staggered bars; paused state dims to 0.4 |

Motion rules: opacity/transform only; no color-cycling animations; no parallax;
backdrops never animate. Known gap, next fix: gate the four patterns behind
`prefers-reduced-motion` (paused/dimmed fallbacks like `oz-eq-paused`).

## Contrast floor

Approximate, verified against the aether snapshot: text `#ffffff` on bg
`#080810` ≈ 20:1; dim `#888` ≈ 5.5:1; success `#4ade80` on surface ≈ 10:1.
The rule that matters: body text ≥ 4.5:1, `--oz-dim` only for meta, role
colors only at ≥ 4.5:1 against the surface they sit on. If an accent fails,
the theme is wrong, not the rule.

## Anti-patterns

- No gradients on UI chrome. No shadows except the amber glow.
- No pure white surfaces in dark themes (aether surface is `#000`; pure white
  is text only). No pure black text on light themes — drift uses ink `#1c1838`.
- No color as the only signal; no icon without a role; no accent color chosen
  "because it looks nice" — it must carry one of the ten roles.
