# Design System — Open Generative AI Studio

> Locked Hallmark design system. Every page defers to this file. The
> diversification rule is **inverted** here: pages must *share* this system,
> not differ from each other. Source of truth for palette, type, spacing,
> motion and component voice. Colour/font values live as tokens in
> `app/globals.css` (`:root`) and are mirrored into `tailwind.config.js`.

Genre: **modern-minimal / atmospheric** — a dark creative-tooling surface for
video & image generation. Reference feel: Runway / Sora, elevated. Not glassy,
not neon. Considered near-black grounds, one cool accent, real depth from
borders + soft shadow (never frosted glass, never a glow).

## Palette (sRGB channel tokens → `rgb(var(--x) / <alpha>)`)

Grounds carry a faint **cool-violet bias** (hue-matched to the accent — chosen,
not a default grey). Text is a neutral-cool white.

| Token            | RGB           | Hex       | Role                                   |
| ---------------- | ------------- | --------- | -------------------------------------- |
| `--paper-0`      | `12 12 16`    | `#0C0C10` | App background                         |
| `--paper-1`      | `19 19 24`    | `#131318` | Panels / rails                         |
| `--paper-2`      | `26 26 33`    | `#1A1A21` | Cards, table rows                      |
| `--paper-3`      | `34 34 43`    | `#22222B` | Raised / hover / inputs                |
| `--line`         | `42 42 52`    | `#2A2A34` | Hairline borders                       |
| `--line-strong`  | `58 58 71`    | `#3A3A47` | Emphasised borders, dividers           |
| `--ink`          | `244 243 247` | `#F4F3F7` | Primary text                           |
| `--ink-2`        | `180 178 192` | `#B4B2C0` | Secondary text                         |
| `--ink-3`        | `124 122 136` | `#7C7A88` | Muted labels (≥12px only)              |
| `--accent`       | `139 124 246` | `#8B7CF6` | Primary accent (violet / periwinkle)   |
| `--accent-hi`    | `165 153 248` | `#A599F8` | Accent hover / bright                  |
| `--accent-ink`   | `20 18 28`    | `#14121C` | Text/icon on an accent fill            |
| `--ok`           | `63 207 142`  | `#3FCF8E` | Semantic success (active, settled)     |
| `--warn`         | `232 178 76`  | `#E8B24C` | Semantic warning (paused, near-cap)    |
| `--danger`       | `242 109 109` | `#F26D6D` | Semantic error (failed, revoke)        |

**Rules.** Accent is violet and used *sparingly* — primary action, active
state, focus ring, one key figure per view. Semantics (ok/warn/danger) are
**separate** from the accent and never used decoratively. No second accent, no
gradients as identity, no cyan (the old slop), no glow shadows.

## Typography — 2 + 1

Loaded via `next/font/google` in `app/layout.js`, exposed as CSS variables.

- `--font-display` → **Bricolage Grotesque** — headings only, used with
  restraint: page titles, project names, big empty-state lines, hero numbers.
  Roman only (no italic headers). Tight tracking on large sizes.
- `--font-body` → **Hanken Grotesk** — everything else: UI text, labels,
  paragraphs, buttons, table cells.
- `--font-mono` → **JetBrains Mono** — data only: cost figures, IDs, token
  counts, timestamps, code. Always `font-variant-numeric: tabular-nums` where
  digits align in columns.

Type scale (rem): 0.6875 · 0.75 · 0.8125 · 0.875 · 1 · 1.125 · 1.375 · 1.75 ·
2.25 · 3. Headings get `text-wrap: balance`; display headers get
`overflow-wrap: anywhere; min-width: 0`.

## Space, radius, depth

- Spacing: Tailwind 4-pt scale (unchanged).
- Radius: `--r-sm 6px · --r-md 9px · --r-lg 13px · --r-xl 18px`. Refined, not
  pill-everything. Inputs/buttons `--r-md`; cards `--r-lg`; modals `--r-xl`.
- Depth: borders first, shadow second. `--shadow-1` (raised card),
  `--shadow-2` (popover/modal). No glow, no colored shadow.

## Motion

Motion-cut project (no framer/gsap). CSS transitions only: **120–180ms**,
`cubic-bezier(0.16, 1, 0.3, 1)`. Hover = border + background shift, never
scale-bounce. One entrance: `fade-in-up`. Everything wrapped in
`@media (prefers-reduced-motion: reduce)` guards.

## Component voice

- **Buttons.** Primary = accent fill + `--accent-ink`. Secondary = `--paper-3`
  fill + hairline. Ghost = transparent + hairline on hover. Full 8-state
  discipline where interactive.
- **Cards / rows.** `--paper-2` on `--paper-0`, hairline `--line`, hover lifts
  to `--paper-3` border `--line-strong`. Soft `--shadow-1` only when raised.
- **Badges / status.** Semantic dot + label. `active`→ok, `paused`→warn,
  `failed`→danger, role/accent→violet tint. Small, uppercase-tracked labels.
- **Tables.** Hairline row separators, `--paper-2` header, mono tabular numbers
  right-aligned for money/counts.
- **Inputs.** `--paper-3` fill, hairline, `--accent` focus ring (2px).
- **Empty states.** Display-font line + muted hint + one primary action.

## Chrome

No hand-drawn browser bars / phone frames / fake window chrome. Real media in
`<figure>` with at most a hairline. Focus-visible always shows a 2px accent
ring. Every surface renders clean at 320 / 375 / 414 / 768 px, no horizontal
scroll (`overflow-x: clip` on `html, body`).
