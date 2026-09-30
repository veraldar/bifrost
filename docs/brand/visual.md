# Veraldar visual direction — iconography, backdrop, mark

*BRAND session, 2026-09-30. Direction only — no binary assets produced yet.
Anything visual shipped later must obey `brand.md` + `tokens.md` first.*

## Asset inventory (what exists)

| Asset | Role |
|---|---|
| `pwa/public/yggdrasil_final.svg` | the circuit-tree — default (aether) backdrop, de facto brand image |
| `pwa/public/backdrops/terminus.svg`, `drift.svg` | per-theme backdrops, wired by `data-theme` in globals.css |
| pixelarticons (npm base set) | the icon system |
| `commit-mono-400-regular.woff` | identity font (see tokens.md) |
| `everett-light.woff` | utility sans — never in the terminal voice |
| `lk-logo*.svg`, `lk-wordmark.svg` | LiveKit's brand, NOT ours — never use as bifrost branding |

## The mark

The brand image is the **circuit-tree**: Yggdrasil drawn as circuit traces —
roots as traces, crown as planes, the trunk as the bus. Hardware and myth in
one line-work image. It belongs to **Veraldar** (the tree holds the world),
and every product inherits it. It already exists (`yggdrasil_final.svg`);
direction:

- Keep it **line work only**: strokes, no fills, no gradients, single hue
  (currentColor or a backdrop-dim color). It must read at favicon size and at
  full-bleed without changing structure.
- Wordmarks do the work — the name set in Commit Mono, lowercase, followed by
  a block cursor `▮` (the blinking prompt is the only ornament):
  - **Brand:** `veraldar▮`
  - **Product:** `bifrost▮`, with the subline "a Veraldar product" beneath
    (attribution phrases are fixed in Part 2 of `brand.md`).
  No custom lettering, no icon+text lockup until the compact glyph exists
  (future work below).
- Never: tree + rainbow (myth Bifröst is a rainbow; ours is not — no rainbow
  gradients anywhere in the brand), never a bridge illustration, never 3D,
  never a per-product reinterpretation of the tree.

## Iconography — pixelarticons base

- **Base set: pixelarticons.** One family, one pixel grid. Never mix icon
  families; no filled+outlined mixing within one surface.
- **Color law:** icons inherit `currentColor` (`--oz-text` / `--oz-dim`). A
  role color (success/active/danger/info) is allowed only when the icon *is*
  the status — e.g. the live mic is amber glow + ring (req 09-30: "amber means
  you are heard, dim means you are not"). Decorative color on icons: never.
- **Grid discipline:** integer scaling only, no sub-pixel sizes, no blur. New
  icons: draw on the pixel grid as SVG, square corners, `shape-rendering:
  crispEdges`, viewBox matching the pixelarticons grid. A new icon must not
  introduce curves where the family uses steps.
- Pixel + terminal is the same idea: the pixel grid is the 4px base grid made
  visible. Keep them consistent — icons, borders, radii all snap to it.

## Backdrop direction

The backdrop is **the world seen from Midgard** — the tree faintly present
under everything you do. Rules it already follows and must keep following:

- Fixed, `inset: 0`, `pointer-events: none`, under all content (`z-index: 0`).
- **Subordinate to text, always.** Trace contrast far below `--oz-dim` — if
  you notice the tree before the words, the backdrop is too loud. On landing
  prose sections, dim further or drop it above the fold.
- One backdrop per theme, SVG only (crisp at any DPI, tiny to ship), stored in
  `pwa/public/backdrops/`, wired in `globals.css` per `data-theme`.
- **Stillness.** The backdrop never animates — the four motion moves in
  tokens.md are the only motion in the system, and they mean things.

## Future work (for the next pass, in order)

1. Compact tree glyph: derive crown+trunk-only paths from `yggdrasil_final.svg`
   → favicon (16/32) + PWA icon. Monochrome; theme-aware via `currentColor`.
2. og-images: brand og = circuit-tree on aether bg + `veraldar▮`. Product og
   = same layout with the product wordmark (`bifrost▮`) + "a Veraldar product"
   subline. No photo, no gradient wash.
3. Empty states / 404: terminal-native copy (`brand.md` voice) + one pixel
   icon, not illustrations.
4. Backdrop discipline check on the landing page (launch session builds it —
   point them at this file before styling).
5. Reduced-motion fallbacks for the four motion moves (tracked in tokens.md).
