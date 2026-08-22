# Tactical concepts MVP — handoff

Written for whoever picks this up next, on the assumption they have this
document and the repository and nothing else.

**Status: released and measured in production on 2026-08-22.** Every succeeded
analysis run in the archive has been detected over, and all twelve families are
observed on real games. Three gate steps were deliberately skipped and reviewed
semantic precision is still not established, so read [What is not
proven](#what-is-not-proven) before treating the numbers below as validation.

## What shipped

Twelve concept families: five corrected, one reconfirmed without a version
change, and six new.

| Family | Version | Notes |
| --- | --- | --- |
| `material_safety` | 2 | Tracks the focal piece across the move; abstains on sound sacrifices |
| `free_material` | 2 | A stronger move is no longer a missed offer |
| `critical_moment` | 2 | Needs a 0.10 criticality spread; wording no longer claims access to thought |
| `only_move` | 2 | Records whether the claim is `absolute` or `searched` |
| `winning_conversion` | 2 | The opportunity begins in the position that became winning |
| `worse_position_defence` | 1 | Unchanged rule, deliberately not re-versioned |
| `double_attack` | 1 | Fork and royal-fork subtypes |
| `pin` | 1 | Absolute and relative; must win the pinned piece |
| `skewer` | 1 | Front target worth more than rear |
| `discovered_attack` | 1 | Discovered-check and double-check subtypes |
| `removal_of_defender` | 1 | Capture and deflection |
| `trapped_piece` | 1 | Never the king |

Detector implementation version: **4** (recorded on every `event_concepts` row).

`plans/tactical-concepts-contracts.md` is the authoritative statement of what
each family may claim. If the code and that document disagree, correct the code
unless a higher-authority acceptance criterion requires the contract itself to
be reconciled.

## Migrations

Three, all additive and forward-only. None touches an existing row.

| Migration | What it adds | Why |
| --- | --- | --- |
| `0038_concepts_are_versioned_one_at_a_time` | `chess_events.detection_key` plus two unique indexes | Identity per occurrence and per observation, so a second run inserts only what is missing |
| `0039_an_opportunity_points_at_its_own_evidence` | `concept_opportunities.evidence_item_id` | An observation cites its own evidence instead of the game's first |
| `0041_concept_outputs_name_the_analysis_run` | `analysis.run_concept_opportunities` | A publication reads only what its own analysis run concluded, so a later backfill cannot change an older published review |

Old rows keep working. `0039`'s column is nullable and the aggregate falls back
to the id that older rows recorded in `context`, which was always correct and
merely had nowhere typed to live.

## Commands

From a clean checkout, install both dependency trees first:

```bash
npm ci
cd server
npm ci
```

Run the server commands below from `./server` unless stated.

```bash
npm run concepts:gate          # the focused correctness gate — see below
npm run concepts:performance   # detector cost on a production-shaped 80-ply game
npm run concepts:shadow        # all twelve families over the 120-game corpus
npm run analysis:unit          # detector, catalogue, evidence and backfill unit tests
npm run v1:openapi:check       # the committed OpenAPI matches the route registry
```

From the repository root:

```bash
npm test                       # frontend, including the concept panel states
npm run typecheck
npm run api:types              # after any /v1 change, alongside server v1:openapi
```

`concepts:gate` exits **0** when everything ran and passed, **1** on a failure,
and **2** when it could not run its database steps. Two is not success. With no
`DATABASE_URL` it runs seven of ten steps and names the three it skipped.

## Offline evidence and limits

These are results from the committed offline harness, not production
measurements and not release proof.

* **Detector cost reference**: the gate records a 32.2 ms median for 53
  observations on an 80-ply shaped game, after three warmups and across five
  timed passes. Budget 500 ms, about fifteen times that reference — loose enough
  for a slow runner while still catching an order-of-magnitude change in the
  work. Each invocation prints its own measurement; do not substitute this
  reference for the result of the release run.
* **Shadow structural checks**: 6,197 labels over 480 readings (120 games, each
  read as both subject colours, with and without stored lines). All 6,197 passed
  the implemented structural checks: legal focal move, named square occupancy
  on the board each fact refers to, actor and affected colour, replayable
  verification lines, ordered ply ranges, and duplicate occurrence-and-role.
  This does not establish semantic precision. Artefact and review sample:
  `server/concepts-shadow.json`. The command exits 3 because four families were
  unobserved.

## Backfill

```bash
# See the scope. Writes nothing.
PROFILE_ID=<uuid> npm run concepts:backfill -- --dry-run

# Measure runs that have never been measured. The default.
PROFILE_ID=<uuid> npm run concepts:backfill

# Bounded, for a large archive. Re-run the same command to continue.
PROFILE_ID=<uuid> npm run concepts:backfill -- --limit=100

# Reconcile already-measured conclusions without rewriting evidence. This may
# append provenance links or missing labels for rows that already exist.
PROFILE_ID=<uuid> npm run concepts:backfill -- --verify
```

Interrupted batches resume by running the same command again: completed runs
carry an artifact manifest and are no longer selected, the order is by run id so
it does not move, and each run is its own transaction.

A run whose manifest disagrees with this build's conclusions is reported as
needing a **new analysis run** and is not modified. That is the design, not a
failure: a manifest is immutable, and a different conclusion about a game is a
new run rather than an edit of the old one. Plan those through the ordinary
analysis pipeline. The command exits **2** while any such action or unreadable
run is outstanding; it exits **1** on a failed run or reconciliation mismatch
and **0** only when the selected operation completed without either condition.

## Rollback and disabling

Set `FORMA_WITHHELD_CONCEPTS` to a comma-separated list of detector names:

```bash
FORMA_WITHHELD_CONCEPTS=pin,skewer   # stops producing these
```

Withholding stops new observations. It deletes nothing: every row already
written stays under the concept version it was recorded against, and the review
API keeps serving it. This is the rollback path for a family that turns out to
be wrong — there is no delete, by design, because `forma_analysis` may not
delete evidence and a worker that could would be able to quietly rewrite what a
report was based on.

Migrations do not need reverting; they are additive and their columns are
nullable or empty. Withholding is the production rollback for a version that
has already been registered; registration itself is not described here as a
reversible action.

## What the release proved

Released 2026-08-22 from commit `639e727`, image
`sha256:52d6f86ba04f03fa75d10bccb82fbadc570de2575ea66271a38d9871f1c88131`, staged
`--no-traffic --tag=next` and promoted after a smoke check. `forma-api` is on
revision `forma-api-00039-big` and `forma-analysis` on `forma-analysis-00038-ziz`,
both at 100% traffic.

Migrations `0038`, `0039` and `0041` are applied, and `0041` carries a ledger row
so `forma-migrate` will not re-run it. The catalogue registered twelve concepts
across seventeen versions with zero conflicts, through `concepts:register` rather
than `analysis:promote`, so no recipe was re-promoted as a side effect of adding
detectors.

Detection then ran over the whole archive: **333 of 333 succeeded analysis runs,
zero failures, zero abstentions, zero needing a new run.** It wrote 10,291
opportunities, and the database delta matched the reported writes exactly on both
batches -- 361, then 9,930. Every one of those rows carries its own
`evidence_item_id` and a `run_concept_opportunities` row, so the three counts
agree at 10,291 each. Every label carries detector version 4, and no other
version exists.

Detection was then re-run over all 333 with `--verify`, which wrote **zero
opportunities** and reported zero abstentions, zero failures and, most
importantly, **zero runs concluding differently**. That last number is the one
worth reading: every stored manifest still matches what this build concludes, so
detection is deterministic across the whole archive and no existing evidence was
rewritten. The database agrees independently of the command's own report --
`max(created_at)` on `run_concept_opportunities` predates the verification run,
so nothing was written by the database's clock rather than by the tool's
accounting of itself.

### The four states, observed rather than asserted

| State | Live instances |
| --- | --- |
| Measured with nothing to say | 4 runs carry a manifest and no opportunities -- `published`, empty |
| Never measured | none left in this archive; exercised by unit tests only |
| A failed opportunity | 2,515 rows, response observed and `success` false |
| A censored opportunity | 182 rows: `clock_expired`, `game_ended`, `opponent_resigned` |

No censored row anywhere carries a `success` value, which is section 17.5 holding
in production rather than in a fixture.

### The four families that had no shadow coverage do fire

The benchmark corpus produced nothing for `pin`, `skewer`, `discovered_attack`
and `removal_of_defender`, and this document previously said they should be
withheld until that was resolved. Real games resolve it: all four fire.

| Family | Opportunities | Games | Censored |
| --- | --- | --- | --- |
| `trapped_piece` | 505 | 201 | 47 |
| `double_attack` | 335 | 192 | 52 |
| `removal_of_defender` | 182 | 123 | 61 |
| `discovered_attack` | 35 | 33 | 5 |
| `skewer` | 33 | 31 | 10 |
| `pin` | 18 | 17 | 2 |

So the corpus was too quiet, not the detectors too strict, and none of the four
needs withholding on this evidence. `pin` is genuinely rare -- eighteen
occurrences across three hundred and thirty-three games -- which is consistent
with the mutual exclusion rule preferring `skewer` when the two geometries
coincide. That is now a question about how often the shape occurs rather than an
unknown about whether the detector works.

## What is not proven

Read this part before calling the project done.

**Three gate steps have never run**: `analysis:migration`, `analysis:security`,
`analysis:integration`. They cover migration behaviour against a
production-shaped schema, row level security and ownership on the review route,
and worker retry against the real unique indexes. `concepts:gate` names them and
exits 2. They were skipped by an explicit decision to release without them, not
because anything else covers them. The production run exercised the same writes
under `withActor` and against the real unique indexes without failing, but that
is a successful path rather than a proof of the refusing ones: nothing here has
shown that a non-owner is turned away, only that an owner is served. Anonymous
access to the review route returns 401, which is the only access check that was
actually made.

**Semantic precision has not been reviewed.** FOR-138 asks for 90% reviewed
precision, meaning a person reading up to fifty labels per family and
disagreeing with some. The shadow harness decides structural validity only. No
number in this document is a reviewed-precision figure. What has changed is that
there are now 10,291 real labels to sample, which is the corpus that review
needs and previously did not exist.

**The concept panel has not been seen in a browser.** Its pure parts are tested
and its data is now present for every analysed game, but nobody has looked at it.

**The `unavailable` state has no live instance.** Completing the backfill
measured the last publication that predated the detector, so the distinction
between "measured and empty" and "never measured" is exercised only by unit
tests in this archive. A newly analysed game will not recreate it.

### The procedure that would prove the rest

Steps 1, 2, 4 and 8 were carried out against production by the release above.
Steps 3, 5, 6 and 7 remain, and they are the ones that need an engine, a session
and a person.

Against a disposable database with the engine available, set `DATABASE_URL`
and the required database-role credentials for that database. Keep
`FORMA_WITHHELD_CONCEPTS` unset unless the proof is explicitly for a withheld
release:

1. `npm run db:migrate` from `./server`, on an empty database and again on a
   copy carrying E13 v1 rows. Both must succeed, and the second must leave every
   existing `concept_opportunities` row untouched.
2. `npm run analysis:promote` to register the catalogue. Expect twelve concepts:
   five at version 2 and seven at version 1, and zero conflicting.
3. Link a disposable test account, sync it through the ordinary provider flow,
   and analyse one owned provider game whose board you have inspected and which
   contains at least two tactical families. The benchmark corpus ids are not
   provider game ids and cannot be used for this step.
4. Confirm in the database: one `chess_events` row per occurrence, an
   `event_concepts` row per label carrying detector version 4, one
   `concept_opportunities` row per observation with its own `evidence_item_id`,
   and a `run_concept_opportunities` row tying each to the analysis run.
5. `GET /v1/games/{gameId}/review` as the owner: `sections.events` is
   `published`, events appear at the expected plies, censored rows carry a null
   `success` and a reason. As a non-owner: 404, identical to an absent game.
6. Open the game screen at those plies and read the panel.
7. Check the profile page names the new families without a frontend change.
8. Record the concept row counts and detection checksum, then run
   `PROFILE_ID=<uuid> npm run concepts:backfill -- --verify` twice. Both runs
   must report zero new opportunity rows; the recorded row counts and checksum
   must remain identical. Missing provenance links may be appended on the first
   verification, but no evidence row may be deleted or rewritten.

Then prove the four states that are easy to get wrong: a measured game with no
concepts (`sections.events: published`, empty array), a publication from before
the detector existed (`unavailable`), a failed opportunity, and a censored one.

## Issues

FOR-121 through FOR-138 have implementation in this branch. FOR-139's release
handoff is present, but its functional proof is outstanding. The project is not
complete; the unproved work is listed above.
