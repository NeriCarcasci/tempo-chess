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
- `--color-ink-faint` `#736d64` — labels, captions

Accent + semantics (one accent; data colours are semantic, not decorative):
- `--color-accent`      `#b8441d` — brand, primary action, "your move"
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

**Every token above clears WCAG AA at the size it is used.** Two of them did
not, and both were load-bearing: `--color-ink-faint` at `#8a847a` measured
3.32:1 on the paper ground, and it is the token every caption, unit and sample
count on the product uses; `--color-accent` at `#cf5730` put white button text
at 4.00:1 and accent-as-text at 3.71. A palette that fails at the two values
used most often is not a palette with an accessibility gap, it is a palette
that does not work. `--color-inaccuracy` is the one tone light enough that
light text cannot sit on it, so the chip that uses it takes ink instead.

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
and leaves nothing hard-edged sitting on the background. **A tile that goes
somewhere is a control**, so navigation tiles (the phase strip, the task
rows) carry a quieter cut of the same edge and press the same way — the
tactility is one system, not a per-surface effect.

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
- **Sparkline** — rating trend, 1px accent line, no axes chrome.
- **Record bar** — W/L/D as one proportional bar with counts.
- **Data table** — recent games; tabular-nums; result as a coloured letter chip.
- **The instruments** (`instruments.tsx`) — small marks that each draw one
  published figure, shared by the hub and the phase pages so the same quantity
  is never drawn two different ways. Every number they draw arrived on the
  wire; the only arithmetic is geometry, and an interval is always drawn on
  the full scale it is a share of, never scaled to its own width.
  - **Gauge** — the arc gauge, finally built: one rate on an accent arc with
    the interval as a quieter arc on the same track, the figure in the middle
    in the numeral face, the label under it saying what the figure is of. The
    value growing to its size is the one animation, and reduced motion gets
    the final state outright.
  - **Dial** — the hub's own mark; see [The hub](#the-hub). Arc for the rate
    and its interval, filled disc for the movement, mark knocked out of the
    disc, and the three are never mixed.
  - **Ring** (`Donut`) — the way a share is drawn anywhere it is not the
    page's hero figure: a closed accent ring with its figure at the centre.
    It replaced a filling bar, and the reason is the idea each mark carries.
    A track that fills is a thing waiting to finish, which is exactly wrong
    for a standing measurement; cutting that track into cells changed its
    texture and not its meaning. A ring is a proportion of a whole. On the
    hub it carries the phase rates at 104px; on a stack row it shrinks to
    40px and takes the row's rank inside it, so two marks become one.
  - **A filling track means work, never a measurement.** This is the line the
    ring drew, and it settles where each mark belongs: a bar that fills is a
    thing waiting to finish, so it is right for the examination bar and the
    sync steps, where something really is running and will end. A standing
    figure — a rate, a share, a lesson's completion — is not waiting for
    anything, and drawing it as a track that fills tells the reader it is
    incomplete. Those take the ring. Nothing in the product draws the same
    quantity two ways: `/lessons` kept its own hand-rolled progress circle
    until this pass and now uses the kit's ring like everything else.
  - **The marks** (`marks.tsx`) — Forma's own icon set: Target, Shield,
    Crown, Book, Chart, Board, Clock, Fork, Flag, on one 24 grid, filled with
    their counters knocked out, taking `currentColor`. **Solid, not drawn.**
    The first set was line art at a hairline weight and had no mass at the
    size a mark actually appears: it read as a faint diagram of an icon
    rather than an icon. **Marks never draw pieces.** The piece artwork is
    the Cburnett vectors the boards use, and a second hand-drawn set beside
    them is how a product starts looking like two products. Piece glyphs were
    tried inside the phase rings and were the weakest thing on the page:
    board artwork shrunk into a ring is a pale outline. The phases take
    marks instead: the book you are still in, the crossroads where it stops
    being theory, and the finish.
  - **Figure chip** — how a stat is reported everywhere in the product: the
    value in the numeral face over its label in the micro face, on a well
    (or lifted onto a surface when the row sits on the page ground). It
    replaced sentences with bold numbers inside them, which read as prose to
    skim rather than figures to scan; a chip is never a bare number, because
    the label is part of the chip. **Provenance is not a statistic, and it
    does not get a chip at all.** A rating, a cohort size and a publication
    date stood under the hub's heading as three chips for one revision, and
    the phase pages carried the same row: they are not what those pages are
    about, they are how to read what those pages are about, and as chips they
    were the first thing the eye hit on every screen. Provenance lives inside
    the figure's own note, behind the mark, on the figure it qualifies.

    **Method prose lives behind the mark too.** `/openings` opened on four
    paragraphs stating the counts, the tolerance a mistake is judged by, how
    much of the repertoire had been analysed and which graph Practice drills
    from. Every one of them is true and load-bearing, and all four sat above
    the picture that is the page's actual argument. A reader who has read
    them once reads past them forever. They are in the note now; nothing was
    deleted, and the one disclosure that belongs to a control (what Practice
    selects by) travels on that control instead.
  - **Chance split** — taken, missed and set aside as one proportional bar.
    Taken and missed carry the two result colours; a chance that ended before
    the player was on move is hatched, the openings page's own mark for "not
    judged", because colouring it either way would count a chance nobody got.
    The counts print beside the bar, so colour never carries it alone.
  - **Miss histogram** — where in the game the misses fall, as the hub's
    shape chart at row scale. Adjacent move numbers pool into at most
    fourteen buckets (counts summed, never rescaled), and the run the
    headline names is the coloured one.
  - **Trajectory line** — the trajectory's mark: the median, from the first
    move to the last, as one accent line over a wash of its own colour. It
    went through a shaded quartile band and then a field of quantile
    capsules, and both were the same mistake in different clothes: a picture
    carrying every quantile at once is a research figure, not something read
    at a glance. The line passes through every published point and the curve
    between them only says how it travels. The spread is a deep reading, so
    it is drawn only where deep reading happens (`spread`, on the profile
    and the report); the hub gets the line alone.
  - **Phase band** — one phase's slice of the trajectory: the same line,
    built by the same `buildCone` over that phase's bins only, so the slice
    cannot disagree with the whole.
- **Phase pages** (`phase.tsx`, `/middlegame` and `/endgame`) — the hub's
  shape applied to a third of the game. They read `GET /v1/phases/{phase}`,
  which goes through the same live-publication pointer as the dashboard, so
  the two screens quote one figure, one date and one denominator. The order
  is: the pooled figure as the heading with its evidence; the instruments
  (gauge, chance split, phase band); the concept stack, most costly first,
  each row a counted split with the position it last went wrong in behind the
  disclosure; the miss histogram; one action, the practice queue. The
  per-concept rows are counts with a raw share — the estimator publishes no
  posterior at that grain, and the key under the stack says so once. Stacks
  fold past eight rows with the count named; the long tail of one-chance rows
  is the stat dump PRODUCT.md refuses.
- **Practice** (`practice.tsx`, `/practice`) — the drill queue, on `/v1` and
  in the primary nav. Every item is a position from the player's own games
  where the engine preferred another move, and each carries its own reason
  with the cost it measured. Three rules from the API's contract shape the
  screen: the queue never contains the solution (the board is a test; the
  expected move exists client-side only after an attempt); one committed
  answer per position, no retry, because the attempt advanced the spaced
  schedule and the honest consequence of a miss is that the position comes
  back sooner, which the page says; and a revealed answer is never a success.
  The verdict draws the played move in the loss colour and the engine's in
  the win colour, both named in words beside the board.
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

  **The page is a desk, not a stack of strips.** Four revisions of this hub
  were one full-width band after another — graph strip, tile strip, rank
  rows, task rows — and however each band was polished the page read as a
  report. The architecture that finally broke the rhythm follows what the
  products doing this well actually do: few, distinct, aggregated units, and
  a mark vocabulary a reader can tell apart before reading any of it.

  - **The hero**: the verdict headline, then **the three phase rings and no
    graph**. The trajectory was drawn here for one revision, with the rings
    as its legend, and the two instruments disagreed on sight: the line reads
    the median evaluation (collapsing in the middlegame), the rings count key
    moments handled (highest in the middlegame, whose moments are a different
    mix), and a hero that needs a footnote to hold its own two pictures apart
    is arguing with itself. The graph's conclusion survives as the headline
    sentence — the part a reader takes away — and the picture itself lives on
    `/profile` and `/report`, where reading the evidence behind a sentence is
    the point. Each ring is the way into its `/patterns` section, and the
    provenance is one quiet line inside the figure's note.
  - **Start here**: the worst line, its board, and the page's single accent
    control. It is the only large block of type on the hub, which is what
    lets it read as the thing to do without a badge saying so.
  - **The deck** ("Then"): everything else worth doing, as marked cards in an
    auto-fitting grid — the examination, the drill queue, the openings sheet,
    the profile, the last game. Each carries a piece glyph in a ring, a title,
    a counted reason and, where there is one, a figure as a badge. A card
    that cannot state its reason does not render.
  - **Progress**: the goal, still honestly empty until goal-setting ships.

  **What the hub does not carry.** No ranked measure stack, no per-measure
  movement, no finding paragraph, and no family cards summarising either.
  Every one of those was a list wearing a page, and the deep reading they
  wanted already exists on `/profile` and `/report`, where reading every
  measure is the point. A hub is a glance: every claim on it is a headline,
  a chip, a ring or a card.

  **The trajectory's compact cut** survives in `Trajectory` (`compact`) but
  no longer has a caller: the hub dropped the graph (see the hero note
  above), and the full reading on `/profile` and `/report` is not compact.
  **The archive is graphite and the measurement is the accent**: everything
  structural stays ink, and the one hue means "your figure". The picture
  spent one revision as a pale accent band that read as a washed pink field
  sitting alien on the paper, and one as a field of quantile capsules that
  was accurate, dense and unreadable at a glance. The line is what a person
  actually reads.

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

## The hub

The authenticated pages are a different problem from the marketing site, and
for one revision they were designed as though they were not: a signed-in page
carried the same restraint, the same air, and none of the tactility, so a
product somebody uses every day read like a page they were meant to admire once.

Five rules, and they are the ones that keep breaking.

**One unit per screen.** Everything measured on the hub is key moments handled
over key moments seen, because that is what the estimator publishes for a phase
and for every concept in the catalogue alike. The words are the contract's
(PAGES.md): **handled** is the universal positive, **missed** the universal
negative, **set aside** is neither, and a pattern speaks its own natural verb
at the detailed level. The row this rule replaced said "1.4
mistakes per game", "−34 points given up" and "62% winning positions converted"
side by side, in one visual grammar, and nobody can rank those. If a figure
cannot be said in the screen's unit, it belongs on `/profile`.

**Colour is movement, never level.** A dial is coloured by the estimator's
posterior that this thing improved against the same player's earlier games —
the one comparison the estimator says is valid. Colouring by level is both
unfair and uninformative: a beginner sits in the bottom band of every measure
Forma has, so every mark would be red for as long as they need encouragement
most. A thing nobody has compared yet is ink, not red.

**No measurement lives only in a hover state.** It does not exist on a touch
device, it does not exist for anybody walking past, and — because a hidden
block still takes part in layout — it will quietly shove the marks around it
out of line. If it is worth measuring it is worth a line on the page.

**Never let one screen carry more than one box.** The action is the box.
Dials, milestones and readings sit on the paper, like a piece on a board. When
every object is in its own white card the page has no hierarchy left to spend
on the one object that matters, and three cards in a row turn the thing a
reader is meant to compare into three things they have to look past first.

**Short lines, and a modal for the rest.** A metric label is four words. A card
title is five. A line of body copy on a hub page is twelve, one clause, no
semicolons. Anything longer goes into `FigureNote`: a mark and a dialog, which
costs the page nothing until somebody asks. No em dashes in anything that ships
to the screen — a period, a comma, a colon or two sentences, every time.

**Mono is for figures, never for tone.** The numeral face marks a measurement.
A pool name, a section heading and a unit label are words, and setting them in
tracked uppercase mono is the face doing duty as a costume for "technical". A
section heading is a heading: text face, reading size, ink.

**One eyebrow is a system; an eyebrow per section is a rhythm nobody chose.**
The hub carried four tracked uppercase micro-labels down one page. They are
headings now, and the one true eyebrow — "Start here" over the action — is gone
because the largest heading on the page and its only accented control already
said it.

### The dial

The hub's one mark, at three sizes — large on `/today`, mid at the top of a
phase page, small in a stack. A reader learns the scale once.

- **the arc** is where you are: the published rate on the full 0–100 scale,
  with the interval as a window on the same track. The track is neutral, never
  a tint of the tone — a green arc on a green track is a ring whose length
  cannot be read, which turns the mark's one quantitative channel back into
  decoration.
- **the disc** is which way you are going, and it is the only coloured surface.
- **the mark** is which thing this is, knocked out of the disc.

The claim wears the emphasis and the rate is context under it, not the other
way round. Pooled phase rates are **not** comparable across phases — the
concepts that fire are not the same mix in each — so a row of three big
percentages invites a reading the figures cannot support. The caveat is
printed on the page, not filed behind the note mark.

### The path is a canvas, not a page

`/path` is the one route in the product that is not a document. Three big
circles stand in one space, unconnected, each with a road leaving it; pressing
one flies a camera down that road into that phase's own territory, where a
Duolingo-shaped path of stops climbs from the bottom of the screen upward.
It carries **no product nav** — a sticky bar with a logo and three tabs across
the top of a canvas is browser chrome bolted to a map, and it makes the space
read as a page again. One back arrow is the whole of its navigation.

Five rules, and they were each learned by breaking them:

- **One progress value drives the camera.** `x`, `y` and `scale` are all
  derived from it (`PathCanvas`). Three independent springs on the three
  transform channels let the framing drift mid-flight, because the translation
  is computed against a scale that has not arrived yet.
- **A path runs the way you were already going**, and that is per territory.
  The opening sits above the hub, so you fly up to it and its path climbs; the
  middlegame and endgame sit below, so you fly down and theirs descend. Travel
  and path are one continuous motion in every case. The first fix for this was
  "every path climbs", which only moved the reversal from one territory onto
  the other two.
- **Stops carry a name beside them, never under.** The route swings left and
  right down the middle of a territory, so a name centred under a face sits on
  the line to the next stop. The name hangs off the outer side of the swing,
  which keeps the middle clear and gives the eye one column to read.
- **Every stop opens the same way.** A press opens the stop's own sheet and the
  sheet carries the action; leaving the canvas is always a deliberate second
  press. The draft where review stops opened a panel while lessons and drills
  navigated straight out meant two identical-looking objects did two different
  kinds of thing, one of them throwing away the place you were standing in.
- **A stop is named the way chess names it.** "Forks", "Only moves",
  "Hanging pieces" - not the catalogue's descriptions ("Attacking two things at
  once", "Finding the move that held"), which are right where a reader meets a
  measure once and read as generated filler repeated down a route. The
  description survives as the sheet's subtitle, where explaining is the job.
  The role is appended only when it is telling two stops apart, because
  "Conversion - Convert" says the same word twice.
- **The route is one dotted line in the accent, and it loops.** It was a grey
  bed under a white surface under a centre-line, which is a lot of road for a
  canvas whose only other marks are circles: the stops sat on top of it rather
  than being threaded onto it. One line running behind every face reads as one
  object. It carried a loop every third gap for one revision and they are gone:
  a loop drawn in dots is a knot, it reads as the route doubling back, and it
  tangled two stops that have nothing to do with each other. The swing of the
  path is character enough.
- **A stop's face says what kind of thing it is**, and a review stop's face
  says what kind of chess situation it was, taken from the concept's published
  category: tactical takes the burst, defensive the shield, conversion the
  flag, and anything unclassed the board. Six identical board marks down one
  route told a reader only that six things happened.
- **An opened stop takes three quarters of the screen** and the canvas slides
  left to make room, rather than shrinking. A sidebar-width column cannot hold
  a board at reading size, and a board is the whole point of a review.
- **Done is only ever real.** A stop is finished because stored progress says
  so - lessons have `completedAt`, and nothing else does. There is no published
  notion of having finished looking at a position, and inventing one would be
  the awarded-for-effort badge the product refuses.
- **A road is a departure, not a connection.** It leaves a circle and fades to
  nothing well short of its territory. Two drafts drew the full distance and
  both crossed the very path they led to, because a territory's climb occupies
  the corridor its own road must travel.
- **A stop carries its name and nothing else.** The counts live on the panel
  beside the path and on the stop's own sheet. Forty counted lines down a route
  is a table wearing a map's clothes.
- **A measurement never sits among the stops.** A ring on a path reads as a
  thing to complete, and nothing measured here is completable. It goes on the
  panel, which is also why the three entrance circles count waiting evidence
  ("6 to review") and never a percentage: a ring filled to 72% under the word
  "Opening" says the opening is 72% done.

A path ends in **faded, locked ground** saying more is coming, and those nodes
are deliberately unnamed — a locked node promising a specific lesson is a
roadmap the product has not committed to.

**The accent is structural here, not decoration.** Orange means "this is your
way through": it runs as a dashed centre-line down the made part of a route and
stops dead where the locked ground begins, and it rings the one stop you are
meant to start from. Green appears in exactly one place, the finished badge.
Everything else on the canvas is ink, paper and the board's own two tones.

**The drawn object is now the product's, not the canvas's.** A three-pixel ink
outline with a solid plinth under it, pressing by the plinth's own depth. It
started on `/path` and `/today` carries it too: the phase rings sit in drawn
discs, the action card is outlined and plinthed, and the deck marks are drawn
wells. The two screens are one product, and a ring on the hub and a stop on a
path are the same kind of object at two sizes. The phase faces are shared
outright, so the mark inside a hub ring and the mark inside a canvas orb are
one drawing.

**Stars are only ever earned on a task with a fixed denominator.** A lesson has
one: everybody who takes it answers the same interactive moves, so a score out
of them is the same question asked of everyone, and `bestScore` records it.
Phases and patterns do not - the concepts that fire differ by phase, difficulty
differs by pattern, and PAGES.md is explicit that the number is not a fair
universal score. Stars there would tell a beginner they are one star at
everything for exactly as long as they most need encouragement, which is the
failure the colour-is-movement rule exists to prevent. A lesson nobody has
finished shows no stars at all, because an empty row of outlines is a zero on a
task never attempted. They are drawn in ink, not gold: the canvas spends its
one colour on the route.

**A territory's measurements stand on its masthead**, at the head of its own
path, in the same outlined-and-plinthed object as everything else. They were a
card pinned to the corner of the screen for one revision, which is the shape of
a default modal: it hovered over the world instead of belonging to it, and said
nothing about where you were standing. It is still not among the stops.

`pathMarks.tsx` is the path's own mark family: heavy outline, flat fill. A
separate family from `marks.tsx` because the job differs — those are small
figures inside dials and rows, where two tints of one hue is right; these are
96px faces a reader is meant to want to press, and at that size a two-tint
glyph reads as a faint diagram. The three phase faces are one board with
different ground lit up (the rank you start from, the centre you fight over,
what is left), so they are obviously three states of one thing. **The rule that
marks never draw pieces survives the restyle.**

### Three tabs, and one scrolled game

The product navigates on three questions, not on the parts of a chess game:
**Today** (how am I doing), **Path** (what to work through),
**Practice** (what is due right now).

It was five tabs, and three of them were a third of a game each. Nobody decides
to go and look at their middlegame - and `/middlegame` and `/endgame` were the
same component differing in six string lookups across five hundred lines, sat
in the nav beside `/openings`, which was a different kind of page entirely.

`/patterns` is one page and you scroll it, opening to endgame, so the scroll
itself is the shape of a game. It spent one revision as `/mistakes`, and the
rename is the contract's: the page describes what recurs, and a recurring
moment carries a handled count as well as a missed one - a name that opens on
failure describes half its own evidence. Each phase is the same three things
in the same order, which is what lets the second and third be read without
being learned again:

1. **the dial**, the same object the hub carries, at hero size;
2. **one key moment, on the board it went wrong on** - the kind missed most
   often in that phase, with its role named beside it (recognising, following
   through, responding, converting - two skills under one concept name are two
   different readings), and the move played beside the move that held. Three
   boards down the page is a game coming apart in three places, and it beats a
   ranked table of nineteen rows answering a question nobody asked on arrival;
3. **everything else, folded**, behind a control that names the count it holds.

A phase renders its section even when there is nothing in it: "your games do
not reach here" is a fact about somebody's chess, and dropping the section
would quietly shorten the game. The same rule at figure scale: **a phase with
no publishable rate shows the reason in place of the percentage** - "none of
your games reached here", "too few key moments yet" - and is never drawn as
0%, because an empty dial and a bottom score are opposite statements.

`/openings` survives as **Your lines**, the opening's line-by-line detail,
linked from that section and out of the nav. It carries no phase dial - a
reader met that dial at full size one click earlier, and this page is about
your lines, not about the phase. It is the one phase with a deeper page
because it is the one phase with line-level published data; the middlegame
and endgame have no equivalent and get no matching subpage. `/mistakes`,
`/middlegame` and `/endgame` survive as redirects,
because a dead URL is a worse answer than the section it used to be.

### One object, three sizes

`/today`, `/openings`, `/middlegame` and `/endgame` draw the same three figures
and they draw them with the same component — `PhaseRow` on the hub and the
profile, `PhaseHero` at the top of each phase page, `Dial` at row size in a
concept stack. Not a second design of the same figure: somebody arrives on a
phase page by pressing a dial, and if the page they land on renders that phase
as a different instrument under a different label, the two screens read as two
opinions rather than as one thing at two levels of detail.

`/profile` opens on the hub's own row for the same reason. It is `/today` with
everything behind it, not a separate product.

### One size per set

Anything a reader is comparing side by side is one size. An option that is
physically taller than the ones beside it reads as more important before a word
of it has been read, which is a recommendation made with layout instead of
evidence — and it was exactly what the choice cards did, because the card
carrying a reason grew a line and each card was its own grid row.

Two rules make it hold rather than needing to be re-fixed:

- **Sets use equal rows** (`grid-auto-rows: 1fr`), so the tallest member sets
  the height and the rest align to it.
- **A component with an absent value renders the same shape as one with a
  value.** A phase with nothing published draws the name, the chip and a figure
  line of the same height saying so, rather than three elements where its
  neighbours have four.

And a mark inside a dial is a fixed share of that dial, set by the dial, at
every size it is drawn. It used to be set per context, so the same mark came
out at a different size inside the same component depending on which screen had
rendered it.

**The gallery renders the real components.** `/dev/foundation` hand-wrote its
own copy of the phase node for one revision, and the copy went stale the moment
the node changed — a gallery that reimplements what it documents is a second
implementation to keep in step, and it will not be kept in step.

### The plinth

`--shadow-key` is a 2px lip drawn inside the shape. It reads on a 32px button
and disappears under anything larger. `--shadow-lip` is the same idea at the
depth a large object needs: a ring plus a solid offset below it in the object's
own darker ink, so the object sits on a plinth rather than darkening its own
bottom edge — a white card cannot shade its own two bottom pixels without
looking soiled. Pressing translates by exactly `--lip`, so the plinth
disappears and nothing beside it shifts.

### The rook, speaking

**Onboarding, and nowhere else.** A mascot speaking is charming on a screen
somebody meets once and a mannerism on the screen they open every morning — a
hub that greets you in character every day is performing at you rather than
telling you something. Onboarding is where the product genuinely is introducing
itself, so it is where the first person is earned.

Everywhere else the same words go on the page as a short line, or into
`FigureNote`. **One bubble per screen, ever** — two on one page means one of
them is a measurement that has not been cut down yet.

The bubble takes children rather than a string, which is most of the reason it
is worth having: a move inside it should be a move mark, and a named concept
should be a link to its own dial.

### Milestones

The closest thing Forma has to an achievement, and the difference from every
other product's version is the point of shipping it:

1. **Nothing is awarded for effort.** No streak of visits, no count of drills
   done, no games synced. A product that congratulates you for turning up has
   stopped measuring your chess.
2. **A milestone can be lost.** Declines render in exactly the same shape as
   gains. A wall that only fills up is a wall nobody reads twice.
3. **The evidence is on the card**, not behind it: two rates and the chances
   the recent one was counted over.

The strip is ordered by certainty — distance of the posterior from 0.5 — not
worst-first. Worst-first is right for `/profile`, which somebody opened
deliberately to read every measure; on three cards it produces a hub that opens
on two failures every day. Certainty-first surfaces a strong decline exactly as
readily as a strong gain.

### Choice cards

A question asked as cards rather than a strip of pills, so the consequence of
each option is readable before it is picked. An option may carry a *Forma
suggests* tab, and the component requires a reason alongside it: a confident
recommendation with nothing under it is the one move that would contradict
everything else here. Nothing pre-selects — a default somebody has to notice
and undo is not a recommendation.

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

Three rules that AA implies and that the product kept breaking:

**A token that fails at the size it is used is a broken token, not a debt.**
`--color-ink-faint` and `--color-accent` both failed, and between them they
carry every caption and every primary control on the product. See the Color
section for the values that replaced them and the ratios they measure.

**The focus ring is an outline and only an outline.** `box-shadow` replaces the
element's own, so a focus rule that adds a halo strips the plinth off the
button it is ringing and squares its radius for as long as it is held. An
outline is drawn outside the box, follows the real radius, and cannot disturb
what it rings.

**44px is the floor for anything you press**, including a mark set inline in a
line of small type. Where the glyph has to stay small, a negative-inset
`::after` gives it a real target without taking any layout.
