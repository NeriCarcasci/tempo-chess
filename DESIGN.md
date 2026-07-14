# Design

Visual system for Tempo Chess. Dark, data-dense, calm — a serious instrument.
WHOOP-inspired: near-black surface, restrained palette, semantic data colors,
monospace numerals. One theme, locked (dark).

## Theme

Dark only (v1). Near-black neutral surface; the mood lives in the accent + the
data colors, not in the background. No pure black, no pure white.

## Color (OKLCH)

Surfaces (cool near-black neutral ramp):
- `--bg`         oklch(0.165 0.006 264)  — app background
- `--surface`    oklch(0.205 0.008 264)  — panels
- `--surface-2`  oklch(0.245 0.009 264)  — elevated / hover
- `--border`     oklch(0.30 0.010 264)   — hairlines
- `--border-strong` oklch(0.40 0.012 264)

Ink:
- `--ink`        oklch(0.965 0.003 264)  — primary text
- `--ink-muted`  oklch(0.74 0.012 264)   — secondary (AA on bg)
- `--ink-faint`  oklch(0.60 0.012 264)   — labels only (large/bold)

Accent + semantics (one accent; data colors are semantic, not decorative):
- `--accent`     oklch(0.82 0.17 152)    — emerald: brand + "good/best/win"
- `--accent-ink` oklch(0.22 0.04 152)    — text on accent
- `--good`       = accent
- `--inaccuracy` oklch(0.84 0.14 92)     — amber
- `--mistake`    oklch(0.75 0.16 55)     — orange
- `--blunder`    oklch(0.64 0.20 25)     — red (also "loss")
- `--info`       oklch(0.72 0.13 236)    — blue (neutral data / draw)

Meaning is never color-only: results/severities also carry a letter or shape.

## Typography

- UI: **Manrope Variable** (`--font-sans`) — clean grotesque, one family for
  headings/labels/body.
- Numerals & data: **JetBrains Mono Variable** (`--font-mono`) — all metrics,
  ratings, table figures. `font-variant-numeric: tabular-nums`.
- Fixed rem scale (product register), ratio ~1.2. Not fluid/clamp.
  - display 2rem/1.75rem (big metrics), h1 1.375, h2 1.125, body 0.9375,
    label 0.75 (uppercase, tracked +0.04em), micro 0.6875.

## Layout

- App shell: slim top bar + scrolling content. Max content width ~1200px.
- 8px spacing base. Generous vertical rhythm between sections (48–64px), tight
  within data groups.
- Panels: hairline border + `--surface`, radius per shape scale. Group with
  space and dividers before reaching for a card; never nest cards.
- Responsive is structural: multi-column metric grids collapse to single column
  under 768px; tables become stacked rows.

## Shape scale (locked)

- Panels/cards: 14px · Controls/inputs/badges: 9px · Pills/avatars: 999px.

## Components

Every interactive element ships default / hover / focus / active / disabled.
Loading = skeletons shaped like the content (never centered spinners). Empty
states teach ("connect an account", "analyze to unlock blunders").

- **Stat tile**: mono metric + label + optional delta (▲/▼ with semantic color).
- **Ring / arc gauge**: single value 0–100, accent arc on a track; draws on load.
- **Sparkline**: rating trend, 1px accent line, no axes chrome.
- **Record bar**: W/L/D as one proportional bar (green/red/blue) with counts.
- **Format row**: per-speed rating + game count + progress delta.
- **Data table**: recent games; tabular-nums; result as colored letter chip.

## Motion

150–250ms, ease-out. Conveys state only: count-up on metrics, arc draw on gauges,
fade/slide-in (8px) on first paint. No page-load choreography beyond a single
quiet reveal. Everything collapses under `prefers-reduced-motion`.
