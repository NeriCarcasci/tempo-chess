# Plan: the opening tear sheet — the new `/openings` centrepiece

Self-contained implementation plan. Everything below was locked in design
conversation; where a value is marked *tunable*, pick the stated default and
make it a named constant.

## What this is

A heat grid of the player's opening skill: **rows are their repertoire lines,
columns are their own move number, cells are engine-scored decisions**. One
orange marker on the whole sheet says "start here". Clicking a cell docks a
detail panel below the sheet with the real position(s) behind it and a
"Walk this line" hand-off into the existing explorer. It replaces the current
family-picking UI at the top of `/openings` as the page's organizing
instrument — the sheet is how you choose what to look at.

The one-sentence reading the component must produce: *"You're fine for five
moves in the Sicilian, shaky at six, and move seven is where it tears."*

## Locked definitions

### Sections and rows

- Two sections: **"As White"** and **"As Black"** — never a family split by
  color inside one row. As White, rows are the opponent's replies you must
  face (`vs Sicilian`, `vs French`, `vs 1...e5`); as Black, rows are the
  player's defenses (`your Caro-Kann`, `vs 1.d4`).
- A row is an opening **family** (use `app/lib/openingFamily.ts` for the
  mapping — both platforms' naming styles are already handled there).
- Rows sort by games descending within their section. Families below
  2 games fold into one quiet `other` row per section (collapsed, like the
  results chart's Other row).

### Columns

- Column = **the player's own move number** (not ply). In per-color data:
  White decides at even plies (`moveNo = ply/2 + 1`), Black at odd plies
  (`moveNo = (ply+1)/2`).
- Show columns 1..min(12, deepest scored move across rows), minimum 8.

### Cells

A cell pools all engine-scored decisions at (row family, move №). Graph
nodes/edges already carry these as `o`/`op` (scored player decisions) and
`f`/`fa` (costly ones).

| State | Definition | Rendering |
|---|---|---|
| scored | ≥ `FLOOR_COLOR` (5) decisions | colored: holds / shaky / tears |
| thin | 1–4 decisions | pale neutral — never colored, whatever happened |
| past your book | 0 decisions at that depth | dashed blank |
| before this line | column earlier than where the family is identifiable (e.g. `vs Sicilian` starts at White's move 2) | empty space — nothing rendered. Dashes mean "past your book" and only ever appear at the right edge |

Color thresholds by failure rate (`fa/op`), *tunable*: tears ≥ 0.25,
shaky ≥ 0.12, holds below. The right edge where a row fades to dashes is
itself a finding ("your book ends here") — no extra chrome for it, the
fade is the statement.

### Variations

- Family rows are collapsed by default. Clicking the row label unfolds
  variation sub-rows (deepest *named* ancestor beyond the family — from
  node `nm` / edge `lb`, variation = text after the colon, else the label).
- Decisions in the family subtree that never pass a variation-named node
  pool into an **"early deviations"** sub-row.
- **Aggregation rule:** the family cell's *color* pools all decisions at
  that depth (true aggregate experience). The **marker** is computed at
  variation level, so a torn 10-game Najdorf can't be diluted away by a
  solid 50-game Dragon.

### The marker

Exactly **one** "start here" marker on the entire sheet (both sections).
Among variation-level cells (family-level where no variation qualifies)
with ≥ `FLOOR_COLOR` decisions: highest failure count, tie-break by failure
rate. Accent color, small pulse, `prefers-reduced-motion` guarded. The
accent appears nowhere else on the sheet.

## Data plumbing

The explorer payload (`GET /opening-explorer`, ships `OpeningExplorerData`
incl. the compact `graph`: see `app/lib/openings.ts` interfaces
`OpeningGraph{,Node,Edge}`) pools the player's games of **both colors**, which
makes clean color sections impossible client-side (`ac: "m"` edges are
irreducibly ambiguous).

**Required server change — per-color graphs:**

1. Read `server/src/openings/service.ts`. The explorer supports `filters`
   (e.g. `graph?: "0"|"1"`); the pipeline rows carry `player_color`.
2. Add a `color?: "white" | "black"` filter that restricts the game set
   feeding the tree/graph build before aggregation. Default (absent) keeps
   today's pooled behavior.
3. Include `color` in the response-cache key (there is a per-user explorer
   cache — see the cache-busting comment around "The graph changed").
4. Client fetches the two graphs for the sheet:
   `/opening-explorer?username=…&color=white` and `…&color=black`.
   The pooled fetch the page already does stays as-is for the explorer
   below. Respect `app/lib/loaderCache.ts` conventions.

Do **not** attempt the pooled-graph + `ac` heuristic; it was evaluated and
rejected.

## Derivation function

New file `app/lib/tearSheet.ts`, pure, no React:

```ts
deriveTearSheet(white: OpeningGraph | null, black: OpeningGraph | null): TearSheet

interface TearSheet {
  sections: Array<{ color: "white" | "black"; rows: SheetRow[] }>;
  marker: { rowKey: string; variation: string | null; moveNo: number; nodeKeys: string[] } | null;
  maxMove: number;
}
interface SheetRow {
  key: string;            // `${color}:${family}`
  family: string;         // display name from openingFamily
  label: string;          // "vs Sicilian" (White) / "your Caro-Kann" (Black)
  games: number;
  startMove: number;      // first column where this family is identifiable
  bookDepth: number;      // last move № with any scored decision
  cells: SheetCell[];     // indexed by moveNo
  variations: SheetVariationRow[];  // same shape, plus "early deviations"
}
interface SheetCell {
  moveNo: number;
  decisions: number;      // Σ op
  failures: number;       // Σ fa
  state: "scored" | "thin" | "blank" | "pre";
  heat?: "holds" | "shaky" | "tears";
  nodeKeys: string[];     // positions behind the cell, sorted by failures desc, cap 3
}
```

Algorithm (per color graph): BFS from `graph.root` carrying
`(familyDisplay | null, variationName | null)` down the tree — a node's `nm`
updates them via `openingFamily()`. For each edge with `op > 0`, compute the
mover's `moveNo` from the parent node's ply; bucket `(family, variation,
moveNo) += {op, fa}` and record the parent node key. Nodes with `x = 1`
(transpositions) are already canonical — no special handling. Decisions
before any family is known are dropped (that's the `pre` region; note the
limitation in a comment — exact per-game attribution would need
`player_opening_observations` and is a follow-up, not v1).

**Test first.** The repo has no app-side test runner; follow the existing
pattern used for `openingFamily` (a small `node`-run script against a
hand-built fixture graph — the one in git history at
`app/routes/__preview-dense.tsx` is a good starting fixture). Assert: row
partitioning per color, `startMove` for a move-2 family, thin vs scored vs
blank states, early-deviations bucketing, marker lands on the fixture's
worst variation cell, and the dilution case (solid big variation + torn
small one → family cell pooled color, marker still fires).

## Component

New `app/components/TearSheet.tsx` + styles in `app/app.css`
(`@layer components`, prefix `.sheet-`).

Layout (desktop): section label ("As White · you open 1.e4" — derive the
"you open X" suffix from the section's dominant first move), then the grid:
`[label 150px] [cells…] [games count]`. Column header row "your move №"
with numerals. Legend once, under the sheet: holds / shaky / tears /
"you've never been this deep". Sheet horizontally scrolls inside its own
box on narrow screens (reuse the `.activity-scroll` pattern — the page must
never scroll sideways).

Visual language (must match the app's existing system):

- Elevation over borders; no gradients anywhere; `--radius-*` tokens.
- Heat colors from the existing semantic pair — holds =
  `color-mix(win 30%, surface-2)`, shaky = `color-mix(loss 30%, surface-2)`
  warmed toward neutral, tears = `color-mix(loss 85%, surface-2)`. If shaky
  reads as "already bad" next to tears, fall back to an amber mix — judge by
  eye in the browser, not in code review.
- Accent **only** on the marker and its "start here" pill.
- No uppercase mono tag-labels, no kicker chips; plain sentences.
- Cells stagger-fade on first paint (the activity-grid intro pattern);
  row unfold animates height; everything guarded by reduced-motion.

Interactions:

- Click family label → unfold variation sub-rows (chevron rotates).
- Click any scored/thin cell → **detail panel docks below the sheet** (same
  page, no navigation): title ("vs Sicilian — your 7th move"), up to 3
  positions as small `Board`s (node `k` is a FEN prefix `board turn castling
  ep` — verify `Board` renders it; append `" 0 1"` if it needs a full FEN),
  the evidence sentence ("12 decisions here, 5 cost you the thread"), and
  actions: **Walk this line** → the existing explorer deep-link
  (`?family=…&node=…`, same shape the dashboard already builds) and
  **Drill it** when a drill exists for the node (check how
  `opening_drills` surfaces client-side; omit the button if not wired).
- Selected cell gets a quiet ring; URL reflects selection
  (`?row=…&move=…`) so it's deep-linkable and back-button-native.
- Keyboard: cells are buttons; arrow keys move between cells in a row.

States:

- Both graphs empty / player below ~20 games → keep the page's existing
  thin-account handling; the sheet renders as a skeleton with the line
  "your first rows appear after about 10 games". Never render a sheet that
  is 100% fog.
- A section with no rows (player never has that color… rare) → omit the
  section, no placeholder.

## Integration

- `/openings` (`app/routes/openings.tsx`): read the current structure first.
  The sheet replaces the family-selection/overview UI as the top-of-page
  instrument; the existing node explorer/line views remain below/behind the
  "Walk this line" hand-off. Loader gains the two per-color fetches.
- Dashboard is **out of scope** — do not touch its lead. (Follow-up, not
  now: a condensed sheet replaces `OpeningMap`, which the tear sheet
  supersedes conceptually.)
- Nothing on the public site changes.

## Verification checklist

1. Derivation script passes on the fixture graph (all assertions above).
2. `npx tsc --noEmit` clean; server typecheck clean.
3. Temporary preview route (pattern: `app/routes/__preview-dense.tsx` +
   entry in `app/routes.ts` — **delete both before finishing**) rendering
   dense, thin, and no-graph states.
4. In the browser (`preview_start` name "tempo", app at :5173, API :8787):
   walk a cell → dock fills; unfold variations; marker pulses; exactly one
   marker across both sections; deep-link URL restores selection.
5. 375px: page has no horizontal scroll; the sheet scrolls inside its box.
6. Real data: `/openings` for the signed-in account renders with the real
   API (the color filter working end-to-end).
7. Do not commit or deploy without being asked.

## Out of scope (explicitly)

Middlegame habit file, endgame conversion board, O/M/E shape + percentile
bands, phase segmentation pipeline, rewards/ledger, dashboard condensed
sheet, per-game `pre`-region attribution.
