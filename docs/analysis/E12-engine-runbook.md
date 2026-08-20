# E12 — objective engine evidence: contract and runbook

Status: implementation complete on `epic/e12`, pending independent review
Migration: `server/drizzle/0024_e12_engine_outputs.sql`

## What this epic makes true

Every transition of a published game analysis has before/after objective
evidence that came from the same engine profile, the same search limit and the
same calibration, and neither side of it is history-free. Selected critical
positions additionally get a bounded deeper MultiPV search, with the scope,
profile and provenance of every result recorded on the row rather than implied
by a convention. When a deeper search does not happen, the assessment says
`unavailable` instead of pretending it was never wanted.

## The shape

```
component_versions (E11)
   ├── objective_engine_sf@<version+binary digest> ──> analysis.model_profiles
   ├── expected_score_calibration@1
   ├── objective_tolerance@1
   └── critical_position_selector@1
                    │
chess.core_positions ─< analysis.position_evaluations ─< analysis.evaluation_candidates
   (E09, history-free)        │  (anonymous cache; unique on cache_key
                              │   AND on the input tuple)
                              ├──< analysis.run_evaluation_uses >── analysis.runs (E11)
                              │        (typed role; cascades with the run)
chess.position_transitions ──< analysis.transition_assessments
   (E09)                          (the claim; restricts its run's deletion)
```

Three work items per game, on the queues platform spec §7 names:

| Task | Deployment | Queue | Resource class |
| --- | --- | --- | --- |
| `stockfish_screen_game` | engine | `stockfish-screen` | `cpu_engine` |
| `stockfish_deep_game` | engine | `stockfish-deep` | `cpu_engine` |
| `analysis_assess_transitions` | analysis | `analysis` | `aggregation` |
| `stockfish_evaluate_position` | engine | `stockfish-screen` | `cpu_engine` |

## Load-bearing decisions

**Scope is a claim, not a quality level.** Database architecture §10.5 gives
four scopes and they answer four different questions. `rule50` is the floor for
anything a transition cites, because a core-scoped number was computed without
the halfmove clock and cannot know a draw was one move away. It rises to
`history_exact` exactly when the occurrence has already occurred in this game,
because from there the engine's value depends on a repetition it can only see if
it is given the moves that produced it. Reuse requires *identical* inputs and
not a compatible-enough scope, because the scope is inside the cache key: a
lookup cannot cross the boundary even by accident.

**The history window is the halfmove clock.** A capture or a pawn move is
irreversible, so the position at `ply − clock` is the last one from which any
repetition could have started. Handing the engine that position plus the moves
since is complete evidence and the shortest such history — which matters,
because two games reaching the same situation then share one cache entry.

**Uniqueness is stated twice.** `cache_key` is unique, and so is the natural
tuple of every compatibility-relevant input, with `nulls not distinct` because
the scope qualifiers are null exactly when the scope does not use them. The key
is what callers look up by; the tuple is what stops a miscomputed key from
splitting one computation into two rows or letting two computations share one.

**The cache is anonymous by construction.** `analysis.position_evaluations` has
no subject, user, game or account column. Runs link to it through
`analysis.run_evaluation_uses`, so deleting a run removes the use and leaves the
entry other players share. Occurrence-scoped rows are the deliberate exception:
they name a materialization run, are not anonymous, and cascade with the
occurrence.

**"Mistake" is not a column.** Database architecture §16.1 makes good/mistake/
blunder optional versioned presentation classifications derived from
measurements. `analysis.transition_assessments` stores the measurement — actor
expected score before and after, the generated difference, and whether that
difference is inside the pinned tolerance rule.

**Nulls where a search did not look.** `acceptable_move_count`, `only_move` and
`criticality` are null when the search that answered retained one line. A zero
would read as "no adequate moves existed", which is a dramatic claim to make
about a search that never looked at an alternative.

**The engine deployment cannot learn whose game it is analysing.** Its handlers
take a materialization run id and two component version ids and touch four
tables: core positions, occurrences, transitions and the evaluation cache.
`forma_stockfish` has no grant on `analysis.runs` and no actor helper, so this
is enforced rather than observed.

**Deep failure is absorbed; screening failure is not.** Screening is the
evidence: if it cannot be produced the item fails, is retried, and the workflow
fails with nothing published. The deep pass is an enhancement, so an engine
error on one position leaves that assessment `unavailable` and the review still
ships with complete screening evidence.

**The worker binds an actor.** E11's owner policies are `exists (select 1 from
app.analysis_subjects ...)`, so a worker writing subject-scoped rows has to
satisfy them. `assessTransitions` reads the owner from `ops.workflows` — the row
the API wrote — and runs everything inside one transaction bound to that actor.
That is also the anti-spoofing control: a payload naming another subject's run
finds no run at all. The alternative, a permissive worker policy, would have
been a tenancy claim withdrawn rather than met.

## API

| Endpoint | Behaviour |
| --- | --- |
| `POST /v1/games/{gameId}/analysis` | 200 with the existing publication when it is *compatible* — it read the replay revision that is current now **and** used the recipe that is promoted now; 202 with a workflow otherwise; 409 when no recipe is promoted or the replay is not materialized. Body is `{ reason: "user_request", recipe?: "current" }` and `strict()` — a `depth`, `nodes` or `multipv` field is a 400. |
| `GET /v1/games/{gameId}/review` | Transition assessments and critical moments for the run the pointer names, with a `sections` block. `events`, `concepts`, `explanations` and `trajectory` are `unavailable`, not `[]` — E13 and E15 own them, and an empty array would claim the detectors ran. ETag'd. |
| `POST /v1/positions/evaluations` | API contract §14's bounded search. 200 from the cache, 202 with a workflow otherwise, 400 for an illegal FEN. Rate limited per actor at 30/min. The FEN is validated and interned as a core position, so what reaches the work ledger is a row id and a halfmove clock. |

Ownership is an argument to every query. A game belonging to someone else, a
forged identifier and a malformed one all answer `404`.

## Observability

`server/src/engine/telemetry.ts`, closed field list per event:

| Event | Answers |
| --- | --- |
| `engine_task` | engine startup, positions, cache hits and misses, deep selected, nodes, NPS, engine and wall time, estimated cost per task, failure class and a stable error code |
| `engine_cache` | hits and misses by scope and profile |

Queue depth, oldest ready-item age, lease expiry and duplicate delivery are
already answered by E04's `work_depth` and `lease_recovery` events over the same
ledger rows, and are deliberately not re-emitted here.

No event declares a FEN, PGN, move, subject, game or identity field, and the
serializer emits only declared fields — asserted by `engine:security`.

Alert-worthy: `engine_task.failureClass` on the deep queue rising (deeper
searches are failing and reviews are shipping with `unavailable`), a falling
`engine_cache` hit rate on `rule50` (the cache is being invalidated, usually by
an unintended profile change), and `estimatedCostMicroUsd` per game drifting
past the envelope below.

## Budgets

`BUDGETS` in `server/src/engine/contract.ts`, asserted by `engine:performance`:

| Budget | Value | Measured (disposable PostgreSQL 17.6, 120-game corpus) |
| --- | --- | --- |
| Cache lookup p95 | 25 ms | 0.6 ms over 200 probes |
| Assess one 80-transition game | 2,000 ms | 334–592 ms |
| Review read p95 | 250 ms | 2.6–3.5 ms over 25 reads |
| Nodes per game | 80×50,000 + 12×500,000 = 10,000,000 | 1,799,167 |

The corpus is 120 games of 40 plies drawn from eight opening lines with shared
prefixes: 4,920 positions, 4,318 searches, **12.2% cache hit rate**, 47
micro-USD per game. Projected to the 1,000 games the epic asks about:
**1.80 billion nodes, 0.047 USD**. The projection is stated rather than
materialised, because running a thousand games through the ledger would restate
the same per-game number at forty times the cost.

The node envelope is the capacity number this epic is accountable for. Cost is
derived from it by `COST_MODEL` (measured NPS and the Cloud Run rate for the
2 vCPU / 2 GiB shape platform spec §6.4 specifies), so a cost regression is a
node regression and is visible in the same place. The hit rate is *recorded*
rather than thresholded: how much a real population transposes is a fact about
that population, and a pass/fail line drawn on a synthetic corpus would be a
claim this epic cannot support.

## Commands

```bash
cd server
npm run engine:unit          # offline, no database, no Stockfish
npm run engine:integration   # the whole journey, disposable Postgres
npm run engine:security      # real least-privilege roles and bound actors
npm run engine:migration     # empty + prior state + repeat + partial
npm run engine:performance   # named budgets over a production-shaped corpus
npm run engine:api           # the three endpoints end to end over HTTP
npm run v1:openapi:check     # the committed document matches the registry
```

Everything except `engine:unit` needs a disposable PostgreSQL: set
`FORMA_TEST_DATABASE_URL` to a throwaway loopback server, or put
`initdb`/`pg_ctl` on `PATH` or in `FORMA_PG_BINDIR`. The harness refuses a
hosted Supabase target and any non-loopback address; that guard is not to be
weakened.

## Deployment configuration

The engine deployment declares the build it is running, and the worker refuses
to write results under a profile that does not match it:

```
STOCKFISH_PATH=/usr/local/bin/stockfish
STOCKFISH_ENGINE_NAME="Stockfish 17"
STOCKFISH_ENGINE_VERSION=17
STOCKFISH_BINARY_SHA256=<sha256 of the binary in the image>
STOCKFISH_NETWORK_HASH=<the nn-*.nnue digest>
```

A mismatch is classified `unsupported`, not transient: the same image would fail
identically, and an operator needs to see the routing or build mistake rather
than five more attempts against it.

## Migration, rollout and rollback

**Expand only.** 0024 adds five tables, their indexes and triggers, widens one
check constraint on `ops.workflows` (adding `position_evaluation`, never
removing a kind), and adds two grants on tables other epics own:
`insert on chess.core_positions to forma_api` (so the interactive endpoint can
intern the position it was asked about without the FEN travelling through the
ledger) and `select on app.analysis_subjects to forma_analysis` (so the worker
can satisfy E11's owner policies rather than needing an exemption from them).
Nothing is dropped, renamed or rewritten. Re-running is a no-op, proven by
`engine:migration` including recovery after a table and an index are dropped
mid-flight.

**Applying it.**

```bash
export DATABASE_URL="$(/home/nericarcasci/forma-automation/bin/forma-db-url.sh)"
cd server && npm run db:migrate
```

**Applied to the live project** (`oqsjfmgdovvepncbphvk`) and verified there: 5
new `analysis` tables, 2 with forced row-level security, 7 triggers, the input
index carrying `NULLS NOT DISTINCT`, both new trigger functions pinning
`search_path`, and the widened workflow-kind constraint now listing
`position_evaluation` beside the seven it already allowed. Grants confirmed by
`has_table_privilege`: `forma_api` may insert a core position and plan a run but
cannot record an artifact or write an occurrence; `forma_stockfish` may write
evaluations and reads neither runs nor assessments; `forma_analysis` may read
`app.analysis_subjects` and write assessments; `anon` and `authenticated` reach
nothing. The canonical record is untouched at 348 provider games, 347 subject
games and 277 occurrences, and the new tables are empty. Supabase's security
advisor reports no finding from this epic — the four it lists are pre-existing
(three legacy `public` tables under E01 containment, and the leaked-password
setting).

**Rollout.** The schema is inert until a recipe is promoted: `planGameAnalysis`
returns `unavailable / no_promoted_recipe` and the API answers 409. Bringing the
epic live is therefore one deliberate operator action — register the engine
lineage, register a `game_analysis` recipe pinning the four roles, record the
validation run that justifies it, and promote it to the `deep_game_analysis`
surface. `seedPromotedRecipe` in `server/src/engine/fixtures.ts` is that
sequence, and it is the shape an operator script should take.

**Promotion reaches already-analysed games.** A publication counts as covering
a request only when it pinned both the current replay revision and the currently
promoted recipe. Without that second condition a newly promoted method would
never reach a game somebody had already analysed, and the pointer would describe
a future nobody's data ever entered. The superseded publication stays readable
and its evidence is untouched — `engine:integration` proves that by rolling one
back and checking the earlier run's assessments are still there.

**Rollback.** There is no down migration and there should not be: the tables are
additive and empty of product data until a worker writes to them. To roll back
*behaviour*, roll back the pointer:

```ts
await rollbackRecipePromotion(sql, { surface: "deep_game_analysis", reason, actor });
await rollbackSubjectGame(sql, { subjectGameId, actor });
```

The first stops new runs using the method; the second restores the previous
published run for one game. Both append a row saying a rollback happened.
Neither deletes an evaluation: a superseded analysis keeps the evidence it was
computed from, so the two can be compared.

**Reconciliation.** Two checks, both cheap:

```sql
-- Every published transition has evidence, and none of it is history-free.
select count(*) from analysis.transition_assessments ta
join analysis.subject_game_publications pub on pub.run_id = ta.analysis_run_id
join analysis.position_evaluations b on b.id = ta.before_evaluation_id
join analysis.position_evaluations a on a.id = ta.after_evaluation_id
where b.scope = 'core' or a.scope = 'core';        -- must be 0

-- A published run assessed every transition of its chain.
select pub.run_id, mr.transition_count, count(ta.id) as assessed
from analysis.subject_game_publications pub
join analysis.transition_assessments ta on ta.analysis_run_id = pub.run_id
join chess.materialization_runs mr on mr.id = ta.materialization_run_id
group by pub.run_id, mr.transition_count
having count(ta.id) <> mr.transition_count;        -- must be empty
```

A row from either is a data-integrity incident, not a drift to correct: the
trigger and the manifest check should have made both impossible.

## Known gaps and follow-ups

None blocks this epic's outcome.

1. **Deletion still has no sanctioned path through the immutability triggers**,
   as E11 recorded. E12 narrows the problem deliberately: `position_evaluations`
   and `evaluation_candidates` refuse *update* only, so an occurrence-scoped
   evaluation can cascade with its occurrence, and delete is withheld by grant
   instead. `transition_assessments` follows E11's `run_artifacts` — refuses both
   and restricts its run's deletion — so E21 must remove the claim before the run
   that made it.
2. **The critical-position selector uses two of its seven reasons.**
   `evaluation_swing` and `phase_transition` fire; `candidate_ambiguity` cannot
   during a one-line screening pass, `trade` and `pawn_break` are E13's feature
   detectors, `clock_anomaly` needs the time increment which the replay does not
   carry, and `serious_judgment` is deliberately unused because this epic does
   not publish judgments. The selector is versioned, so adding reasons is a new
   component version and a new recipe rather than a silent reclassification.
3. **`GET /v1/games/{gameId}/review` carries no events, concepts, explanations
   or trajectory.** They are reported `unavailable` rather than omitted. E13 and
   E15 own them.
4. **Play sessions (`/v1/play/*`, API contract §14) are not implemented.** They
   are a separate feature from the bounded evaluation this epic owns, and the
   epic's contracts name game review and evaluation APIs only.
5. **`analysis.model_profiles` has room for human-policy and human-outcome rows
   and E12 writes none.** The role column and the `enforce_objective_engine`
   trigger exist so E14 can register a Maia-family profile without the objective
   columns being reachable from it.
