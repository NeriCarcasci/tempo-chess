# Forma v1 delivery plan

Status: normative execution order  
Date: 2026-08-15  
Linear model: one initiative, five ordered projects, project milestones, parent
issues as epics, and child issues as implementation/review tasks

## 1. Delivery rules

### 1.1 One epic, one integration branch

- Every epic starts from current `main` using the parent Linear issue's branch
  slug prefixed with `epic/`.
- Child tasks are the epic checklist. They do not create independent long-lived
  branches unless the epic owner explicitly needs a short-lived branch merged
  into the epic branch.
- An implementation agent owns the complete epic: code, migrations, tests,
  infrastructure-as-code/configuration, documentation, observability, and
  evidence.
- The agent may not weaken or reinterpret a locked contract to make tests pass.
- The epic branch is rebased/merged with current `main` before final review and
  the entire required suite runs again.
- A larger independent model reviews the complete diff against the epic,
  platform/API/database specs, security invariants, migration safety, and test
  evidence.
- Review findings are fixed on the epic branch. Only then is the epic merged to
  `main`.
- The next dependent epic starts from the reviewed `main`, not from an unmerged
  predecessor branch.

### 1.2 Definition of ready

An epic may start only when:

- all `blockedBy` epics are merged;
- inputs, owned files/domains, migrations, API changes, and infrastructure
  resources are named;
- acceptance tests and production evidence are objective;
- required secrets/accounts/licences/user decisions are available;
- rollback and compatibility approach are stated;
- no unresolved architecture decision is hidden inside implementation.

### 1.3 Definition of done

Every epic requires:

- all scoped behavior implemented; no placeholder success paths;
- changed contracts documented and generated artifacts committed;
- deterministic unit/integration/security tests;
- database migration from empty and production-shaped prior state where relevant;
- backward compatibility or an explicit cutover gate;
- structured logs/metrics for new failure modes without sensitive content;
- staging deployment/evidence for cloud or database behavior;
- reconciliation/rollback instructions;
- independent larger-model review with no unresolved blocking finding;
- merge to `main` and post-merge verification.

### 1.4 Standard child tasks

Each epic has these four child issue types. Their descriptions are specialized
per epic in Linear:

1. `Contract and fixtures`: exact types, state transitions, migrations, API/
   internal interfaces, deterministic fixtures, and negative cases.
2. `Implementation`: production code and additive migration/infrastructure.
3. `Integration and operations`: end-to-end behavior, observability, staging,
   backfill/reconciliation/rollback.
4. `Independent review and merge gate`: larger-model review, fixes, full suite,
   and merge evidence.

## 2. Project map

```mermaid
flowchart LR
  P1["Project 1: Trust and platform"] --> P2["Project 2: Canonical chess evidence"]
  P2 --> P3["Project 3: Analysis intelligence"]
  P3 --> P4["Project 4: Onboarding and coaching"]
  P4 --> P5["Project 5: Production launch"]
```

Projects are planning containers, not parallel phases. The epic dependency graph
below is authoritative; a later project may begin only where its predecessor
contracts are merged.

## 3. Project 1 — Trust and platform foundation

Outcome: the prototype stops exposing data and becomes a secure, versioned,
durable multi-service backend on which later evidence can safely depend.

### Milestone 1.1 — Production containment

#### Epic E01 — Contain live Supabase exposure and rotate credentials

Outcome: anonymous/browser credentials cannot access any internal current table,
the compromised database credential is rotated, runtime still works through a
named least-privilege path, and regression probes are committed.

Scope:

- snapshot live grants/RLS/exposed schemas without copying row bodies;
- immediately revoke `anon`/`authenticated` internal table/default privileges or
  remove `public` exposure using a reviewed forward migration;
- enable/force RLS or restrict schemas consistently for current tables;
- create anonymous and cross-user HTTP/database denial tests;
- rotate DB password and update runtime through Secret Manager;
- replace default compute service-account usage where needed for secret access;
- run API smoke tests and verify anonymous probes return denial/empty intentional
  public projections only;
- document incident, residual risk, rollback, and follow-up target migration.

Out of scope: designing all target tables or deleting current data.

### Milestone 1.2 — Database and API foundations

#### Epic E02 — Create target schema namespaces, roles, and migration harness

Outcome: additive target schemas and exact security boundary exist beside legacy
tables with one reviewed migration authority.

Scope:

- physical DDL conventions from `database-architecture.md`;
- `app`, `social`, `chess`, `analysis`, `coaching`, `ops`, `api`, `private`;
- service/migrator roles, grants, default privileges, RLS helpers/tests;
- schema catalogue recording ownership/retention/exposure class;
- migration from empty and production-shaped legacy snapshot;
- FK-index/static schema checks and Supabase advisor evidence;
- transaction-pool runtime configuration and aggregate connection budget;
- no legacy rename/drop or feature data yet.

#### Epic E03 — Establish `/v1` API kernel and authorization contract

Outcome: all new APIs share local JWT verification/fallback, actor-to-subject
authorization, problem details, validation, idempotency, request IDs, pagination,
ETags, redaction metadata, OpenAPI generation, and distributed edge controls.

Scope includes temporary compatibility middleware for legacy routes, but no
product endpoint migration beyond fixtures.

### Milestone 1.3 — Durable execution and service topology

#### Epic E04 — Implement workflow ledger, outbox, leases, and Cloud Tasks dispatch

Outcome: a committed command is never lost, duplicate delivery is safe, task
dependencies/cancellation/retry/dead-letter behavior is executable, and workflow
progress is queryable through `/v1/workflows`.

#### Epic E05 — Deploy isolated API, ops, ingestion, Stockfish, and analysis services

Outcome: immutable images deploy to private/public Cloud Run boundaries with
per-service identities, Secret Manager, explicit concurrency/connection budgets,
queues, schedules, jobs, staging promotion, and no engine/provider work in API.

## 4. Project 2 — Canonical chess evidence

Outcome: Forma owns an immutable, searchable, reference-counted record of exactly
what happened in supported games and can rebuild structural data deterministically.

### Milestone 2.1 — Identity and source ownership

#### Epic E06 — Implement subjects, provider identities, linked accounts, and discovery

Outcome: one personal subject can include multiple confirmed accounts; the same
provider identity can be linked by multiple users without granting shared private
analysis; public lookup uses only opt-in Forma/provider handles.

Includes `/v1/me`, account CRUD/lookup, memberships, rating observations,
provider aliases, public directory projection, tenancy tests, and migration of
legacy profiles/accounts without imposing global exclusivity.

### Milestone 2.2 — Storage and canonical sync

#### Epic E07 — Implement private Supabase artifact storage and lifecycle

Outcome: `ArtifactStore` and artifact metadata support verified immutable upload,
authorized signed download, orphan cleanup, permanent subject deletion, temporary
exports, and checksum-addressed system assets.

#### Epic E08 — Implement provider sync states, checkpoints, and immutable replay revisions

Outcome: Lichess and Chess.com incremental/full initial sync obey distributed
provider limits, reject all variants before persistence, atomically commit cursor
plus canonical records, append corrections, and resume safely after termination.

Includes source/participant/subject-game/source/rating records and the account
sync APIs. Raw mixed archives cannot retain rejected variants.

### Milestone 2.3 — Searchable positions and migration

#### Epic E09 — Materialize core positions, occurrences, transitions, and exact search

Outcome: every published replay yields the checked `ply + 1` occurrence chain,
legally canonical core keys, history-sensitive draw context, clocks, deterministic
transition facts, phase output, exact lookup, and typed structural feature set.

#### Epic E10 — Backfill legacy games and cut canonical reads to target evidence

Outcome: legacy identities/games/moves are additively backfilled, checksummed,
reconciled, shadow-read against v1 resources, and switched through explicit read
pointers/adapters. Legacy writes stop only after both provider journeys pass.
Legacy tables remain recoverable; destructive cleanup is outside this epic.

## 5. Project 3 — Analysis intelligence

Outcome: objective and practical chess outputs become reproducible evidence,
then trustworthy player trajectories/findings rather than mutable mistake rows.

### Milestone 3.1 — Versioned analysis execution

#### Epic E11 — Implement component/recipe versions, frozen snapshots, runs, and publication

Outcome: every derived result pins immutable inputs/dependencies; candidate runs
validate complete manifests; game/materialization/subject publications switch
atomically with history and rollback.

### Milestone 3.2 — Objective and practical decision analysis

#### Epic E12 — Implement isolated Stockfish screening, deep analysis, and cache scopes

Outcome: every transition receives compatible objective before/after evidence;
selected critical positions receive deeper MultiPV; exact cache scope/provenance,
resource budgets, duplicate delivery, and engine failure behavior are verified.

#### Epic E13 — Implement events, concepts, opportunities, and connections

Outcome: deterministic/versioned detectors capture successes and failures across
tactics, strategy, defence, prevention, tempo, quiet moves, conversion, recovery,
and other promoted concepts; atomic opportunities obey observed/censored/rubric
rules; cross-game relations explain comparability.

#### Epic E14 — Add calibrated human context and practical counterplay

Outcome: a licence-cleared promoted human model is benchmarked/calibrated by
provider/rating/speed slices and produces separate findability/human-outcome
evidence. Unsupported slices return unavailable. If no model passes, v1 launches
without these claims rather than substituting weakened Stockfish.

### Milestone 3.3 — Player-level intelligence

#### Epic E15 — Implement estimators, phase-aligned trajectory, findings, and explanations

Outcome: frozen subject snapshots produce coverage-aware current/stretch/
objective estimates, homepage trajectory/recovery bins, structured findings with
supporting and contradicting evidence, and prose rendered only from structured
facts. Method shadow comparison and multiple-finding controls are tested.

## 6. Project 4 — Onboarding and coaching product

Outcome: intelligence is converted into a high-quality examination, a chosen
goal, an actionable learning plan, and verified real-game improvement.

### Milestone 4.1 — Examination and activation

#### Epic E16 — Build onboarding orchestration, adaptive diagnostic, and immutable baseline

Outcome: signup-to-report works end to end for both providers, includes truthful
limited/out-of-range states, optional diagnostic attempts, entitlement-aware but
truthful report sections, and immutable baseline publication.

### Milestone 4.2 — Goal and rectification loop

#### Epic E17 — Implement goal templates, coaching cycles, requirements, and commitments

Outcome: a user chooses a measurable outcome/current or stretch standard, starts
a fixed-baseline cycle, edits explicit commitments, and receives versioned ranked
requirements/progress without moving goalposts silently.

#### Epic E18 — Unify practice, lessons, openings, schedules, and real-game transfer

Outcome: player-derived/editorial training items, assignments, append-only
attempts, server-validated answers, review scheduling, opening/repertoire/lesson
migration, interventions, and comparable later-game transfer form one evidence
loop. Practice alone never creates improvement.

## 7. Project 5 — Production launch and stewardship

Outcome: monetization, privacy, operations, cutover, and launch are safe and
measured without compromising evidence quality.

### Milestone 5.1 — Access and public product

#### Epic E19 — Implement entitlements, usage ledger, and Stripe lifecycle

Outcome: features/limits are server-authoritative, quota reservation is atomic,
Stripe checkout/portal URLs are allowlisted, signed webhook processing is
idempotent/out-of-order safe, manual grants are audited, and billing reconciles.

#### Epic E20 — Publish curated case studies and production public projections

Outcome: famous/random-level case studies and public directory/statistics use
explicit editorial subjects, provenance/licence/consent, immutable publications,
small-cell/privacy rules, and no private account inference.

### Milestone 5.2 — Privacy and operations

#### Epic E21 — Implement export, unlink retention, and complete account deletion

Outcome: reference-aware deletion covers Postgres, Supabase Storage, queued work,
Auth, logs/audit receipts, and shared anonymous cache rules; object failure
prevents false completion; export manifests/checksums/expiry work end to end.

#### Epic E22 — Complete observability, load, recovery, and cost hardening

Outcome: dashboards/alerts/runbooks/budgets, DB/query/connection tests, provider
rate-limit tests, worker termination/duplicate tests, backup/restore drills,
analysis quality/cost benchmarks, and capacity envelopes meet launch gates.

### Milestone 5.3 — V1 cutover

#### Epic E23 — Migrate frontend consumers, reconcile, cut over, and launch v1

Outcome: all frontend journeys consume `/v1`; legacy endpoints emit measured
deprecation, current data is reconciled, staging and production smoke journeys
pass, rollback is rehearsed, security/licence review is signed, and launch gates
are recorded. Legacy data is not dropped in this epic.

## 8. Dependency order

The default linear order is:

`E01 -> E02 -> E03 -> E04 -> E05 -> E06 -> E07 -> E08 -> E09 -> E10 -> E11 ->
E12 -> E13 -> E14 -> E15 -> E16 -> E17 -> E18 -> E19 -> E20 -> E21 -> E22 -> E23`

This is intentionally conservative. A later implementation review may permit a
child task to run concurrently when it cannot touch an unstable dependency, but
the parent epic review/merge order remains linear.

E14 is a conditional quality gate: failure to promote a human model removes
human-model claims from v1 but does not block E15's objective/deterministic
trajectory and findings. The unavailable behavior must already be tested.

## 9. Traceability matrix

| Product requirement | Data contract | API surface | Primary epic |
| --- | --- | --- | --- |
| Multiple accounts, no global exclusivity | subjects/provider identities/links/memberships | `/me/accounts` | E06 |
| Completed standard games only | sync/replay validation | account sync resources | E08 |
| Search exact/similar player positions | core/occurrence/transition/features | positions related/connections | E09 |
| Reproducible changing methods | components/recipes/runs/snapshots/publications | version metadata | E11 |
| Objective decision quality | evaluations/candidates/transition assessments | game review/evaluation | E12 |
| Successes, failures, defence, tempo, plans | events/concepts/opportunities/evidence | concepts/findings/connections | E13 |
| Practical counterplay by player level | model inference/policy/calibration | review/finding context | E14 |
| Recovery and typical game shape | trajectory episodes/snapshots/bins | dashboard trajectory | E15 |
| Honest strengths/patterns/uncertainty | estimates/findings/evidence | dashboard/findings | E15 |
| Large onboarding examination | onboarding/coverage/report | onboarding/baseline APIs | E16 |
| Optional uncertainty-reducing puzzles | diagnostic session/items/attempts | diagnostic APIs | E16 |
| Goals and dream translated into plan | goals/cycles/targets/requirements/commitments | goals APIs | E17 |
| Rectification and tracked improvement | items/interventions/attempts/transfer | practice/transfers | E18 |
| Openings and lessons | unified coaching plus catalogue projections | openings/lessons | E18 |
| Free/paid visibility | catalogue/grants/usage/subscription | plans/billing/redactions | E19 |
| Famous/random-level case studies | editorial subjects/publications | case studies | E20 |
| Export/deletion | artifact/dependency/deletion workflows | me export/deletion | E21 |
| Reliable multi-deployment backend | workflows/outbox/attempts | workflow/internal APIs | E04–E05 |

## 10. Ticket description contract

Every Linear epic and task description contains:

- Outcome: the user/system state that will be true;
- Why: exact v1 requirement and risk;
- Authoritative references: named spec sections;
- Preconditions and `blockedBy` relationship;
- In scope and explicitly out of scope;
- data/API/event/state contracts affected;
- implementation constraints and forbidden shortcuts;
- acceptance criteria as verifiable statements;
- required unit/integration/security/performance fixtures;
- migration, rollout, reconciliation, and rollback evidence;
- observability and privacy requirements;
- handoff artifacts and independent review instructions.

An epic is not considered self-described if its agent must invent a product
policy, ownership rule, method meaning, storage lifecycle, retry behavior, or
success criterion.
