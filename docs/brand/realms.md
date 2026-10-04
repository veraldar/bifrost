# The seven realms — world themes for bifrost + veraldar.org

*BRAND session, 2026-10-02; **v2 canon same day: the user picked the
"dialects" set** (artifacts/themes-alt-2-opus.html) — every world sits on its
own ground with its own alive/heard accents. The values below ARE the canon;
tokens.css ships them (commit c303729 + fixes), veraldar-site mirrors.
Mechanism: one `[data-theme]` block in `tokens.css` (via the theme.json
source — never hand-edit the generated file) + one WORLDS entry in
`pwa/app/settings/page.tsx` + per-world finish vars in `brand.css`.*

## Canon

Realms are measured futures — the pipeline scores the world
(`realms.json`, live weights). The world-tree shows the mix; the lead names
the front-runner (terminus 31.5% today). Themes let you **wear** a realm.

> wear a world. the tree measures the world.

| realm | color | means | live weight |
|---|---|---|---|
| terminus | `#f87171` | the leash breaks badly — risk, scams, weapons | 31.5% (leads) |
| drift | `#a78bfa` | attention eats everything — slop, no direction | 27.8% |
| control | `#fbbf24` | humans keep the leash — regulation, audits | 15% |
| utopia | `#4ade80` | AI solves material problems — health, abundance | 9% |
| divergence | `#38bdf8` | intelligence escapes the few — open, local, many | 8.4% |
| transcendence | `#f0abfc` | the horizon dissolves — minds beyond minds | 7.8% |
| stagnation | `#94a3b8` | the revolution stalls — winters, plateaus | 0.5% |

State law holds in every realm: `--oz-success` = alive (green/teal family),
`--oz-active` = heard (warm amber family — never the realm hue unless the
realm IS amber), `--oz-danger` = stop (red family), `--oz-info` = know.
The realm hue tints the world (bg/ink/borders) — it is atmosphere, not a slot.

## The five proposed worlds

### divergence — the fork (ship first)

The Veraldar-heart realm: intelligence escapes the few. Deep electric blue,
forking traces, a crown that splits into equal branches — many small actors.
Finish: `--oz-rule: dashed` (the dotted line is drift's; divergence is a
dashed fork line).

[data-theme="divergence"]{
  --oz-bg: #071a33;
  --oz-surface: #0b2242;
  --oz-surface-hover: #112c52;
  --oz-border: rgba(120,190,255,.20);
  --oz-text: #e2f0ff;
  --oz-dim: #8aa6c8;
  --oz-success: #8ad67e;
  --oz-active: #ecc05a;
  --oz-danger: #f27f72;
  --oz-info: #62c2f2;
  /* color-scheme: dark */
}
```

Tree: trunk forks into 3–4 equal crowns; signal paths split at 45° and
re-converge. The tree of many small winners.

### transcendence — the dissolve

The horizon dissolves. Violet-black cosmos, luminous accents; the trunk stays
solid while the crown scatters into fine ascending points — geometry, not
glow. Finish: `--oz-rule: double` (a liminal double line).

[data-theme="transcendence"]{
  --oz-bg: #170c2a;
  --oz-surface: #1f1236;
  --oz-surface-hover: #291844;
  --oz-border: rgba(220,170,255,.18);
  --oz-text: #f3e9ff;
  --oz-dim: #a590c2;
  --oz-success: #92dcc4;
  --oz-active: #f2b48e;
  --oz-danger: #f07499;
  --oz-info: #c4a0f4;
  /* color-scheme: dark */
}
```

Tree: crown dissolves into star-points that climb off the top edge. The only
world where the tree is allowed to not end.

### control — the notary

Humans keep the leash. Austere amber-lit institution: rigid grid, strong
corner ticks (`--oz-tick: 2`), the most "boring at the consent layer" world —
on purpose. The realm hue IS the heard-amber: control is attention made law.

[data-theme="control"]{
  --oz-bg: #1a1709;
  --oz-surface: #221e0f;
  --oz-surface-hover: #2c2715;
  --oz-border: rgba(232,190,90,.20);
  --oz-text: #f1e8cf;
  --oz-dim: #a49a78;
  --oz-success: #6fbcb8;
  --oz-active: #e8b04a;
  --oz-danger: #e8705a;
  --oz-info: #a0b0c4;
  /* color-scheme: dark */
}
```

Tree: topiary — trimmed to exact right angles, a disciplined crown. Nothing
grows where it wasn't put.

### utopia — the orchard (second light world)

Material problems solved: the daylight world at its kindest. Warm green
paper, deep green ink, gold fruit. The counterpart to drift's lavender paper.

[data-theme="utopia"]{
  --oz-bg: #e9efd8;
  --oz-surface: #f6f8ee;
  --oz-surface-hover: #eef3e0;
  --oz-border: rgba(26,46,28,.18);
  --oz-text: #1a2e1c;
  --oz-dim: #55664f;
  --oz-success: #2c6a3a;
  --oz-active: #8a5e10;
  --oz-danger: #a63e2c;
  --oz-info: #2c6a86;
  /* color-scheme: light */
}
```

Tree: full crown, a few gold fruit circles — never more than seven. Abundance
is calm, not loud.

### stagnation — the winter (ship last, or never)

The revolution stalls. Near-grayscale, cold fog, the lowest-saturation world
in the system; even success is a frost-green. Kept honest: 0.5% of the
measured world. Finish: thin solid rule, no ticks, no ornaments.

[data-theme="stagnation"]{
  --oz-bg: #1d2126;
  --oz-surface: #24292f;
  --oz-surface-hover: #2c3239;
  --oz-border: rgba(170,182,198,.16);
  --oz-text: #d6dce3;
  --oz-dim: #97a1ac;
  --oz-success: #8fb0a0;
  --oz-active: #cfa968;
  --oz-danger: #d8899a;
  --oz-info: #93a9c0;
  /* color-scheme: dark */
}
```

Tree: bare branches, one fog band across the middle. Nothing moves unless
something is true — and in stagnation, little is.

## Ship order + rules

1. **divergence** first (the on-message realm — Veraldar IS divergence),
2. **transcendence** (the showpiece), 3. **control**, 4. **utopia**,
5. **stagnation** last or never (it is complete but deliberately joyless).

Rules: all ten roles per world; `color-scheme` declared; contrast floors hold
(body ≥ 4.5:1, dim never on actions); realm hue tints atmosphere, state
families keep their meanings; one tree per world, structural not recolor;
worlds never animate the switch. Values land via the theme.json source →
pipeline → `tokens.css`; then one WORLDS entry each.
