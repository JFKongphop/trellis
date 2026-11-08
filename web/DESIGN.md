# Design — Sprout Style Reference

> Adapted from the **Amplemarket** design language (refero style `95cac053-2b53-48c4-a5cb-06ee08df9c7a`, amplemarket.com). This doc reproduces the refero guideline as the source of truth, then records how Sprout applies it (see **How Sprout applies it**).

---

## Overview (refero)

**Theme: light.** "Subtle dynamism on a crisp canvas." A high-tech platform aesthetic using a predominantly neutral palette punctuated by dynamic, soft-edged gradients. Strong, clean typography; subtle layered surface treatments; sparse, vibrant background accents that suggest energy and movement. Interactive elements are clearly defined, contrasting crisp type against dark fills or light backgrounds. The overall impression: restrained power and sophisticated utility.

---

## Colors (refero)

| Name | Value | Token | Role |
| --- | --- | --- | --- |
| Midnight Ink | `#111111` | `--color-midnight-ink` | Primary text, icon fills, dominant backgrounds on dark sections, heavy borders |
| Canvas | `#f6f5f3` | `--color-canvas` | **Page base (L0)** — the warm off-white the whole app sits on |
| Canvas White | `#ffffff` | `--color-canvas-white` | **Cards (L1)** + text on dark sections; brighter than the page so cards pop |
| Surface Charcoal | `#272625` | `--color-surface-charcoal` | Elevated card / input backgrounds (dark) |
| Muted Ash | `#6d6c6b` | `--color-muted-ash` | Secondary text, subtle borders, inactive states |
| Whisper Gray | `#f4f3ef` | `--color-whisper-gray` | Subtle background panels, light hover states |
| Light Taupe | `#ecebea` | `--color-light-taupe` | Ghost-button backgrounds, subtle surface variations |
| Deep Indigo | `#10054d` | `--color-deep-indigo` | Distinct element coloring, primary button text on light backgrounds |
| Midnight Violet | `#2e2460` | `--color-midnight-violet` | Violet state accent for badges/validation; **do not promote to primary CTA color** |
| Phoenix Orange | `#e8400d` | `--color-phoenix-orange` | Decorative gradient/background accent (warm) |
| Cyan Glow | `#99fff9` | `--color-cyan-glow` | Decorative gradient/background accent (cool) |
| Petal Pink / Mint Green / Canary Yellow / Subtle Lavender | `#ffd7f0` / `#b7efb2` / `#ffef99` / `#e2ddfd` | — | Soft accent cards, decorative background elements |

**Pillar accents** — refero defines these as washes / "supporting accent, **not** a status color," for small functional accents (icons or tags related to their category):

| Name | Value | Token |
| --- | --- | --- |
| Engagement Gold | `#fbc768` | `--color-engagement-gold` |
| LeadGen Red | `#e16540` | `--color-lead-gen-red` |
| Intelligence Blue | `#328efa` | `--color-intelligence-blue` |
| Deliver Green | `#47d096` | `--color-deliver-green` |

**Quick reference:** text `#111111` · background `#ffffff` · border `#11111114` (Midnight Ink @ 8%). No distinct saturated CTA color — primary actions use the dark Midnight Ink fill.

---

## Typography (refero)

**Labil Grotesk Variable** (substitute: **Inter**). The variable font fine-tunes expression across headers and body; distinct letter-spacing creates a sharp, intentional rhythm.

- **Weights available:** 400, 500, 700, 900.
- **Letter-spacing rule:** larger sizes (≥20px) use **negative** tracking; small body text (12/14px) uses **positive** tracking for readability.
- **Tracking by size:** -0.05em@84 · -0.04em@56 · -0.03em@44 · -0.02em@36 · -0.017em@28 · -0.011em@24 · -0.01em@20 · normal@16 · +0.025em@14 · +0.03em@12.

### Type scale (refero)

| Role | Size | Line height | Tracking |
| --- | --- | --- | --- |
| caption | 10px | 1.0 | +0.3px |
| body | 14px | 1.3 | +0.25px |
| subheading | 20px | 1.1 | -0.2px |
| heading-sm | 24px | 1.1 | -0.26px |
| heading | 28px | 1.1 | -0.48px |
| heading-lg | 44px | 1.1 | -1.32px |
| display | 56px | 1.0 | -2.24px |

---

## Border radius (refero)

| Element | Value |
| --- | --- |
| cards | 12px |
| icons | 12px |
| badges | 12px |
| images | 12px |
| inputs | 12px |
| **buttons / nav** | **8px** |

Refero rule: "Apply 12px to most containers (cards, inputs, selected interactive elements); reserve 8px for primary buttons and nav. Do not vary border radius arbitrarily."

---

## Shadows (refero) — three only; subtle + diluted

| Name | Value | Token |
| --- | --- | --- |
| Card – Elevated Light | `rgba(17,17,17,.02) 0 -6px 6px 0, rgba(17,17,17,.01) 0 -23px 9px 0` | `--shadow-card` |
| Header / Floating Elements | `rgba(17,17,17,.05) 0 0 1px 0, rgba(17,17,17,.04) 1px 1px 1px 0, rgba(17,17,17,.03) 2px 3px 2px 0, rgba(17,17,17,.01) 4px 4px 2px 0` | `--shadow-header` |
| Button / Interactive Element | `rgba(17,17,17,.04) 0 1px 2px 0, rgba(17,17,17,.04) 0 4px 8px 0` | `--shadow-button` |

Refero rule: "Do not add heavy or opaque shadows; elevation should be subtle, diluted rgba(17,17,17,.02–.05)."

---

## Spacing & surfaces (refero)

- **8px base unit.** Element gap 8px · card padding 20px · section gap 56px.
- **Surfaces / elevation (Sprout model):**
  - **L0 page** = Canvas `#f6f5f3` (`--color-canvas`) — the off-white base + hero gradient.
  - **L1 card** = Canvas White `#ffffff` (`.surface-card`, + hairline ring + card shadow) — the first layer; *pops above* the page.
  - **L2 recess** = Whisper Gray `#f4f3ef` (`.surface-panel`) — a subtle recessed sub-area **only when nested inside a white card**.
  - **Rule: never place a gray surface directly on the page.** Top-level surfaces (chat input, chips, tool rows, cards) are white. Gray is recess-inside-white only. (Surface Charcoal `#272625` = dark inline badges/inputs, rare.)

---

## Component recipes (refero)

- **Primary Filled Button – Dark** (CTA): Midnight Ink bg, Canvas White text, 8px radius, padding 12×16, weight 500.
- **Default Button – Light** (secondary): Canvas White bg, Deep Indigo text, 8px radius, padding 12×16, weight 500.
- **Ghost Button** (tertiary / nav): transparent, Muted Ash text (Canvas White on dark), 8px radius, no border, padding 12×16 (or 6×14 small).
- **Card – Elevated Light:** Canvas White bg, subtle Card shadow, 12px radius, 20px padding.
- **Card – Client Logo:** Whisper Gray bg, no shadow, 12px radius, padding 16×20.
- **Card – Accent Colored:** Petal Pink / Mint / Canary / Lavender bg, no shadow, 12px radius.
- **Input Field – Light:** Canvas White bg, Midnight Ink text, `rgba(17,17,17,.08)` border, 12px radius, padding 0×16.
- **Input Field – Dark:** Midnight Violet bg, Canvas White text, `rgba(255,255,255,.08)` border, 12px radius.
- **Navigation Link:** ghost styling, Muted Ash text, padding 6×14.
- **Info Badge – Inline:** Surface Charcoal bg, Canvas White text, 12px radius, padding 8×10, 12px font.

---

## Imagery & layout (refero)

- **Background:** a **faithful WebGL port of Amplemarket's `home-hero` shader** (`parts/gradient-field.tsx`) — 3 metaball blobs (additive exclusion blend) in **the app's accent palette**: Intelligence Blue `#328efa` (pointer-tracked), Deliver Green `#47d096` + Engagement Gold `#fbc768` (slow time animation), read straight from the `--color-*` accent tokens. In-shader film grain; colors passed 0–255 (shader ÷255). Transparent canvas over `#f6f5f3`; the wash is **confined to a contained bottom-right glow in the fragment shader** (alpha fades by distance from a corner anchor — tune `mc` + the `smoothstep` there) so most of the page reads as clean `#f6f5f3`.
- **Icons:** outlined, lightweight, mono-color (Midnight Ink or Canvas White).
- **Layout:** max-width contained, centered; full-bleed hero over a diffused gradient; sticky top nav with subtle elevation; generous vertical rhythm.

---

## Do / Don't (refero)

**Do**
- Negative tracking on text ≥20px; positive on 12/14px body.
- Prioritize Canvas White backgrounds + Midnight Ink text (high contrast).
- 12px radius on most containers; 8px on buttons/nav.
- Intersperse soft-edged radial gradient washes for dynamism.
- Whisper Gray for feature / logo cards.
- 8px element gap, 20px card padding, 56px section gap.
- Use pillar accents (Gold/Red/Blue/Green) for small functional accents (icons, tags).

**Don't**
- Bright saturated colors for large backgrounds (only soft gradients).
- Generic system fonts — always Labil Grotesk Variable.
- Heavy/opaque shadows — keep diluted (.02–.05).
- Arbitrary border radii — 12 containers / 8 buttons only.
- Default browser-blue links — links are Midnight Ink (or Canvas White on dark).
- Outline buttons for primary CTAs — use the solid dark fill.
- Cluttered spacing — keep comfortable breathing room.

---

## How Sprout applies it

The refero guideline above is the source of truth. Sprout's intentional adaptations:

- **Tokens** live in `web/src/app/globals.css` (`@theme`). All colors/radii/shadows are CSS variables; **use Tailwind classes + `cn()`, never inline `style` for design tokens** (inline allowed only for runtime-dynamic values — element size from props, hashed avatar colors, `--wash-opacity`, sparkline geometry).
- **Radius classes:** `rounded-card` (12, default for cards/inputs/badges/chips/dialogs/images), `rounded-button` (8, buttons + nav), `rounded-full` (genuine circles only — avatars, status dots, icon disks). The shadcn scale resolves `rounded-md/lg/xl` → 12.
- **Shadow classes:** `shadow-card`, `shadow-header` (dialogs / menus / sticky header / floating), `shadow-button` (inputs / interactive). No other shadows.
- **Font weights used: 400 (default) + 500 (`font-medium`, most emphasis) + 600 (`font-semibold`, rare key accents only).** We do **not** use 700/900 — `font-bold` is banned. Even the largest hero headlines render at medium weight.
- **Deliver Green `#47d096` is promoted to the yield/positive status accent** (APY chips, "earning", success ticks/disks, share-price sparkline). Contrast rule: use it as fills/washes/dots/strokes — never small green body text. On a solid green badge, text is Midnight Ink; tinted chips (`bg-deliver-green/15`) use Midnight Ink text. Large APY numerals are Midnight Ink. Gold = warning/pending, LeadGen Red = error/destructive.
- **Background:** the WebGL `<GradientField>` (`parts/gradient-field.tsx`), mounted once in `cinematic-chrome.tsx`. `<CinematicShell mode>` sets intensity (`bright` = landing hero, `dim` = calm in-app). Paused offscreen via IntersectionObserver; frozen under `prefers-reduced-motion`. Page base `#f6f5f3` shows before it mounts.
- **Surfaces (elevation):** page `#f6f5f3` (L0) → `.surface-card` white card (L1, pops) → `.surface-panel` whisper-gray recess (L2, nested-in-white only). **Never a gray surface directly on the page** — top-level = white. `.surface-charcoal` for rare dark badges/inputs.
- **Reusable atoms** (`web/src/components/ui/`): `Surface`-less utilities plus `SproutBadge`, `StatusDisk` (tone green/gold/red/neutral, wash or solid), `Tag` (tone neutral/green/gold/red/violet chip), `PillButton` (variant primary/secondary/ghost). Reuse these — don't re-implement the markup.
- **Monospace** (`--font-mono`, Sometype Mono) is kept only for hex addresses / tx digests / tabular figures — a functional carve-out, not part of the Amplemarket brand voice.

---

## Trellis color update (2026-10-22)

Layout and type stay as above; the accent glow follows alpha402:
- **Glow palette** (`--color-glow-orange #f97316`, `--color-glow-violet #8b6fc7`, `--color-glow-pink #ec4899`): the hero WebGL wash (`parts/gradient-field.tsx`, colors softened 55% toward white so it stays pastel) and the drifting page glow behind every page (`parts/ambient-glow.tsx`, blobs + a cursor-trailing glow).
- **Hero keywords**: `.text-gradient-trellis` (orange, `--color-brand-orange #ee7b3d`) for "Trellis" and `.text-gradient-near` (purple, `--color-brand-purple #b04fc7`) for "NEAR".
- **Status colors unchanged**: deliver green (success / APY), engagement gold (warning), lead-gen red (error), intelligence blue (info).
