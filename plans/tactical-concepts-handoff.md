# Tactical concepts MVP — handoff

Written for whoever picks this up next, on the assumption they have this
document and the repository and nothing else.

**Status: the code is complete and the functional proof is not.** Everything
that can be verified without a database has been, and everything that cannot is
named below with the command that would do it. Read [What is not
proven](#what-is-not-proven) before treating this as finished.

## What shipped

Twelve concept families, six corrected and six new.

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
each family may claim. If the code and that document disagree, the document is
what gets corrected first.

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

Run from `./server` unless stated.

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

## Measured

* **Detector cost**: 33.5 ms for 57 observations on an 80-ply game with stored
  candidate lines. Budget 500 ms, about fifteen times the baseline — loose
  enough for a slow runner, tight enough to catch a change in the shape of the
  work rather than a percentage.
* **Shadow validation**: 3,097 labels over 240 game-readings (120 games, each
  read as White with stored lines and as Black without). All 3,097 are
  structurally valid: legal focal move, every named square occupied on the board
  it refers to, correct actor colour, replayable verification lines, ordered ply
  ranges, no duplicate occurrence-and-role. Artefact: `server/concepts-shadow.json`.

## Backfill

```bash
# See the scope. Writes nothing.
PROFILE_ID=<uuid> npm run concepts:backfill -- --dry-run

# Measure runs that have never been measured. The default.
PROFILE_ID=<uuid> npm run concepts:backfill

# Bounded, for a large archive. Re-run the same command to continue.
PROFILE_ID=<uuid> npm run concepts:backfill -- --limit=100

# Reconcile already-measured runs without changing them.
PROFILE_ID=<uuid> npm run concepts:backfill -- --verify
```

Interrupted batches resume by running the same command again: completed runs
carry an artifact manifest and are no longer selected, the order is by run id so
it does not move, and each run is its own transaction.

A run whose manifest disagrees with this build's conclusions is reported as
needing a **new analysis run** and is not modified. That is the design, not a
failure: a manifest is immutable, and a different conclusion about a game is a
new run rather than an edit of the old one. Plan those through the ordinary
analysis pipeline.

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

To roll back further, stop registering the new concept versions: an unpromoted
version is not resolved by the worker, so nothing is recorded against it.
Migrations do not need reverting; they are additive and their columns are
nullable or empty.

## What is not proven

Read this part before calling the project done.

**The end-to-end proof (FOR-139) has not been executed.** It needs a database
and an engine, and this work was done in a worktree with neither. The procedure
is below; nobody has run it.

**Three gate steps have never run**: `analysis:migration`, `analysis:security`,
`analysis:integration`. They cover migration behaviour against a production-
shaped schema, row level security and ownership on the review route, and worker
retry against the real unique indexes. `concepts:gate` names them and exits 2.

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

Against a disposable database with the engine available:

1. `npm run db:migrate` from `./server`, on an empty database and again on a
   copy carrying E13 v1 rows. Both must succeed, and the second must leave every
   existing `concept_opportunities` row untouched.
2. `npm run analysis:promote` to register the catalogue. Expect twelve concepts,
   six created at version 2 and six at version 1, and zero conflicting.
3. Sync and analyse one owned game containing at least two tactical families —
   the corpus archetypes `open-centre` and `pawn-race` are the likeliest.
4. Confirm in the database: one `chess_events` row per occurrence, an
   `event_concepts` row per label carrying detector version 4, one
   `concept_opportunities` row per observation with its own `evidence_item_id`,
   and a `run_concept_opportunities` row tying each to the analysis run.
5. `GET /v1/games/{gameId}/review` as the owner: `sections.events` is
   `published`, events appear at the expected plies, censored rows carry a null
   `success` and a reason. As a non-owner: 404, identical to an absent game.
6. Open the game screen at those plies and read the panel.
7. Check the profile page names the new families without a frontend change.
8. Re-run detection and the backfill. Row counts and the detection checksum must
   be identical, and `concepts:backfill --verify` must report zero written.

Then prove the four states that are easy to get wrong: a measured game with no
concepts (`sections.events: published`, empty array), a publication from before
the detector existed (`unavailable`), a failed opportunity, and a censored one.

## Issues

FOR-121 through FOR-139, nineteen in total, are implemented. FOR-139 is
implemented as far as code allows and its functional proof is outstanding, which
is why the project is not marked complete here. Nothing was silently dropped;
what is not done is listed above.
