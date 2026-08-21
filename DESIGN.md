# Design

Visual system for Forma. Light, warm, chess-native: a graphite analysis desk
rather than a dark instrument panel. One theme, locked (light).

## Identity

The product is **Forma**. The name means "shape" or "form" in Italian and Latin,
and gives the hero line — "Your mistakes have a shape" — its organising idea.
The mark is a rook drawn as a
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

Surfaces (page is warm neutral, panels are pure white; the gap between the
two is what makes a card legible, so cards are not outlined):
- `--color-bg`        `#f4f2ee` — app + marketing background
- `--color-surface`   `#ffffff` — panels, cards
- `--color-surface-2` `#efece6` — recessed wells, inputs, hover
- `--color-surface-3` `#e6e2da` — pressed
- `--color-ink-block` `#1d1b19` — full-bleed inversion blocks
- `--color-line`      `#e8e4dc` — hairlines, for real edges only
- `--color-line-strong` `#c6c0b4`

Ink:
- `--color-ink`       `#23211d` — primary text
- `--color-ink-muted` `#5f5a52` — secondary
- `--color-ink-faint` `#8a847a` — labels, captions

Accent + semantics (one accent; data colours are semantic, not decorative):
- `--color-accent`      `#cf5730` — brand, primary action, "your move"
- `--color-accent-ink`  `#fffaf6` — text on accent
- `--color-accent-wash` `#fbe9e1` — active nav chip, toggled control
- `--color-signal`      `#277c86` — informational highlight
- `--color-win` `#2f7a61` · `--color-loss` `#b64d4d` · `--color-draw` `#929891`
- `--color-mistake` `#bd793b` · `--color-inaccuracy` `#c6a24f`

There is no decorative palette. A set of flat pastels (mint, sky, butter,
blush) lived here for one revision and has been removed: four extra hues beside
one accent meant the page carried five colours and only one of them meant
anything, and the pastel blocks read as a softer, different product than the
warm paper and ink around them. **Two things may be coloured — the accent, and
a semantic result.** Anything that needs telling apart from its neighbour uses a
surface or a shadow, not a new hue.

Board: `--color-board-light` `#e9e2d4`, `--color-board-dark` `#65716f`
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
- Headings run at 620–680 with tracking no tighter than −0.03em. Size and
  measure carry the emphasis; weight above 700 at display size reads as
  shouting and fights the quiet surfaces.

## Depth

Separation comes from elevation, never from a drawn rule. One ladder for the
whole product, each level pairing a soft shadow with a 1px ring in the same
ink, so an element reads as lifted off the page rather than outlined on it:

- `--shadow-flat` — inputs, dense rows
- `--shadow-soft` — cards, chips, the default panel
- `--shadow-lift` — hover, primary panels
- `--shadow-float` — the hero board, callouts, modals

The ring *is* the border. Never set `border: 1px` on something that already
carries one of these; the two stack into a harder edge than either intends.

The one hard edge left is `--shadow-key` on buttons: a bottom edge *inside*
the shape, pressing to `--shadow-key-down` on `:active`. It survives on a pill
and leaves nothing hard-edged sitting on the background.

**If you reach for a 1px border to separate two things, use space, a surface
change, or space instead.** Borders are for real edges only: fields,
and rows in dense data tables. Everything else on the public site is separated
by air, or by the surface it sits on.

## Vertical rhythm

`.public-shell` sets the step every public section spaces itself by:

- `--section-y` `clamp(7rem, 13vw, 13rem)` — the default gap between sections
- `--section-y-lg` `clamp(9rem, 17vw, 17rem)` — after the two beats that need
  to land on their own: the statement, and the closer before the footer

Sections carry their gap as `padding-bottom` only, so the space between any two
is one value rather than a collision of two. With no rules left on the page,
this standing space is the only thing saying "a new idea starts here", so it is
deliberately far larger than mere separation would need — each beat gets most
of a screen to itself, and the landing is read by scrolling through it rather
than taken in as one dense block.

## Shape scale (locked)

Full-bleed blocks and feature cards 28px (`--radius-xl`) · panels/cards 18px
(`--radius-panel`) · controls, inputs, wells 11px (`--radius-control`) ·
buttons, nav chips, badges, avatars 999px (`--radius-pill`).

## Layout

Two shells, deliberately different:

- **Product shell** (`TopNav` + content): slim sticky bar with primary nav,
  settings, and the account menu. Max content width ~1160px. 8px spacing base.
- **Public shell** (`PublicShell.tsx`: `PublicNav` + `main` + `PublicFooter`):
  max width 74rem, vertical rhythm from `--section-y` (see above), a four-column
  footer on a white surface with a rounded shoulder. Used by the landing, features, pricing, and legal pages.

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
- **Line row** (`TearSheet.tsx`) — the `/openings` page is a list of these and
  nothing else. One repertoire line per row: its name, a **move strip** of its
  own move numbers on the heat ramp, the count in a fixed two-part shape
  ("16 mistakes" over "from move 10"), and a Practice control. Rows sort worst
  first, with the marked line pinned to the top, so reading down the page is
  reading a to-do list.

  **The count is always the same two facts in the same shape**, so only the
  numbers change down the page. It replaced four different sentence forms
  ("Tears at move 5", "holds to move 4", "Show 1 quieter line") which between
  them ran three unrelated metaphors — fabric, walking, volume — and invented a
  private vocabulary for things chess already names. See the vocabulary rule in
  the component header: **never invent a word for something chess already
  names, and never write a sentence where a measurement will do.** A `failure`
  in the model is a move Forma's published analysis judged outside the
  versioned tolerance, which is a *mistake*, so the page says mistake and
  states the threshold it was counted by.

  **A fourth square state: unjudged.** A move played in a game nothing has
  analysed is drawn hatched, off the heat ramp. Blank would say the player
  never went that deep and a colour would put a failure rate on a sample of
  zero, so it gets its own mark, and a row where nothing is judged says "Not
  analysed yet" instead of "No mistakes". The account-wide figure — how many of
  the player's opening moves have been analysed against how many they played —
  is stated once, under the key, because it is the denominator behind every
  number above it.

  **Exactly one Practice button is accented at a time** — the marked line's.
  Every other row carries the same control in the same slot as a quiet ghost
  pill that fills on approach. The action is never hidden behind the
  disclosure, and the page is never a column of orange buttons. That is the one
  gamification device here: an active node and a quiet path, in the sense
  Duolingo means it and not in the sense PRODUCT.md's anti-reference refuses.
  No badges, no streaks, no coins, no confetti.

  Practice goes to `/train`, which is not a `/v1` surface: it builds its lines
  from the prototype opening graph and therefore selects them by the older
  90-centipawn rule. The sheet says so, once under the key and again in the
  control's accessible name, because a reader who tabs to the button never
  passes the note. Silently handing somebody from a number counted one way into
  a drill chosen another way is the exact confusion the threshold line exists
  to prevent. `/v1` has a practice queue, an attempt and a refill and none of
  them takes an opening, so there is nothing yet to repoint it at; when there
  is, the note goes and nothing else about the row changes.

  **A written lesson, when one exists, sits in the open panel** beside "Walk
  this line" — not in the row header. Thirteen openings have authored prose and
  the rest do not, and a control that appears on some rows and not others turns
  the header from something you scan into something you read.

  **The book sits inside the open row.** Under the strip and the boards: what
  the line is called and its ECO code, the catalogue's moves from the selected
  square with how often the player takes each, and the move where the player's
  own line left the book. The sheet says which square costs the most; the book
  is what there is to study about it, and putting it a click away would leave
  the page as a diagnosis with no treatment in reach. It is fetched when a row
  opens, never per row on the list.

  The strip is a **picture when the row is closed and an instrument when it is
  open**: presentational spans become buttons, grow, and take move numbers on
  hover. Everything at one altitude is what made the previous version read as a
  spreadsheet. Opening a row also recesses its header strip, so the summary and
  the instrument are not the same picture twice at full strength.

  Counts step by **weight and value, never by hue**. Severity is already
  carried by the ramp beside them, and the accent on this page means "the
  action". Nothing in the row is coloured except the strip and the one live
  button.
- **Today** (`Today.tsx`) — the product's home, and the one page with a point
  of view. It opens on a **conclusion as its heading** ("5 mistakes at move 11
  of your London System"), not on the word "Today": the nav already says where
  you are, so spending the largest type on repeating it buys furniture. The
  measurement *is* the headline, which is the strongest thing this product can
  say and the only thing that has earned that size.

  Under it: one line of support, the line's own move strip, and **exactly one
  primary action**. Then a "Then" list of at most three quiet rows, each a real
  destination with a measured reason to be there, each using the same ghost
  pill as the openings rows so a column of buttons never competes with the
  action above. A row that cannot state its reason does not render.

  The strip and the boards are the same components the openings page uses.
  Diagnosis and practice look like one instrument because they are drawn from
  one set of parts.

  It replaced a dashboard of five panels — a superseded opening map, ratings,
  recent games, an activity calendar, an engine read — none of which named a
  decision. That is PRODUCT.md's third principle ("every number earns its
  place") applied to a whole page rather than to a tile.

  **It reads `/v1` and nothing else**: the opening explorer for the shape and
  the lead, `/v1/games/recent` for the last game, `/v1/onboarding` for where
  the examination stands. A one-line standing figure — rating, lifetime record,
  games read — used to sit above the heading and came from the prototype API,
  which counts tables the pipeline stopped writing. There is no `/v1` source
  for any of the three, so an `EmptyState` from `Honesty.tsx` says so, under
  the heading rather than above it, and the page still opens on its conclusion.
  Same for the import control the "Then" list used to offer: `/v1` has no
  importer, because games arrive with an examination run.

  The threshold drift is over. Today and `/openings` both read
  `GET /v1/openings/explorer` and both count a mistake against the canonical
  tolerance — 0.02 of expected score against the best line the same search
  found. Each still states that threshold under its own figure: a stated
  measurement is worth keeping even when there is no longer a second one to
  tell it apart from.

The landing is exactly six beats: hero, statement, scale, showcase, beta note,
closer.
There was a sixth ("What Forma will not do", three pastel tiles) and it is gone:
the refusals were already implied by everything the product does show.

Public (one layout family per section, never repeated):
- **Hero board** (`HeroBoard.tsx`) — a real position from a real game, drawn flat
  with the app's own Cburnett vectors. Flat because the pieces are 2D: faking
  depth under flat artwork makes them read as cut-outs. The board runs graphite
  (`#59616c`) and cream (`#ece4d6`), *not* the app's amber, so the accent keeps
  meaning "the engine's move" instead of decorating 32 squares. The mistake is a
  deep brick (`#b3382f`); the engine's move is the accent. Evaluations under it
  come from our own Stockfish and state their sign convention.
- **Statement** — bare centred type on the page ground at a 52rem measure, with
  `--section-y-lg` under it. No band, no panel, no inversion: it was tried as
  all three, and each was a container doing a job that scale and standing space
  do better. It is the one place on the landing with nothing around it, which
  is what makes a reader slow down for it.
- **Scale band** (`Scale.tsx`) — the count and the way in, directly under the
  statement, because the claim above it ("we read your whole history") is only
  worth anything at volume. **The one inverted block on the site**: everything
  either side is warm paper and white cards, so running this dark is what
  separates it, with a change of ground rather than more structure.

  Compact and wordless at the top. Two figures, one line, one button — an
  earlier version opened with a heading restating the numbers in prose, which is
  exactly the sentence a reader skips. The figures are the headline; the `<h2>`
  survives for the accessible name only.

  The accounts are the background: the handles the figures count, on four rows
  drifting behind the numbers, each badged with the platform it came from. Each
  row is rendered twice and travels exactly `-50%`, which is what makes the loop
  seamless — at the end of a lap the second copy sits where the first began, so
  there is no jump to hide. Rows alternate direction and run on prime-ish
  durations (67/78/97/109s) so they never re-sync into a conveyor belt. Opacity
  per handle is hashed from the handle, never random, so the background does not
  reshuffle on re-render.

  The API returns those accounts *from the same join that produces the count*,
  so the wash and the figures on top of it cannot disagree — that is the entire
  argument for showing accounts instead of only a number. It renders nothing at
  all when the API is unreachable or the figure is below the threshold. The
  reveal carries a four-second failsafe, and the roll-up a settle timeout:
  a reveal that never fires hides a number, but a roll-up that never fires
  *displays the wrong one*.
- **Beta sheet** (`BetaForm.tsx`) — a real `<dialog>`, so focus trapping,
  Escape, the top layer and inert-ing the page come from the platform. Name,
  email and platform are required; rating is one tap and the rest is optional,
  because every field past the email address costs signups. A bottom sheet under
  720px.
- **Showcase** (`Showcase.tsx`) — where the games come from, the shape they
  make, and the openings underneath that shape: Connect, Patterns, Openings. The
  last two come from `Scenes.tsx`. Each scene sits in a recessed well on the same
  warm ground — they were three different pastels for one revision; the cards are
  told apart by what is *in* them, which is the only difference that carries
  meaning. Connect's well takes 5% accent because the mark sits on its edge and
  the two should read as one object.
- **Price card** — Pro carries an inset accent ring plus a "Most useful" flag; features show ✓ / ✕ so inclusion is never colour-only.
- **Board arrow** (`Showcase.tsx`) — derived from the two squares, never from
  hand-placed coordinates. Head about a third of a square, shaft under a sixth,
  butt cap so the shaft meets the head base flat. **Arrows paint under the
  pieces**, on both boards: an arrow over a knight looks stuck to the screen, the
  same arrow passing behind it looks drawn on the board. That is DOM order, not
  z-index, and it is why the arrows no longer need to be faded out to keep a
  piece readable.
- **Move** (`Move.tsx`) — algebraic with the piece drawn instead of spelled.
  `Nxe6` reads as a knight to anyone who already plays and as a typo to everyone
  else; the glyph costs the first group nothing and gives the second something to
  recognise. Same Cburnett vectors as the board, so the page never looks like two
  products. Pawn moves get no glyph, because there is nothing to name — and the
  colour is a required prop, since a white knight on a black move is exactly the
  detail this audience checks.
- **Hero callout** (`HeroBoard.tsx`) — seated *into* the board's bottom-right
  corner rather than floating on it. Two outer edges flush with the board's, so
  only the two inner corners are rounded and the outer one takes the board's own
  radius; the shadow reaches only up and left, where the panel actually lifts off
  the squares. The board clips it either way, which is what guarantees the corner
  can never disagree.
- **Scenes** (`Scenes.tsx`) — the diagrams, shared by the home showcase and the
  features page, so the same idea is never illustrated two different ways.

  **A section is a piece, a title, one line, and a picture.** No numbers (an
  ascending pawn/knight/bishop counts just as well and belongs to this product),
  no bullet lists, and **no captions** — a diagram that needs a sentence
  underneath explaining what it is has not been drawn well enough.

  They are diagrams, not screenshots and not invented data dressed as real:
  every opening, position and move in them is real chess. The rule from the
  landing page holds — if a number would read as a claim about us, it does not
  go in a picture. The Scale band is the only place we quote our own figures,
  and it counts rows.

  The pattern grid is a hand-written intensity array, so the clustering is
  deliberate and the picture is identical in every review, and its ramp runs
  past the accent into ink at the top end so the busiest squares actually read
  as the darkest.

  Its family label is type and space, not a box: a dark pill there was the only
  dark thing in the card and it fought the stack under it for attention, which
  is backwards — the stack is the answer and the label is just its name. The
  figure beside it is **mastery**, the 0–100 score `calculateMastery` actually
  produces. It is not a percentile: the product does not rank you against other
  players, so a "top N%" would be advertising something that does not exist.

  **Openings is a stack, not a tree.** Three dashed curves fanning out of a box
  was decoration pretending to be information. Overlapping the rows says the
  same thing — these belong to that — and buys depth for nothing. Worst line on
  top and in focus, the two you are fine in behind it, inset and faded: visible,
  but not competing with the one that is costing you. That ordering is the
  product's own rule, drawn.

  Scenes render both on white (features) and in a tinted well (the home
  showcase). The handful of differences that second ground needs live in their
  own block beside the showcase rules, **not inside the scene rules**.

  > **Editing note.** The scene rules are a run of adjacent blocks, and twice
  > now a rewrite of one block has silently swallowed the block after it — first
  > the showcase-well overrides, then the whole evaluation-bar scene, both of
  > which fail *invisibly* (a diagram sitting in the wrong half of its well; a
  > row of bars that renders as bare text). When replacing a block here, replace
  > it by its own boundaries, not by "from this comment to the next one", and
  > check the scene *after* the one you edited.

  The evaluations in `EngineScene` are measured, not typed: every one of Black's
  plies from the hero game, run through `analyzeFens(fens, 18)`. At 7...h6 the
  engine's own best move comes back as `g5e6` — the capture the hero callout
  names, which is why the two agree.
- **Archive hero** (`ArchiveHero`) — the features page opens on the archive
  itself: 330 cells across the full width, fading out at the bottom so it reads
  as a history that continues rather than a chart that ends. Generated, because
  a few hundred cells is too many to author by hand, but generated
  *deterministically* from a fixed seed — plus two slow sine terms, which is
  what makes bad patches arrive in runs instead of scattering evenly. Auto-fill
  columns, so the cells keep their size and the row count adapts from a phone to
  a wide monitor with no breakpoint deciding how many fit.
- **Feature sections** (`features.tsx`) — **what you can do, in the order you
  would do it**: connect, look, understand, practise, rehearse. Every section is
  a surface that exists — the opening explorer, the game review, the drill
  queue, the repertoire trainer — not a capability written for a marketing page.
  An earlier version listed four abstractions ("Stockfish on every move",
  "Explained in words") that described the machinery rather than anything a
  reader could go and do. If a section cannot be pointed at a route in
  `app/routes`, it does not belong on this page.

  Alternating which side the diagram falls on. It was the same row three times, heading left and white boxes right,
  which reads as a form rather than a page.

  The alternation is a class from the map index, **not `:nth-child`** — the page
  header is a sibling, so nth-child counts from the wrong parity and inverts the
  whole page the moment anything is added above the list. It reorders *and*
  swaps the track sizes: reordering alone moves the diagram into the narrow
  column, so every flipped section quietly gave its picture less room. And it
  reorders rather than re-sources, so the copy stays first in the DOM.
- **Legal page** — 42rem measure, draft banner in `--color-mistake`.

### Public copy rules

- No em-dashes anywhere in visible text. Use a period, a comma, a colon, or
  parentheses.
- **No label above a heading on the public site.** No kickers, no tracked
  uppercase eyebrows, no "HOW IT WORKS" / "THE REFUSALS" / "LEGAL" chips. A
  label that restates the heading under it adds a line of furniture and no
  information, and it is the single fastest way to make a page read as
  generated. The heading and the space around it do the job. (Product pages
  keep `.eyebrow` where it is genuine context — "Kasparov · lesson" — not
  decoration.)
- Never invent testimonials, user counts, rating gains, or engine numbers. Board
  positions and evaluations on the marketing pages are real and checkable.
- Reach figures are counted, with exactly one documented exception: the games
  baseline in `server/src/players/reach.ts`, which restores work the pipeline
  genuinely did before the database was reset. It is a restoration, not a
  decoration. The endpoint returns `counted` and `baseline` separately so the
  split stays auditable, and the only number allowed in that constant is one we
  can vouch for. If you cannot say where a figure came from, it goes to zero.
- **The players baseline is zero and should stay zero.** It was briefly non-zero;
  the fix was not a better constant but `npm run cohort -- --players=N --games=3`,
  which screens real public Lichess archives until the number is true. That is
  how the current 27 got there, and it is how the next figure should. Prefer doing the work to
  asserting the figure — and note that listing the handles on the landing page
  is only possible because the work was done. You cannot name the members of a
  number you made up, which is the useful discipline here.
- Handles shown in the Scale wash are public Lichess usernames, harvested from
  public arena results, whose public archives we screened through the same API
  the site's own export button uses. Nothing private, nothing inferred, and no
  claim that any of them endorse Forma — the copy says we read their games,
  because that is all that happened.
- Any figure about our own reach is counted, never typed. It comes from
  `/stats/reach`. If the count is unavailable the Scale section does not render;
  there is no fallback constant to go stale. A "player" there means a distinct
  platform account whose games we have screened, which is why the copy never
  says "users".
- `app/lib/reviews.ts` holds only messages real testers actually sent and agreed
  to have shown, in their wording. It currently has **no surface rendering it** —
  the beta panel that hosted it was removed, on the grounds that the counter
  says how early this is more credibly than a paragraph admitting it. Give it a
  home before using it again; do not add stand-ins.

## Voice

Sharp, candid, calm (see PRODUCT.md). On marketing pages that means concrete
claims over aspiration, and an explicit "what we don't do" section. Never invent
testimonials, user counts, or rating gains — the illustrative dashboard panel on
the landing page is labelled as such.

## Motion

Motion is part of the system, not a garnish we tolerate. It should feel
engineered: exponential ease-out (`cubic-bezier(0.16, 1, 0.3, 1)`), 150–250ms for
state changes, 600–750ms for reveals, and never a bounce.

Every animation has to name its job. The ones we ship:

- **Scroll reveal** on the showcase cards (opacity + 18px rise), driven by
  IntersectionObserver. Job: sequence, so each scene lands as its own beat.
- **Hero entrance** on the board, and the callout arriving just behind it. Job:
  hierarchy, so the position is read before the verdict.
- **Evaluation bars** growing to their real value on entry, staggered 90ms.
  Job: the value *is* the animation, so a growing bar is the measurement.
- **Flowing dashes** along the connect wires. Job: shows games moving from the
  platform into Forma, which is the thing that step describes.
- **Key press** on buttons: 1px translate plus the bottom edge collapsing
  from `--shadow-key` to `--shadow-key-down`. Job: feedback.

What we still refuse: infinite loops on anything that is not depicting flow,
parallax, scroll hijacking, entrance animations repeated identically on every
section, and motion that delays reading.

`prefers-reduced-motion: reduce` disables all of it, and every animated element
must be fully legible in its final state without the animation ever running.
Animate `transform` and `opacity` first; `stroke-dashoffset`, `clip-path`, and
`filter` are available when they stay smooth.

## Accessibility

WCAG AA minimum. Skip links on both shells. Focus is always visible. Colour never
carries meaning alone. Keyboard-navigable throughout, including the board.
