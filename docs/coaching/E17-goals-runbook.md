# E17 — goals, coaching cycles, requirements, commitments and progress

A goal is a promise the product makes to a person about their own improvement,
which makes this the schema where a shortcut does the most damage. Four of its
constraints are the promise rather than the bookkeeping.

## Four promises

**A cycle pins its baseline, its target and the model that judged them, and
cannot be deleted.** Moving the goalposts requires a new cycle with a new
sequence number and a stated rebase reason — so "you are 80% of the way there"
cannot silently become "40%" because an estimator was promoted. The rebase
reason is a closed vocabulary (`estimator_promoted`, `target_cohort_recalibrated`,
`user_changed_target`, `baseline_superseded`), because an unexplained rebasing is
indistinguishable from a target that moved because the number was inconvenient.

**A target has to move the bar.** `target_value` must lie beyond `baseline_value`
in the stated direction by more than `meaningful_change`. A target inside the
noise floor is met the moment it is set, which is the most flattering possible
way to build a coaching product that does nothing.

**A commitment is something the user confirmed.** `confirmed_at` is `not null`,
always. A commitment inferred from activity is the product deciding what
somebody signed up for and then holding them to it.

**Practice cannot complete a goal.** `target_achieved` requires real-game
evidence, readiness of 1, and coverage of at least `limited`. Adherence appears
nowhere in that constraint — deliberately. This is the exact place a coaching
product is tempted to pretend that doing the exercises is the same as having
got better.

## Resolving a target

"Get to 1600" is a wish. A target is a named metric, a baseline with its
uncertainty, a value beyond the noise floor, and a rule for what evidence would
settle it. When a wish cannot be turned into that, the answer is a stable
rejection code rather than a target that will quietly never be met.

Two behaviours are worth knowing:

- **A wide baseline interval widens the noise floor.** Promising a change
  smaller than the uncertainty of the starting point is promising to measure
  something we cannot see, so the floor is `max(meaningfulChange, intervalWidth / 2)`.
- **A target inside the noise is moved out, and the move is reported.** The user
  asked for something too small to see; they are told the smallest thing that
  *can* be seen, via `adjustedFromRequested`. Silently accepting it would give
  them a goal that was already met; silently refusing would tell them nothing.

**A stretch rating target is never `rating + 150`.** Reliability scales the
stretch across the policy band (100–200 points), and a rating outside the
calibrated range produces a caveat rather than a number — Forma will still
describe what somebody does at the board, and will not promise them an Elo it
has never calibrated.

## Progress, readiness, adherence

Three numbers the product is permanently tempted to blend, computed by three
functions that do not read each other's inputs:

- **Adherence** is what the user did against what they *accepted*. Somebody who
  declined two of six requirements and did the other four has full adherence,
  because adherence measures keeping your word rather than obedience. With
  nothing committed it is `null`, not zero — zero would say they failed to do
  something they never agreed to.
- **Readiness** is how far the estimate has moved from baseline to target, 0 to
  1, clamped. Overshooting is still 1: a goal is a threshold, not a score.
- **Real-game evidence** is the only thing that can complete a goal.

`claimState` orders the ethics: `unavailable` beats everything because a number
we do not have cannot be spun; `target_met` needs readiness *and* evidence *and*
coverage; and `declined` is said out loud, because a coaching product that only
reports good news is an advertisement.

## Closing a goal

A user may always close their own goal — it is theirs. What the product will not
do is record `achieved` when the evidence does not support it. Closing something
as `completed` without demonstrated real-game evidence closes it as `abandoned`
with a note saying exactly which targets were not demonstrated. The API returns
`closed: true` and `demonstrated: false` separately, so a client cannot render
one as the other.

## Plan generation

Ranked from the gaps this person's own report found, never from a template of
good habits. There is no universal "four games per day" rule, and a requirement
that cannot say which gap it addresses is a chore rather than coaching — the
`rationale` column requires twenty characters for that reason.

The choice of *kind* is driven by why the gap exists:

- a wide interval on few observations means Forma does not know yet, so the ask
  is to **play**, not to practise something we have not confirmed needs
  practising;
- a narrow interval well short of target means the weakness is established, so
  **targeted practice** is warranted;
- a narrow interval close to target means the work is **reviewing**.

Prescribing drills for a gap nobody has actually measured is the most common way
a coaching product wastes somebody's time.

Quantities are deliberately modest. A plan asking for twelve games a week from
somebody who plays three fails in week one and takes their confidence with it.

## The API

Eight routes under `/v1`, per contract §10. Three shapes carry the ethics onto
the wire: a resolved target reports what was asked for when it had to be moved;
`GET /goals/{id}/progress` returns adherence, readiness and evidence as three
separate members so a client cannot render progress from an activity counter;
and `POST /goals/{id}/close` reports closure and demonstration separately.

## Gates

| Gate | What it proves | Where it runs |
| --- | --- | --- |
| `goals:unit` | 39 offline invariants: target resolution, the progress split, closing, plan generation | anywhere |
| `goals:migration` | 0030 from empty and from 0029, twice; each of the four promises attempted against a real database | CI (needs Postgres) |

The workflow also runs E16's migration and security gates, since E17 altered
`coaching.onboarding_runs`, and the v1 kernel gates, since E17 mounted eight more
routes.

## Migration

`0030_e17_goals_cycles` — eight tables, plus one nullable column and a foreign
key on E16's `onboarding_runs`. Additive and forward-only. Applied to the live
project; ledger at 31, sixteen `coaching` tables and the promise-constraints
verified there.

That column is E16's follow-through: it recorded `goal_selected_at` with no
reference because the table it would have pointed at did not exist and a
dangling id is worse than a timestamp. It exists now.

## Known limitations

- **No cycle-creation route.** `POST /goals/{goalId}/cycles` is in the contract
  and `createCycle` is implemented and tested; the endpoint that resolves the
  baseline publication and calls it is not written. Without it a goal stays in
  `draft` and the plan reads `unavailable`, which is truthful but incomplete.
- **Progress is written by nothing yet.** `readProgress` and `writeProgress`
  exist; the worker step that runs them after each subject report does not, so
  `GET /goals/{id}/progress` answers `unavailable` in practice.
- **Templates are unpopulated.** The tables and the promotion flag exist; no
  template versions are seeded, so `GET /goal-templates` returns an empty
  collection and every goal is currently a custom one.
- **No integration, security or performance gate.** Unit and migration cover the
  logic and the four promises. The end-to-end gate is the gap.
