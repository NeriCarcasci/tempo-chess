# E18 — practice, schedules, and real-game transfer

This is the epic where "practice is not improvement" stops being a sentence in a
document and becomes a mechanism.

## Four constraints that carry it

**A practice attempt and a real-game opportunity are different tables with
different names.** `coaching.practice_attempts`, `coaching.diagnostic_attempts`
and `analysis.concept_opportunities` are three kinds of evidence with three
names, and nothing joins practice to a real game except a transfer match that
has to state why the two were comparable. A unit test asserts that no field of a
transfer match mentions practice or attempts at all.

**A transfer match records positive, negative *or* inconclusive.** A matcher
that can only find successes is a matcher that will find them everywhere. An
incomparable context cannot claim a direction — if the two situations were not
alike, nothing transferred either way, and recording a negative would blame
somebody for failing a chance they never practised.

**A player-derived item is owned by that player.** `training_items` requires
that `player_evidence` and `transfer_variant` items carry an owning subject and
`subject_owned` retention, and that editorial content does not. Somebody's own
blunder is not editorial content, and the constraint keeps that true when a
content pipeline is written later.

**Attempts are append-only and idempotent by the client's own id.** A retried
submit over a flaky connection is one attempt, not two, and the deduplication
does not depend on the server guessing. A schedule change never rewrites what
somebody actually did.

## The transfer matcher

The only bridge between practice and games, and it is built so that a *negative*
answer is easy to reach.

Comparability is checked before anything else, and returns a **reason** rather
than a boolean, because "these were not alike" is the answer most of the time
and a user deserves to be told which way. Different concept, different phase,
different time control, too distant in time, similarity below threshold, or the
later chance was censored.

Different time control is a real exclusion, not pedantry: blitz and classical are
different games for the same motif, and treating a classical solve as evidence
about a bullet decision is how a transfer metric quietly becomes a time-control
metric.

The outcome is read off the **opportunity**, not off the practice — the player
either handled the real chance or did not. Confidence falls with distance in
time and weaker similarity, and work the player never engaged with is weaker
evidence than work they actually did. A match below the confidence floor is
downgraded to `inconclusive` rather than published as a weak positive.

`describeTransfer` will not report a rate from one or two comparable chances.
"1 of 1 transferred" is the kind of statistic that makes a person trust a
product right up until they check it.

## Scheduling

Simple, versioned, and mutable — the one mutable table in the epic. Its state is
current state; the attempts it derives from are immutable, so replacing a
scheduler rebuilds the schedule without rewriting anybody's history. A scheduler
is a hypothesis about memory, and a hypothesis should not be able to edit the
evidence.

Two judgements are encoded rather than tuned:

- **A hinted solve advances less than an unaided one.** Not nothing — the player
  did produce the move — but scheduling it as unaided is how a review system
  convinces itself somebody knows something they do not.
- **A revealed answer is a lapse, and never a success.** The schema refuses
  `revealed and success` together; the scorer is the code path that agrees.

A lapse returns to a short interval rather than to zero: same-day repetition is
cramming, and a cramped solve says nothing about tomorrow.

## The queue

Bounded, and **never only a backlog**. Overdue work comes first but only up to a
share of the batch — a queue that is nothing but your failures, ordered by how
long you have been failing them, is not a study session, it is a guilt list. If
there is nothing fresh the remainder fills with overdue rather than serving a
short queue.

`shouldAssignMore` stops the selector once thirty assignments are outstanding. A
person with thirty things to do does not need a thirty-first; adding work to a
backlog is how a coaching product becomes a source of guilt.

## Gates

| Gate | What it proves | Where it runs |
| --- | --- | --- |
| `practice:unit` | 34 offline invariants: the matcher's refusals, the scheduler's judgements, the queue's shape | anywhere |
| `practice:migration` | 0031 from empty and from 0030, twice; each of the four constraints attempted against a real database | CI (needs Postgres) |

The workflow also runs E16's and E17's gates, since this epic builds directly on
their tables.

## Migration

`0031_e18_practice_transfer` — seven tables in the `coaching` namespace.
Additive and forward-only. Applied to the live project; ledger at 32,
twenty-three `coaching` tables and the four constraints verified there.

## Known limitations

- **No API surface.** Contract §§11–12 specify the practice queue, attempt,
  activity, transfer, lesson and opening endpoints. None are mounted. The
  scoring, scheduling and queue logic they would call is implemented and tested;
  the routes are not written.
- **No assignment selector.** `shouldAssignMore` and the queue exist; the worker
  that turns findings into assignments does not, so nothing populates
  `learning_assignments` yet.
- **No transfer worker.** `matchTransfer` is implemented and tested against
  every refusal path; the step that runs it over new opportunities after each
  sync does not exist, so `transfer_matches` stays empty.
- **No legacy migration.** The ticket asks for semantically valid legacy
  puzzles, opening drills and lesson progress to be reconciled. The legacy
  corpus has no move data at all — established during E10 — so there is nothing
  whose semantics can be matched. This is a reconciliation that should be
  recorded as *not possible* rather than left looking undone.
- **No openings or lessons projection.** Out of what was built here entirely;
  the epic's opening-explorer and repertoire surfaces are not started.
- **No integration, security or performance gate.** Unit and migration cover the
  logic and the four constraints.
