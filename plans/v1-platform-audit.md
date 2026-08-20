# Forma v1 platform audit

Status: canonical audit input for v1 planning  
Audited: 2026-08-15  
Scope: product requirements, repository, live Supabase posture, deployed Cloud
Run service, storage, workflows, analysis contracts, API surface, and delivery
readiness

## 1. Executive conclusion

The repository is a working prototype, not a safe foundation on which to add the
remaining v1 features incrementally. Its deterministic tests and builds pass,
and useful provider, chess, engine, opening, and benchmark code can be retained.
The persistence, security, orchestration, and API boundaries must be migrated to
the target architecture before product intelligence is built on top of them.

The greatest risk is not a missing feature. It is allowing mutable legacy rows,
in-process work, or unversioned results to become the evidence base for player
claims. The database architecture plan already supplies the correct conceptual
model. V1 needs to turn it into exact physical contracts and make every API and
worker depend on those contracts.

## 2. Evidence inspected

- `PRODUCT.md`, `DESIGN.md`, `README.md`;
- `plans/database-architecture.md` and `plans/opening-sheet.md`;
- all server source, Drizzle schema and migrations, test suites, Dockerfile,
  package configuration, and frontend API call sites;
- the live Supabase table, RLS, policy, and grant catalogue;
- the deployed Google Cloud Run service configuration and available GCP
  resources;
- the connected Linear team, statuses, labels, projects, and archived issues;
- current official Supabase, Cloud Run, Cloud Tasks, Lichess, and Chess.com API
  documentation.

No production data values, credentials, bearer tokens, PGNs, or analysis
payloads were copied into this audit.

## 3. What is already valuable

### 3.1 Code that can be evolved

- provider-neutral Lichess and Chess.com adapters;
- PGN parsing and legal move/FEN generation;
- canonical provider game IDs and replay fingerprints;
- standard-chess rejection in both provider paths;
- Stockfish process wrapper and versioned profile/cache-key groundwork;
- critical-position selection and phase-classification fixtures;
- opening tree and catalogue logic;
- benchmark corpus and deterministic fixture adapter;
- Supabase bearer-token authentication boundary;
- CORS allowlist for the Pages and custom domains.

### 3.2 Verification currently passing

On 2026-08-15 the following passed from a clean invocation:

- server TypeScript typecheck;
- canonical ingestion, PGN, provider, sync, and phase tests;
- pipeline state and CORS tests;
- opening model and tree tests;
- benchmark corpus and report quality-gate tests;
- frontend typecheck and production build.

Passing prototype tests do not verify live tenancy, migration safety, durable
work execution, deletion, or the target data model.

## 4. Confirmed critical findings

### A-01: live Supabase data is exposed through the anonymous Data API role

Severity: critical. This blocks treating the current environment as production.

The live database has no application policies in `pg_policies`. The standard
`anon` and `authenticated` roles have broad privileges on current public tables.
Anonymous requests using the browser-safe Supabase key successfully returned
rows from:

- `profiles`;
- `linked_accounts`;
- `games`;
- `analysis_tasks`;
- `position_eval`.

The read probe returned only status/count evidence to the audit and did not
retain row bodies. Tables such as `games`, `profiles`, and `linked_accounts` do
not have RLS enabled. Other tables have RLS enabled but no policies; this is not
a coherent authorization model.

Required response:

1. rotate the previously exposed database credential;
2. immediately revoke browser-role access to internal current tables or remove
   `public` from exposed Data API schemas;
3. verify the API still operates with a named least-privilege runtime role;
4. add automated anonymous and cross-user denial tests;
5. repeat the catalogue and HTTP probes after every migration.

This is an emergency hardening change, not the final target-schema migration.

### A-02: API and engine share one autoscaling process

Severity: critical for reliability and cost.

The deployed service is public, uses the default Compute Engine service account,
has 1 vCPU/512 MiB, request concurrency 80, timeout 300 seconds, and may scale to
20 instances. The same Node process serves API requests, fetches provider data,
claims analysis tasks, and runs Stockfish.

Consequences:

- one container may admit far more concurrent engine work than its CPU can run;
- public traffic and engine load contend for CPU, memory, and database sessions;
- container termination can interrupt un-awaited ingestion work;
- scaling the API also scales potential Stockfish and database pressure;
- a broad default service account is shared by all responsibilities.

Required response: isolate API, provider ingestion, Stockfish, and aggregation
behind private authenticated worker services and explicit queue/concurrency
budgets.

### A-03: background work is process-local rather than durably dispatched

Severity: critical for correctness.

`createImport` starts ingestion with an un-awaited promise. The worker loop is
started by an in-process boolean. Recovery runs only when an API container
starts. There is no Cloud Tasks queue, dispatcher, scheduler, or Cloud Run Job.

The existing `analysis_tasks` claim uses `FOR UPDATE SKIP LOCKED`, which is a
useful primitive, but queue creation, retry timing, dead letters, dependency
completion, publication, and recovery are not represented as the general
durable workflow contract required by v1.

### A-04: current re-import mutates canonical history

Severity: critical for evidence reproducibility.

`upsertGame` updates a mutable game row, deletes every `canonical_moves` row,
and reinserts the current replay. This destroys the prior normalized replay and
means an old analysis can no longer identify the exact input it analyzed.

Required response: append immutable replay revisions, materialize positions and
transitions from a named revision, and publish a pointer to the accepted current
revision.

## 5. Architectural contradictions

| Contract | Target decision | Current behavior | Resolution |
| --- | --- | --- | --- |
| Provider account ownership | No global exclusivity | `linkAccount` refuses a handle linked by another user | Split global provider identity from user-owned linked account; permit independent links |
| Personal evidence ownership | Through subject/source relationships | Most tables key directly to `user_id` and username | Introduce subject, membership, subject-game, and source records |
| Replay authority | Immutable revision | Mutable `games` plus deleted/reinserted moves | Append replay revisions and publish current pointer |
| Position identity | Core position separated from historical context | Full FEN repeated on every move | Core-position key plus occurrence/context rows |
| Analysis outputs | Immutable, versioned, atomically published | Results stored in mutable task JSON/cache rows | Runs, model profiles, typed outputs, publications |
| Player claims | Evidence includes successes, failures, censored opportunities | Central `mistakes` table | Transition assessments, events, concept opportunities, evidence, estimates, findings |
| Improvement | Requires comparable later real-game transfer | Practice counters are treated as progress | Practice attempts plus explicit transfer matching |
| Baseline | Immutable | No baseline report object | Frozen data snapshot, report manifest, publication |
| Long work | Durable private workers | In-process API work | Outbox, Cloud Tasks, private workers, leases |
| Storage | Supabase Storage artifact lifecycle | GCS columns/dependency exist but no storage writes | Storage abstraction and private Supabase buckets |
| Browser access | Auth only in browser; product data through API | Internal `public` tables exposed through Data API | Private schemas, revoked defaults, least privilege |
| API | `/v1`, stable resources/errors/idempotency | Ad hoc unversioned routes and `{error}` bodies | Versioned resource API and problem details |

## 6. Missing product contracts

The database plan names the right objects. The following contracts still need
to be made explicit before implementation tickets are executable:

1. V1 inclusion and cohort policy: all completed standard games are retained;
   rated human rapid/blitz/classical games form the default evidence cohort;
   other supported speeds and casual/bot games remain separately queryable.
2. Coverage decision: `coverage_policy_v1` uses 50 eligible games as the
   provisional threshold for a broad baseline, but returns dimension-specific
   sufficiency and uncertainty rather than a binary “enough data” claim.
3. Rating applicability: Forma serves roughly 1000–2200 online rating; results
   outside calibrated bands must state reduced applicability rather than mark
   every move right or wrong.
4. Diagnostic contract: onboarding may ask a small adaptive set of positions to
   reduce uncertainty; diagnostic success is not real-game improvement.
5. Comparison frames: every skill view can expose current-standard,
   stretch-standard, and objective-standard results. The stretch standard is a
   versioned target-rating policy, not a hard-coded `rating + z` formula.
6. Forma skill profile: this is a multidimensional evidence estimate, not a new
   public competitive rating and not a guarantee of future provider Elo.
7. Homepage trajectory: phase-aligned landmark registration is v1; unconstrained
   dynamic time warping is excluded because it can align unrelated blunders.
8. Practical counterplay: Stockfish defines objective adequacy; a calibrated
   rating-conditioned human policy estimates findability. Objective and human
   WDL/probability outputs are never merged into one field.
9. Goal completion: requires its named metric, confidence rule, and real-game
   transfer evidence where the goal concerns playing strength.
10. Free/paid visibility: access is represented by entitlements and redaction
    manifests; reports must not fabricate positive results for free users.
11. Public case studies: only editorial subjects with documented source,
    licensing/permission basis, immutable analysis version, and no implication
    of account ownership.

## 7. Missing API and backend contracts

- no canonical `/v1` resource naming or compatibility policy;
- no `application/problem+json` error schema or stable error codes;
- no request/correlation ID contract;
- no idempotency-key storage and replay behavior at command endpoints;
- no general workflow resource or cancellation semantics;
- no opaque keyset pagination contract;
- no response-level publication/version provenance;
- no API-level subject authorization primitive;
- no internal worker authentication and task payload contract;
- no signed artifact-download authorization path;
- no account unlink/deletion/export workflow;
- no atomic dashboard/baseline/report publication;
- no OpenAPI document or contract compatibility tests;
- no provider-wide serial/rate-limit coordinator;
- no distributed rate limiter for public or expensive endpoints.

## 8. Missing infrastructure and operations

Current GCP contains one Cloud Run service and one source-deploy Artifact
Registry repository. No Cloud Run Jobs, Cloud Tasks queues, Cloud Scheduler
jobs, or Secret Manager secrets were found in the configured project.

Required v1 resources:

- separate staging and production Supabase projects in EU regions;
- separate staging and production GCP projects where practical;
- public `forma-api` Cloud Run service;
- private `forma-ops`, `forma-ingestion-worker`, `forma-stockfish-worker`, and
  `forma-analysis-worker` services;
- Cloud Tasks queues split by resource/rate profile;
- Cloud Scheduler triggers for outbox, due syncs, lease recovery, retention, and
  reconciliation;
- Cloud Run Jobs for migrations, backfills, catalogue imports, rebuilds, and
  recovery drills;
- Google Secret Manager and a distinct service account per deployment;
- Artifact Registry images promoted by immutable digest;
- Supabase Storage private `subject-artifacts`, `system-artifacts`, and `exports`
  buckets;
- structured logging, service/workflow metrics, alerts, budgets, and runbooks;
- CI gates and environment promotion/rollback workflow.

Not required for v1: Kubernetes, Kafka, Pub/Sub, Redis, BigQuery, an always-on
worker pool, a GPU deployment, Lc0 production inference, or WebSockets.

## 9. Provider constraints that shape the design

- Lichess asks API clients to make one request at a time and to stop for a full
  minute after HTTP 429. Limits can change.
- Chess.com's PubAPI permits serial access but may rate-limit parallel work and
  supports ETag/Last-Modified caching.
- Therefore provider throttling is global/distributed per provider, not an
  in-memory map in each worker instance.
- Provider calls are idempotent, conditional where possible, and separated from
  the short database transaction that commits a checkpoint.
- “Endless public data” is not an availability guarantee. Research/case-study
  corpora use documented sources and licences and never compete with user syncs.

## 10. Security and privacy gaps

- production database password rotation remains required after prior accidental
  disclosure;
- runtime secrets are plain Cloud Run environment values, not Secret Manager
  references;
- default compute service account is used;
- no checked-in database policies or grant tests;
- local bearer-token cache and local IP rate limiter are instance-specific;
- auth verification adds a Supabase network request and caches raw bearer-token
  keys in process memory;
- error mapping can return internal messages and maps unrelated exceptions to
  404;
- Stripe return URLs are supplied by the client without an allowlist;
- public catalogue import/rebuild commands sit behind user auth, not an operator
  capability;
- deletion and export are not implemented end to end;
- logs are not governed by a tested redaction contract.

## 11. Performance and scale gaps

- no explicit Postgres connection maximum per service or aggregate budget;
- current Cloud Run runtime uses a session-pooler URL, while autoscaling runtime
  traffic should use the transaction pooler with prepared statements disabled;
- migrations need a separate direct/admin connection;
- canonical moves are inserted one row at a time;
- no production-shaped database benchmarks or `EXPLAIN` baselines;
- several high-volume target queries need composite/partial indexes tied to the
  query catalogue;
- no queue-age, connection-pressure, cache-hit, or engine-saturation metrics;
- no tested lease-expiry, duplicate-delivery, or publication-contention load.

## 12. Delivery conclusion

Do not translate the archived Tempo tickets into a new backlog. They mix legacy
objects and target concepts and are too small to be safe autonomous-agent units.
The new delivery graph must begin with security containment and platform
contracts, then proceed linearly through canonical evidence, analysis,
interpretation, onboarding, coaching, and production cutover.

Every epic must leave `main` in a deployable, backward-compatible state and must
include its migrations, contracts, fixtures, observability, security tests,
documentation, rollback path, and reconciliation evidence. A larger-model review
is a merge gate, not a substitute for executable acceptance tests.
