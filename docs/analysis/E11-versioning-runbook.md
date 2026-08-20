# E11 — versioned analysis execution: contract and runbook

Status: implementation complete on `epic/e11`, pending independent review
Migrations: `server/drizzle/0022_e11_analysis_versions.sql`,
`server/drizzle/0023_e11_function_search_path.sql`

## What this epic makes true

Every derived analytical result pins its inputs by identity rather than by
description: the component versions, the recipe manifest, and the exact replay
revision and materialization run of every game in a frozen snapshot. A run
reaches `succeeded` only when its artifact manifest covers exactly what its
recipe promised. Publication is one locked transaction that appends history and
moves a pointer, so a reader sees either the complete old run or the complete
new run. Rollback is another append, never a delete.

## The shape

```
components ─< component_versions ─< component_version_dependencies (DAG, acyclic by trigger)
                    │                        └── required_contract must equal the
                    │                            dependency component's output_contract
                    ├──< recipe_components >── recipe_versions ──< recipe_promotions (append-only)
                    └──< component_lifecycle_events (append-only, evidence-gated)

cohort_definition_versions ──< subject_data_snapshots ──< subject_data_snapshot_games
                                        │                    (pins replay revision +
                                        │                     materialization run)
                                        └──< runs ──< run_dependencies (what was reused)
                                                 └──< run_artifacts   (what was produced)

runs ──> subject_live_publications      + subject_live_publication_history
     └─> subject_game_publications      + subject_game_publication_history
materialization_runs (E09 pointer)      + replay_materialization_publication_history

validation_datasets ──< validation_runs ──< validation_metrics
```

## Load-bearing decisions

**Required output families are declared per recipe, not per run type.**
`recipe_versions.required_artifacts` is the contract. E11 owns reproducibility,
not chess meaning; a fixed list here would either invent output families no
method produces yet or bless whatever a later epic happens to write.

**A family present with `count = 0` is complete; an absent family is not.** A
quiet game genuinely produced no events. If the row were simply missing, nothing
would distinguish "none" from "the step never ran".

**Materialization keeps E09's pointer and gains only history.** Database
architecture §13.4 names three publication targets. Two get a current-pointer
table here because none existed. The third already has one —
`chess.materialization_runs.state = 'published'`, made single by a partial unique
index — and adding a second current-pointer table beside it would create two
rows that must agree about one fact.

**`analysis.validation_runs` has no `running` status.** In-flight execution is
the work ledger's job. A row here is a finished comparison, and immutable.

**Immutability is a trigger, not a comment.** `analysis.refuse_mutation()`
refuses update and delete on every version, manifest and history table.
`analysis.refuse_run_rewrite()` freezes a run's identity, inputs, terminal
status, output manifest and completion time, allowing only
`planned → running → terminal`.

**Idempotency is a partial unique index.** `runs_input_manifest_live` is unique
on `input_manifest_hash` where the status is `planned`, `running` or
`succeeded`. Identical inputs cannot produce a second live run; a failed or
cancelled attempt frees its inputs so a genuine retry is possible.

**Promotion cites evidence.** A component version reaches `validated` or
`production` only with a passing validation run that evaluated *that version*;
a recipe reaches a production surface only with a passing validation run that
evaluated *that recipe*. `research_shadow` is the deliberate exception — it is
the surface a candidate runs on in order to acquire evidence.

## Grants

| Role | Catalogue (components, versions, recipes, cohorts, datasets) | Subject-scoped (snapshots, runs, artifacts, publications) | Promotions and lifecycle |
| --- | --- | --- | --- |
| `forma_analysis` | select, insert | select, insert, update (runs and pointers only) | select |
| `forma_api` | select | select | select |
| `forma_ops` | select, insert | select | select, **insert** |
| `forma_stockfish` | select | none | none |
| `anon`, `authenticated`, `PUBLIC` | none | none | none |

Promotion is an operator action: neither the API nor the analysis worker can
promote a recipe. `forma_stockfish` reaches no subject-scoped table — E02
withholds `private.set_actor_context` from it, so a grant there would be one it
could never exercise.

Forced row-level security with an owner policy is on every subject-scoped table.
It is defence in depth behind an API that takes the owner as an argument.

## Observability

`server/src/analysis/telemetry.ts`, closed field list per event:

| Event | Answers |
| --- | --- |
| `analysis_run` | run transitions, missing/undeclared families, roles reused rather than recomputed, failure class, duration |
| `publication_switch` | target, publication id, old and new run, reason, how long the switch held its lock, refusal code |
| `snapshot_frozen` | snapshot size, under-coverage, whether an identical manifest already existed |
| `recipe_validation` | incompatible edges and cycles |

No event declares a subject, game, position, payload or identity field, and the
serializer emits only declared fields — asserted by `analysis:security`.

Alert-worthy: a rising `publication_switch.refusedCode` rate (runs are failing
manifest validation), any `recipe_validation.cyclic`, and
`publication_switch.durationMs` drifting past the budget below.

## Budgets

Recorded in `BUDGETS` (`server/src/analysis/contract.ts`) and asserted by
`analysis:performance` against a 1,000-game subject:

| Budget | Value | Measured (containerised disposable server) |
| --- | --- | --- |
| Publication switch p95, **net of one commit on the host** | 250 ms | 0–88 ms net |
| 1,000-game snapshot freeze | 4,000 ms | ~150–1,400 ms |
| Version block resolution p95 | 50 ms | 1–2 ms |
| Recipe validation | 200 ms | 1–2 ms |
| 1,000-game manifest read p95 | 250 ms | 2 ms |
| One page of owned games with publication state p95 | 100 ms | 1–2 ms |

The publication budget subtracts a measured commit baseline deliberately. The
disposable benchmark server runs with `fsync` on over container storage, where a
bare commit costs hundreds of milliseconds and swamps everything this epic
controls. Subtracting it makes the number about the transaction rather than the
disk under whichever machine ran the gate.

## Commands

```bash
cd server
npm run analysis:unit          # 28 checks, offline, no database
npm run analysis:integration   # 46 checks, disposable Postgres
npm run analysis:security      # 19 checks, real least-privilege roles
npm run analysis:migration     # 16 checks, empty + prior state + repeat
npm run analysis:performance   #  9 checks, 1,000-game fixture
npm run analysis:api           # 11 checks, the read end to end over HTTP
npm run v1:openapi:check       # the committed document matches the registry
```

The last five need a disposable PostgreSQL: set `FORMA_TEST_DATABASE_URL` to a
throwaway loopback server, or put `initdb`/`pg_ctl` on `PATH` or in
`FORMA_PG_BINDIR`. The harness refuses a hosted Supabase target and any
non-loopback address; that guard is not to be weakened.

## Migration, rollout and rollback

**Expand only.** 0022 adds tables, indexes, one unique constraint and one
backfill. 0023 pins `search_path` on the four trigger functions, which Supabase's
security linter flags when it is left to the caller. Nothing is dropped, renamed
or rewritten. Re-running either is a no-op, proven by `analysis:migration`,
including recovery after a table is dropped mid-flight.

0023 is a separate migration rather than an edit to 0022, which was already
applied: editing an applied migration file makes the database and the committed
history stop agreeing about what ran. It also corrects E09's
`chess.refuse_revision_mutation`, which carried the same warning — that is a
`create or replace`, not a change to E09's committed file.

**Backfill.** One `reconciliation` history row per already-published
materialization run, carrying the run's own `published_at` rather than `now()`.
Guarded by `not exists`, so re-application adds nothing.

**Applied to the live project** (`oqsjfmgdovvepncbphvk`) and verified there: 20
`analysis` tables, 9 with forced row-level security, 20 triggers, 5 backfilled
materialization-history rows against 5 published runs each carrying the run's own
`published_at`, 0 grants to `anon`/`authenticated`/`PUBLIC`, and the canonical
record untouched at 348 provider games, 347 subject games and 277 occurrences.
Supabase's security advisor reports no finding from this epic.

**Applying it.**

```bash
export DATABASE_URL="$(/home/nericarcasci/forma-automation/bin/forma-db-url.sh)"
cd server && npm run db:migrate
```

**Rollback.** There is no down migration and there should not be: the tables are
additive and empty of product data until a worker writes to them. To roll back
*behaviour*, roll back the pointer, not the schema:

```ts
await rollbackSubjectLive(sql, { subjectId, actor: { kind: "user", id: operatorId } });
await rollbackSubjectGame(sql, { subjectGameId, actor: { kind: "user", id: operatorId } });
await rollbackMaterialization(sql, replayRevisionId);           // positions/materialize.ts
await rollbackRecipePromotion(sql, { surface, reason, actor }); // validation.ts
```

Each appends a row saying a rollback happened. None deletes anything.

**Reconciliation.** `verifySnapshotHash(sql, snapshotId)` recomputes a frozen
manifest's hash from its own rows. A mismatch means something wrote to a frozen
manifest, which the triggers should have made impossible — treat it as a data
integrity incident, not a drift to be corrected.

## Known gaps and follow-ups

These are stated rather than fixed here; none blocks this epic's outcome.

1. **Deletion has no sanctioned path through the immutability triggers.** Every
   append-only table refuses `DELETE`, including for a subject being erased.
   The only route today is the privileged one the gates use —
   `alter table … disable trigger`, delete, re-enable — which
   `server/src/positions/materialize.test.ts` now needs for
   `chess.replay_materialization_publication_history`, because that table's
   foreign key otherwise makes a published materialization run undeletable.
   That is a test cleaning up after itself, not a deletion contract: E21 owns
   deletion and will need a real privileged routine (a migrator-run function, or
   `session_replication_role`). The pattern is pre-existing — E08's replay
   revisions already refuse deletes and the same test already disables that
   trigger — but E11 widens its surface and E21 should plan for it.
2. **`platform:database` re-apply checks fail on migrations 0016, 0018 and
   0019.** Those files `create policy` without a preceding
   `drop policy if exists`, so re-applying the committed SQL over live objects
   errors. Pre-existing since E06; 0022 uses the guarded form throughout.
   Fixing it means editing applied migration files, which is the unsafe way to
   fix a committed file, so it is left to a deliberate follow-up.
3. **Two foreign keys E08 left unindexed are now indexed by 0022**
   (`chess.provider_games.current_replay_revision_id`,
   `chess.subject_game_sources.sync_run_id`). Additive, and it turns E02's
   `platform:database` foreign-key check green. Called out because it touches
   tables another epic owns.
4. **`GET /v1/games/{gameId}` carries no review body.** §7's transition
   assessments, critical moments, events and explanations are E12's. Returning
   an empty `review` object would claim an analysis that has not happened.
   `analysis:api`
   covers the endpoint end to end: anonymous, non-owner and forged identifiers
   all refused identically, the version block absent before publication and
   exact after it, `stale` once a provider correction lands, and the ETag
   changing on a pointer move.
5. **No work handler is registered.** `analysis.runs.work_item_id` links a run
   to the ledger item that scheduled it, but E04 registers no product handler
   and neither does this epic; the worker that plans, runs and publishes is
   E12's and E15's.
