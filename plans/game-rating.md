# Game rating

A single 0–10 for a whole game: how well was this game played, by both sides,
given what the game actually asked of them. Ten is meant to be nearly
unreachable.

This document is the metric spec and the delivery order. It exists before the
code because the risk here is not implementation, it is calibration: a number
about somebody's game is read as a verdict, and a scale that puts a famous
masterpiece below a clean 1400 blitz game is a brand injury we would carry for
years.

## Why this is feasible here and not elsewhere

Three pieces already exist, and they are the three the metric needs.

**`server/src/engine/assessments.ts`** already stores, per decision: the actor's
expected score before the move, after it, the difference, whether that
difference sat inside a named tolerance, how many moves were acceptable, whether
it was an only-move, and the position's `criticality` — what was at stake. So
"how bad was that move" is already measured in expected-score terms rather than
centipawns, and it already knows whether the position was a fork in the road or
a dead ending. It also, deliberately, refuses to call anything a blunder: the
labels are a versioned presentation layer over the measurement. A rating is
exactly such a layer, which is the shape this table was left in for.

**`server/src/models/maia.ts`** is a rating-conditioned human policy: nine
networks, one per band, each answering "what would a player of this strength
play here". This is the piece that separates a rating from an accuracy score. An
accuracy score says a move lost little. A human policy says a 1400 would have
found it and a 2100 would not, which is what "played well" actually means.

**`server/src/estimates/`** already publishes numbers about people with a
posterior, an interval, a coverage status, and an explicit `unavailable` instead
of an invented value. One game is a small sample (roughly 30–50 real decisions
per side, fewer once the book and the dead positions are excluded), so the
rating needs exactly that treatment.

## What the number is made of

Three quantities, computed separately, combined last. They are kept separate
because they fail separately, and because the decomposition is what makes the
headline defensible.

### Per side: strength

For each decision the player faced, take the log-probability of the move they
actually played under each Maia band. Sum across the game. The band maximising
the total is the estimate: *this player's choices look like a player of ~X*. The
likelihood ratio against neighbouring bands gives the interval directly, and it
narrows on its own as the game gets longer, which is the correct behaviour: a
20-move miniature should publish a wider band than a 70-move grind.

This is a real statistical estimate, not a heuristic, and it is the reason the
metric can distinguish "won because the opponent collapsed" from "played
strongly".

Book moves and positions with no meaningful choice are excluded from the
likelihood, for the same reason `estimator.ts` excludes censored evidence: a
forced recapture tells you nothing about strength, and counting it as a success
inflates everyone equally.

### Per side: cleanliness

Criticality-weighted expected-score loss, straight out of the assessments table.
An error in a sharp middlegame and an error in a drawn rook ending are not the
same error, and `criticality` is already the column that says so.

Strength and cleanliness are not redundant. A player can be clean and weak (a
quiet game where nothing was asked) or sharp and error-strewn (a 2400 in a
time scramble). The pair is more honest than either alone.

### Per game: demand

How much the game asked. Built from what assessments already record: how many
positions were genuinely critical, how many only-move sequences occurred, how
long non-trivial criticality was sustained, how often the position could have
swung.

Demand is the term that makes 10 hard without a fudge factor. A game where
neither side was ever tested cannot rate highly, because there was nothing there
to be good at. This is the honest version of "10 is nearly impossible": not a
divisor chosen to make the top feel exclusive, but a real requirement that the
game have had something in it.

### Combination

Quality is a soft minimum of the two sides, not an average:

    Q = softmin(S_white, S_black)

A game is bounded by its weaker side. This gives the behaviour asked for without
a special case: two strong players score high; two weak players score low; one
strong and one weak lands near the weak one, because half the moves on the board
were not good moves. An average would let a grandmaster carry a beginner to a
middling score, which is wrong — that game was not a good game.

    rating = 10 · g(Q) · h(D)

with `g` and `h` both saturating. A flawless but sterile game caps in the middle
because `h(D)` is small. A wild game full of errors caps low because `g(Q)` is
small. Ten requires both sides near the ceiling of the strength scale *and* a
game that repeatedly demanded only-moves that both sides found. That happens
a handful of times a decade, which is the point.

## The doctrine problem

This codebase refuses single numbers on purpose, in several places and in those
words: "a single accuracy number describes neither". PRODUCT.md's anti-
references forbid the gamified vanity metric explicitly.

The rating is only defensible under two rules.

1. **It never ships alone.** The 0–10 is a headline over the decomposition:
   both sides' strength bands with intervals, both cleanliness figures, the
   demand of the game, and two or three named moments that moved the number
   ("both sides found the only move on moves 34 and 41", "White's advantage was
   returned on move 22"). A number a reader cannot interrogate is the thing this
   product exists not to be.
2. **It is versioned like everything else.** A `projection` component version
   under the E11 contract, with a promotion gate. When the formula changes, the
   old rating stays attached to the old version rather than silently moving.

## The calibration gate

Before this is shown to a stranger, it passes an ordering test against a
hand-built corpus:

- Canonical masterpieces (Kasparov–Topalov 1999, Byrne–Fischer 1956, Deep
  Blue–Kasparov, a spread of modern top-level games).
- Clean high-level draws, which must score respectably but not near the top.
- Amateur games at 800 / 1200 / 1600 / 2000, both clean and messy.
- Mismatches: strong player versus weak player, which must land low.
- Known-bad games: mutual blunder-fests, mouse-slip losses, flagged games.

The corpus is written down with expected orderings before the scorer runs
against it, so the formula is being tested rather than fitted to a hunch. This
gate is the deliverable, not a nice-to-have. It is the only thing standing
between us and publishing "the Immortal Game: 6.2".

## The public page

A page where anyone pastes a Lichess or Chess.com URL, or a PGN, and gets the
rating with its decomposition. This is the strongest acquisition surface the
product has, because it is the product's actual claim demonstrated on a game the
visitor already cares about, with nothing to sign up for.

The paste box is not the honeypot. The honeypot is that every rated public game
gets a permanent canonical URL. `canonicalGameId` and `pgnFingerprint` already
exist for exactly this dedup, so a game is analysed once and served forever, and
famous games become permanent, linkable, searchable pages. Seeding a few hundred
of them at launch means the surface has depth on day one instead of being an
empty text field.

Practical constraints:

- Full Stockfish plus Maia over an arbitrary PGN is real compute. The public
  path runs the `screening` promotion surface, on the existing queue, behind the
  existing rate limiter, and results cache by fingerprint so the second person
  to paste the Immortal costs nothing.
- Public games only. A private game pasted by a stranger is analysed and
  returned, not published to a permanent URL.
- Copy follows the public rules in DESIGN.md: no em-dashes, no eyebrow labels,
  every figure real. The call to action stays soft: this is one game, Forma does
  this to your last five hundred.

## Where it composes

Rating a game means rating each side within it, so the same output feeds the
product surfaces without new machinery: a rating on the game page, "your best
game this month", and, alongside friend lookups, a head-to-head average. Those
come after the metric is calibrated, not alongside it.

## Order of work

1. Build the calibration corpus with its expected orderings.
2. `server/src/analysis/rating/` — the scorer over existing assessments plus
   Maia likelihoods. Offline first, run against the corpus, iterate until the
   ordering holds.
3. Version it as a component and put it behind a promotion gate.
4. Public page, permanent per-game URLs, seed corpus.
5. Product surfaces.
