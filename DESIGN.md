# Design

Visual system for Tempo. Light, warm, chess-native: a graphite analysis desk
rather than a dark instrument panel. One theme, locked (light).

## Identity

The product is **Tempo**, not "Tempo Chess". The mark is a rook drawn as a
single closed outline (`app/components/Logo.tsx`) with real piece anatomy:
three merlons, a collar, a flared plinth. It carries the accent; the wordmark
stays ink, so the lockup reads as one object. `RookMark` is the mark alone for
tight spaces and as a large graphic element; `Logo` is the lockup used by the
public nav, the product nav, the auth cards, and the footer.

> Superseded note: earlier drafts of this file described a dark, WHOOP-style
> palette. The product moved to the light graphite scheme below; the tokens here
> are the ones actually in `app/app.css`.

## Theme

Light only. Warm off-white paper ground, white panels, near-black graphite ink.
The energy lives in one orange accent and the semantic result colours; the
surfaces stay quiet.

## Color

Surfaces:
- `--color-bg`        `#f7f7f2` — app background (warm paper)
- `--color-surface`   `#ffffff` — panels, cards
- `--color-surface-2` `#eef0f2` — elevated / hover
- `--color-line`      `#d9dde2` — hairlines
- `--color-line-strong` `#aeb5bf`

Ink:
- `--color-ink`       `#292c32` — primary text
- `--color-ink-muted` `#5f6772` — secondary
- `--color-ink-faint` `#626b78` — labels, captions

Accent + semantics (one accent; data colours are semantic, not decorative):
- `--color-accent`     `#ff9600` — brand, primary action, "your move"
- `--color-accent-ink` `#211406` — text on accent
- `--color-signal`     `#1cb0f6` — informational highlight
- `--color-win`        `#58cc02` · `--color-loss` `#ff4b4b` · `--color-draw` `#a8b1bd`
- `--color-mistake`    `#ff9f2f` · `--color-inaccuracy` `#ffd45c`

Board: `--color-board-light` `#f7e6d2`, `--color-board-dark` `#f58a24`
(overridable per user in Settings → Board).

Meaning is never colour-only: results and severities also carry a letter, glyph,
or label.

## Typography

- UI: **Manrope Variable** (`--font-sans`) — one family for headings, labels, body.
- Numerals & data: **JetBrains Mono Variable** (`--font-mono`) — metrics, ratings,
  table figures, and the uppercase micro-labels (`.cap`, `.eyebrow`).
  `font-variant-numeric: tabular-nums`.
- Product pages use a fixed rem scale. Marketing pages use `clamp()` for display
  sizes only — headings scale, body text does not.
- Headings run heavy (800–880) with tight tracking (−0.03 to −0.045em).

## Depth

The one piece of visual personality: controls and panels sit on a hard offset
shadow rather than a blur (`box-shadow: 0 4px 0 <darker>`), and press down on
`:active`. It reads as physical without being cartoonish. Never combine it with
a second decorative shadow except on the hero panel and modals, where a wide
soft shadow is layered underneath.

## Shape scale (locked)

Panels/cards 14px (`--radius-panel`) · controls/inputs/badges 9px
(`--radius-control`) · pills/avatars 999px.

## Layout

Two shells, deliberately different:

- **Product shell** (`TopNav` + content): slim sticky bar with primary nav,
  settings, and the account menu. Max content width ~1160px. 8px spacing base.
- **Public shell** (`PublicShell.tsx`: `PublicNav` + `main` + `PublicFooter`):
  max width 72rem, generous vertical rhythm (5rem section padding), a four-column
  footer. Used by the landing, features, pricing, and legal pages.

Auth pages (`login`, `signup`, `account/connect`) use neither — a centred card
on the paper ground, so nothing competes with the form.

Responsive is structural: metric grids collapse to single column under 768px,
the public nav becomes a burger under 720px, tables become stacked rows.

## Components

Every interactive element ships default / hover / focus / active / disabled.
Loading = skeletons shaped like the content (never centred spinners). Empty
states teach ("connect an account", "analyse to unlock blunders").

Product:
- **Stat tile** — mono metric + label + optional delta (▲/▼ with semantic colour).
- **Ring / arc gauge** — single value 0–100, accent arc on a track.
- **Sparkline** — rating trend, 1px accent line, no axes chrome.
- **Record bar** — W/L/D as one proportional bar with counts.
- **Data table** — recent games; tabular-nums; result as a coloured letter chip.

Public (one layout family per section, never repeated):
- **Hero board** (`HeroBoard.tsx`) — a real position from a real game, drawn flat
  with the app's own Cburnett vectors. Flat because the pieces are 2D: faking
  depth under flat artwork makes them read as cut-outs. The board runs graphite
  (`#59616c`) and cream (`#ece4d6`), *not* the app's amber, so the accent keeps
  meaning "the engine's move" instead of decorating 32 squares. The mistake is a
  deep brick (`#b3382f`); the engine's move is the accent. Evaluations under it
  come from our own Stockfish and state their sign convention.
- **Statement band**, **numbered flow**, **asymmetric bento** (one accent cell
  carrying the rook as a large graphic), **definition list** for the
  anti-references. No page built from same-size icon-and-text cards.
- **Price card** — Pro carries the accent border and offset accent shadow plus a
  "Most useful" flag; features show ✓ / ✕ so inclusion is never colour-only.
- **Legal page** — 42rem measure, draft banner in `--color-mistake`.

### Public copy rules

- No em-dashes anywhere in visible text. Use a period, a comma, a colon, or
  parentheses.
- At most one tracked uppercase eyebrow per three sections. The headline is
  usually enough on its own.
- Never invent testimonials, user counts, rating gains, or engine numbers. Board
  positions and evaluations on the marketing pages are real and checkable.

## Voice

Sharp, candid, calm (see PRODUCT.md). On marketing pages that means concrete
claims over aspiration, and an explicit "what we don't do" section. Never invent
testimonials, user counts, or rating gains — the illustrative dashboard panel on
the landing page is labelled as such.

## Motion

150–250ms, ease-out. Conveys state only: count-up on metrics, arc draw on gauges,
fade/slide-in (8px) on first paint, the offset-shadow press on controls. No
page-load choreography beyond a single quiet reveal. Everything collapses under
`prefers-reduced-motion`.

## Accessibility

WCAG AA minimum. Skip links on both shells. Focus is always visible. Colour never
carries meaning alone. Keyboard-navigable throughout, including the board.
