# E16 — onboarding, coverage, the diagnostic, and the immutable baseline

The first schema and the first endpoints a new person actually meets. Three of
the constraints here are promises rather than bookkeeping, and they are the
reason to read this document rather than the code.

## Three promises the database keeps

**A baseline pins what it was built from, forever.** `coaching.baseline_reports`
names the exact snapshot, analysis run and coverage decision behind it, and the
table is immutable by trigger. It never follows the live publication pointer
afterwards, so the report someone was shown on day one is still readable on day
three hundred even though every estimator has been promoted twice since.

**A coverage limitation cannot be redacted.** Every coverage item carries the
`always` entitlement key; the database refuses a coverage item with any other
key; every plan includes `always`; and `redactForPlan` never sees a coverage
item it is permitted to remove. Three independent places, deliberately, because
this is the rule most likely to be quietly relaxed later by someone optimising a
conversion funnel. Entitlements control depth and continuity. They do not
control whether the reader is told the evidence is thin.

**Activation requires all three things, checked by the database.** A run cannot
record `activated_at` without `report_viewed_at`, `goal_selected_at` and
`commitment_accepted_at`. Nothing is created implicitly: a user who never chose
a goal does not have one, and `POST /onboarding/complete` returns which
preconditions are missing rather than manufacturing them. Inventing a default
goal would make the whole coaching cycle something that happened to the user.

## Coverage: what "fifty games" actually is

`coverage_policy_v1`. Fifty eligible games is the threshold for `sufficient`,
and it is a versioned hypothesis about when a report stops being mostly noise —
not a database constraint and not a promise that any particular skill has enough
evidence behind it.

The output is a state plus a list of **named limitations**, because platform
spec 14.5 asks for "a useful limited report and the exact missing evidence, not
a failure screen", and a number cannot be exact missing evidence. Each
limitation has a sentence written beside its vocabulary entry, so adding one
without saying what it means to a person fails to compile.

Every sentence is phrased as a fact about the sample rather than about the
player. "We have few of your endgames" is something Forma knows; "you avoid
endgames" is a judgement it has not earned. A unit test asserts that no
limitation text says *you avoid*, *you refuse* or *you never*.

Two decisions worth knowing:

- **Fifty games that measured nothing is not sufficient.** `sufficient` needs
  both the game count and at least one dimension that is itself sufficient. A
  lot of evidence about nothing in particular would otherwise be the most
  defensible-looking way to publish noise.
- **Out of the calibrated rating band is a limitation, not a refusal.** Platform
  spec 3.2: such a player still sees objective facts about their own games. What
  is suppressed is the comparison to players at their level, and the report says
  so.

## The diagnostic

A bounded examination — eight items, at most two per dimension — not a puzzle
set. Selection is by widest interval first, round-robin across dimensions, so a
session cut short still covers several areas rather than draining the most
uncertain one.

Every item records the uncertainty it was selected to investigate. An item that
names none is a puzzle, and a puzzle result cannot update an estimate, so the
column is `not null`.

**One attempt per item, forever.** A second try is practice, and platform spec
3.4 forbids practice performance from becoming a chess-strength claim. The
unique constraint is what makes that true rather than the handler remembering.

Scoring is three-valued: the best move scores 1, another move the engine called
acceptable scores 0.6, anything else scores 0. "Found a good move that was not
the best one" is different information from "did not see it", and collapsing
them loses exactly what a diagnostic is for. Each hint halves the score; a fully
hinted correct answer still scores something, because the player did play the
move.

The expected move is never on the wire before an attempt is submitted. The
**pre-explanation** is: the user is told what an item is testing before they
answer it. That costs a little signal and buys the difference between an
examination and a trap.

## The API

Eight endpoints under `/v1`, per API contract §9. Two shapes are worth noting.

`GET /onboarding` derives the stage from what has actually happened rather than
reading it from a column, so a worker that finished its work and crashed before
recording it does not leave someone on a spinner. Every state carries a next
action **with a reason** — an onboarding screen that can only say "please wait"
for six different situations is the failure mode the spec is written against.

`GET /baseline-reports/{id}` records that the report was viewed as a consequence
of reading it. A separate "mark as viewed" call would be a button the product
could quietly press on the user's behalf, and viewing the report is one of the
three things activation requires.

`POST /onboarding/complete` answers 200 with the missing list rather than a 4xx
when preconditions are absent. This is a legitimate state of a legitimate
journey and the client's next screen is "choose a goal", not an error.

## Running it

The examination step runs as `coaching_baseline_examination` on `aggregation`,
after E15's subject report, reading the same frozen snapshot. Everything it
needs comes from the run, so a retry produces the same report rather than a
second opinion — `writeBaseline` finds the report it already wrote.

## Gates

| Gate | What it proves | Where it runs |
| --- | --- | --- |
| `onboarding:unit` | 45 offline invariants: the journey, the coverage policy, the diagnostic scoring, the redaction rule | anywhere |
| `onboarding:migration` | 0029 from empty and from 0028, twice; each of the three promises attempted against a real database | CI (needs Postgres) |
| `onboarding:security` | grants, the API's newly-widened write access, and that no log line identifies a person or leaks an answer | CI (needs Postgres) |

The workflow also runs `v1:migration`, `v1:integration` and `v1:security`, since
E16 mounted eight routes on the kernel, and `estimates:integration`, since the
examination reads what E15 writes.

## Migration

`0029_e16_onboarding_baseline` — eight tables in the `coaching` namespace, which
was empty until now. Additive and forward-only. Applied to the live project;
ledger at 30, all eight tables and the three promise-constraints verified there.

Two partial unique indexes rather than exclusion constraints (one active run per
subject, one open session per run): equality on a uuid needs `btree_gist`, and
pulling in an extension to express "at most one" would be a dependency bought
for nothing.

## Known limitations

- **The goal and the commitment are timestamps, not references.** E17 owns
  `coaching.goals`; recording `goal_selected_at` without a foreign key is
  deliberate rather than lazy — a dangling id would be worse — and E17 should
  add the reference when the table exists.
- **The onboarding workflow is not planned end to end.** The examination step
  and its handler exist and are idempotent; what does not exist is the planner
  that creates the sync workflow, chains the analysis run and enqueues the
  examination. `POST /onboarding/runs` records the journey and the stages derive
  correctly from work done elsewhere.
- **Diagnostic item selection has no route yet.** `selectItems` and
  `createDiagnosticSession` are implemented and tested; the endpoint that calls
  them needs the uncertainty query against E15's estimates, which is a
  straightforward read but is not written.
- **No integration or performance gate.** The unit, migration and security gates
  cover the logic, the schema promises and the grants. The end-to-end journey
  gate is the gap, and it is the first thing to add.
