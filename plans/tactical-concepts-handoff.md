# Tactical concepts MVP — handoff

Written for whoever picks this up next, on the assumption they have this
document and the repository and nothing else.

**Status: the implementation is present; the release proof is incomplete.**
The offline checks below have run, but the database-backed gates, reviewed
semantic precision, browser check, and end-to-end proof have not. Read [What is
not proven](#what-is-not-proven) before treating this as finished.

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

## What is not proven

Read this part before calling the project done.

**The end-to-end proof (FOR-139) has not been executed.** It needs a database
and an engine, and this work was done in a worktree with neither. The procedure
is below; nobody has run it.

**Three gate steps were not run for this handoff**: `analysis:migration`,
`analysis:security`, `analysis:integration`. They cover migration behaviour
against a production-shaped schema, row level security and ownership on the
review route, and worker retry against the real unique indexes. `concepts:gate`
names them and exits 2.

**Four families have no shadow coverage**: `pin`, `skewer`,
`discovered_attack`, `removal_of_defender` produce nothing on the benchmark
corpus. They are neither validated nor refuted. Either the corpus lacks the
geometry or the detectors are stricter than it, and which one it is has not been
established. They should be withheld, or the corpus enriched, before they are
claimed as validated.

**Semantic precision has not been reviewed.** FOR-138 asks for 90% reviewed
precision, meaning a person reading up to fifty labels per family and
disagreeing with some. The shadow harness produces that sample and decides
structural validity only. No number anywhere in this project is a reviewed-
precision figure.

**The concept panel has not been seen in a browser.** Its pure parts are tested;
rendering it needs a synced, analysed, owned game and a session.

### The procedure that would prove it

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
