# Forma v1 API contract

Status: normative v1 interface  
Base URL: `https://api.<forma-domain>/v1`  
Format: JSON over HTTPS; OpenAPI 3.1 is generated from the implementation and
checked against this contract

## 1. Conventions

### 1.1 Authentication

Protected endpoints require:

```http
Authorization: Bearer <supabase-access-token>
```

The API derives actor/profile/subject from the token. A client never selects a
`userId` or arbitrary subject. Public endpoints are explicitly marked public.

### 1.2 Success bodies

One resource:

```json
{
  "data": {},
  "meta": {
    "requestId": "req_..."
  }
}
```

A collection:

```json
{
  "data": [],
  "page": {
    "nextCursor": null,
    "hasMore": false
  },
  "meta": {
    "requestId": "req_..."
  }
}
```

Claim-bearing reads add a version block as applicable:

```json
{
  "publicationId": "uuid",
  "generatedAt": "2026-08-15T12:00:00Z",
  "subjectSnapshotId": "uuid",
  "recipeVersionId": "uuid",
  "policyVersions": {
    "coverage": "coverage_policy_v1",
    "estimator": "estimator_v1"
  }
}
```

Fields that are unknown are `null`; known-empty collections are `[]`. Omitted
fields are reserved for entitlement redaction or endpoint projection and are
listed in `meta.redactions`.

### 1.3 Errors

Errors use `Content-Type: application/problem+json`:

```json
{
  "type": "https://docs.<forma-domain>/problems/insufficient-coverage",
  "title": "More game evidence is needed",
  "status": 409,
  "code": "INSUFFICIENT_COVERAGE",
  "detail": "The baseline can continue, but endgame conclusions are limited.",
  "instance": "/v1/onboarding/runs/...",
  "requestId": "req_...",
  "errors": [
    { "path": "games", "code": "MINIMUM_NOT_MET", "message": "..." }
  ],
  "retryable": false,
  "retryAfterSeconds": null
}
```

Stable codes include `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`,
`VALIDATION_FAILED`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`,
`ENTITLEMENT_REQUIRED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`,
`UNSUPPORTED_GAME`, `INSUFFICIENT_COVERAGE`, `WORKFLOW_NOT_CANCELLABLE`, and
`INTERNAL_ERROR`. Internal exceptions, SQL, stack traces, provider bodies, and
secrets never enter responses.

### 1.4 Idempotency

`Idempotency-Key` is required on every endpoint marked command. It is an opaque
client-generated value up to 128 characters. The server stores actor, route,
normalized request digest, response/workflow reference, and expiry.

- identical actor/route/body returns the original status and resource;
- the same key with a different request returns `409 IDEMPOTENCY_CONFLICT`;
- retries may occur after transport failure without duplicating work;
- Stripe webhook idempotency uses Stripe event ID in addition to this mechanism.

### 1.5 Pagination and filtering

- `limit` defaults to 25 and is capped at 100 unless specified;
- `cursor` is opaque, signed/versioned, and binds filters/sort;
- list order is stable with ID as final tiebreaker;
- malformed/mismatched cursors return `400 VALIDATION_FAILED`;
- dates are ISO-8601 UTC, booleans are `true|false`, and multi-values repeat the
  query parameter.

### 1.6 Concurrency and caching

- mutable resources return `ETag`; updates accept `If-Match` where indicated;
- immutable reports/replay revisions can be privately cached by ID;
- published dashboard resources use private short caching and publication ID;
- public catalogue/case-study resources may use CDN cache headers;
- commands are never cached.

## 2. Shared resources

### 2.1 Workflow

```json
{
  "id": "uuid",
  "kind": "initial_examination",
  "state": "queued|running|succeeded|failed|cancelling|cancelled",
  "progress": {
    "completedWeight": 25,
    "totalWeight": 100,
    "percent": 25,
    "stage": "objective_analysis",
    "message": "Analysing critical decisions"
  },
  "resource": { "type": "onboardingRun", "id": "uuid" },
  "error": null,
  "cancellable": true,
  "createdAt": "...",
  "startedAt": null,
  "completedAt": null,
  "updatedAt": "..."
}
```

Progress is monotonic for a workflow attempt but may pause. `percent` is `null`
when total work is not yet known. Safe errors do not contain task payloads.

### 2.2 Linked account

```json
{
  "id": "uuid",
  "provider": "lichess|chesscom",
  "username": "DisplayCase",
  "providerIdentityId": "uuid",
  "verification": "unverified|confirmed|verified|revoked",
  "includedInPersonalSubject": true,
  "discoverableByProviderHandle": false,
  "sync": {
    "state": "idle|due|running|backoff|failed|disabled",
    "lastSuccessfulAt": null,
    "nextEligibleAt": null,
    "historyComplete": false
  },
  "createdAt": "..."
}
```

### 2.3 Coverage

```json
{
  "policyVersion": "coverage_policy_v1",
  "eligibleGames": 42,
  "totalSupportedGames": 61,
  "broadStatus": "limited|sufficient",
  "provisionalMinimum": 50,
  "calibrationStatus": "in_range|outside_calibrated_range|unknown",
  "dimensions": [
    {
      "key": "concept:tactical.fork:actor",
      "rawN": 8,
      "effectiveN": 5.4,
      "status": "insufficient|limited|sufficient",
      "missing": "More comparable real-game opportunities"
    }
  ]
}
```

### 2.4 Evidence summary

Every finding/estimate exposed to the client can link to:

```json
{
  "estimate": 0.64,
  "interval": { "low": 0.51, "high": 0.75, "level": 0.9 },
  "rawN": 38,
  "effectiveN": 24.7,
  "coverage": "sufficient",
  "comparisonFrame": "personal_current|peer_current|peer_stretch|objective",
  "supportingEvidenceCount": 20,
  "contradictingEvidenceCount": 7,
  "estimatorVersion": "estimator_v1"
}
```

## 3. Public endpoints

### `GET /health`

Public. Liveness only. Returns service/revision/time. It does not touch the DB or
reveal dependencies. Internal readiness endpoints are private.

### `GET /public/stats`

Public. Returns explicitly approved aggregate product reach. No exact small-cell
counts or private segmentation. Cacheable.

### `GET /public/plans`

Public. Returns display plan catalogue, prices/currency/intervals, feature copy,
and whether checkout is available. Server entitlements remain authoritative.

### `POST /public/beta-signups`

Public command with distributed IP/email abuse controls.

Request: `{ name, email, platform, username?, ratingBand?, goal? }`.  
Response: `202` with a generic accepted resource; it never confirms whether an
email already exists.

### `GET /directory/players?query=&cursor=&limit=`

Public. Prefix search of opted-in unique Forma handles and, only when enabled by
that profile, provider handles. Minimum query length 2; rate limited. Returns
public profile summaries only.

### `GET /directory/players/{formaHandle}`

Public. Returns public profile fields and opted-in provider handles. It never
returns email, linked-account IDs, private findings, goals, or game history.

### `GET /case-studies` and `GET /case-studies/{slug}`

Public editorial publications. Response identifies source/permission basis,
analysis publication/version, generated date, caveats, and redaction status.

## 4. Profile, privacy, and account endpoints

### `GET /me`

Returns profile, personal subject ID, public-profile settings, linked-account
summary, onboarding state, active goal summary, subscription, entitlements, and
usage summary.

### `PATCH /me`

Protected; `If-Match` required. Request may update display name, unique Forma
handle, locale/time zone, and public discovery flags. Handle changes preserve an
alias/redirect policy and are rate limited.

### `POST /me/exports`

Command. Request `{ format: "full_v1" }`. Returns `202` workflow and export
resource. Export generation is private asynchronous work.

### `GET /me/exports`, `GET /me/exports/{exportId}`

Lists/returns export state, manifest summary, expiry, and download availability.

### `GET /me/exports/{exportId}/download`

After ownership/state check, returns `302` or `{url, expiresAt}` containing a
short-lived signed URL. Never accepts a bucket/key.

### `DELETE /me`

Command. Request `{ confirmation: "DELETE", reason? }`. Returns `202` deletion
workflow. Repeated calls return the existing deletion resource.

### `GET /me/deletion`

Returns requested/state/stage/deadline/completion receipt. It never returns
already-deleted content.

## 5. Provider and linked-account endpoints

### `GET /platforms/{provider}/players/{username}`

Protected, rate limited. Returns public lookup confirmation and normalized
profile/rating summaries. `found:false` differs from provider unavailable.

### `GET /me/accounts`

Returns linked accounts. Optional `included=true|false` filter.

### `POST /me/accounts`

Command. Request:

```json
{
  "provider": "lichess",
  "username": "Example",
  "confirmation": "I confirm this is the account I want analysed",
  "includeInPersonalSubject": true
}
```

Returns `201` linked account. The same provider identity may be linked by another
Forma user. Duplicate link by the same user is idempotent. Verification state is
truthful.

### `GET /me/accounts/{accountId}`

Returns account, membership, rating summaries, coverage, and sync state.

### `PATCH /me/accounts/{accountId}`

`If-Match` required. Updates subject inclusion and provider-handle discovery.
Changing inclusion creates downstream recalculation workflow where necessary.

### `DELETE /me/accounts/{accountId}`

Command. Unlinks and starts reference-aware cleanup. Request may include
`deleteExclusiveImportedData` (default true). Returns `202` workflow. It cannot
delete data still owned by another source.

### `POST /me/accounts/{accountId}/syncs`

Command. Request `{ mode: "incremental|full_reconcile" }`; ordinary users may
request incremental only, operator capability is required for full reconcile.
Returns `202` workflow and sync run. Duplicate active sync returns the existing
resource.

### `GET /me/accounts/{accountId}/syncs`

Cursor list of sync runs.

### `GET /me/accounts/{accountId}/syncs/{syncId}`

Returns checkpoints/progress/rejection aggregates and safe error/backoff status.
No unsupported game IDs are returned.

## 6. Workflow endpoints

### `GET /workflows?state=&kind=&cursor=&limit=`

Lists workflows owned by the personal subject/profile.

### `GET /workflows/{workflowId}`

Returns the shared workflow resource.

### `POST /workflows/{workflowId}/cancel`

Command. Returns `202` while cancellation drains or `409` if terminal/not
cancellable. Cancellation does not undo already published immutable facts.

## 7. Game and position endpoints

### `GET /games?accountId=&speed=&color=&result=&from=&to=&analysisState=&cursor=&limit=`

Returns subject-owned game summaries ordered by `playedAt desc, id desc`.
Provider/source duplicates resolve to one subject game with source badges.

### `GET /games/{gameId}`

Returns metadata, participants, subject perspective, current replay revision,
analysis/publication state, and available review summary. Ownership is checked
through subject-game relationships.

### `GET /games/{gameId}/review`

Returns replay moves/positions, transition assessments, critical moments,
events, concepts, explanations, trajectory, and evidence links for one coherent
published run. Pending/failed/unavailable components are explicit.

### `POST /games/{gameId}/analysis`

Command. Request `{ reason: "user_request", recipe?: "current" }`. Recipe and
limits are selected server-side. Returns existing compatible publication or
`202` workflow. Users cannot request arbitrary depth/threads/nodes.

### `GET /games/{gameId}/connections?ply=&kind=&cursor=&limit=`

Returns evidence-backed links from a game occurrence/event to prior/later
occurrences, practice, findings, or transfer. Each connection states why it is
comparable and its versioned similarity/matching evidence.

### `GET /positions/{occurrenceId}`

Returns authorized occurrence context, core position, transition neighbors,
and published analysis. Core position alone does not expose another subject's
occurrence.

### `GET /positions/{occurrenceId}/related?mode=exact|structural&cursor=&limit=`

Returns owned/authorized related occurrences. `structural` uses a named feature
and similarity policy. Semantic embedding mode is not authoritative v1 API.

## 8. Dashboard, finding, and concept endpoints

### `GET /dashboard`

Returns one atomic live publication:

- headline trajectory and recovery summary;
- current goal/progress/next action;
- top strengths, constraints, and changes;
- coverage/calibration warnings;
- representative connections;
- sync/analysis freshness;
- entitlement redactions;
- full publication/version block.

### `GET /dashboard/trajectory?speed=&color=&from=&to=`

Returns phase landmarks/bins, sample/survival counts, center/interval, adverse
change and recovery summaries, alignment version, and filter echo.

### `GET /dashboard/rating-profile`

Returns provider ratings by pool plus Forma multidimensional skill estimates.
It explains pool non-comparability and never presents a single “intellect Elo.”

### `GET /findings?kind=&skill=&status=&cursor=&limit=`

Lists structured published findings with evidence summary, rank, confidence,
change direction, and entitlement visibility.

### `GET /findings/{findingId}`

Returns claim, scope, comparison frame, supporting/contradicting/censored
evidence, estimator/version, representative examples, explanation, and action.

### `GET /concepts?parent=&cursor=&limit=`

Returns public/promoted concept catalogue and definitions.

### `GET /concepts/{conceptKey}`

Returns concept/version/rubric, role distinctions, and subject estimate when
authorized.

### `GET /concepts/{conceptKey}/history?speed=&role=&cursor=&limit=`

Returns time-ordered atomic opportunities/evidence and estimates. Threat
recognition, prevention, and execution remain distinct.

## 9. Onboarding endpoints

### `GET /onboarding`

Returns current state: `not_started|linking|syncing|analysing|diagnostic|
report_ready|goal_setting|activated`, active run/workflow, coverage, and allowed
next actions.

### `POST /onboarding/runs`

Command. Request `{ accountIds: ["uuid"], diagnostic: "adaptive|skip" }`.
Creates/fetches initial examination workflow. Baseline input snapshot freezes
only when ingestion/coverage selection completes.

### `GET /onboarding/runs/{runId}`

Returns run state, workflow, coverage, frozen snapshot/report IDs, and next
action.

### `GET /onboarding/runs/{runId}/coverage`

Returns shared coverage resource with selection/rejection aggregates.

### `POST /onboarding/runs/{runId}/diagnostic-sessions`

Command. Creates a bounded adaptive session from the frozen evidence questions.
Returns `201` with first item. Repeated request returns existing open session.

### `GET /diagnostic-sessions/{sessionId}`

Returns state, progress, current item (without answer), and completed summary.

### `POST /diagnostic-sessions/{sessionId}/attempts`

Command. Request `{ itemId, moveUci, thinkTimeMs, clientAttemptId }`. Server
validates legality and scores with the session's immutable rubric. Returns the
attempt, explanation, and next item. Attempt rows are append-only.

### `GET /baseline-reports` and `GET /baseline-reports/{reportId}`

Lists/returns immutable baseline report manifest and sections. Detail redaction
is represented explicitly by entitlement; report facts do not mutate.

### `POST /onboarding/complete`

Command. Requires baseline report, active goal, and accepted current commitment.
Returns activation state; it does not create missing objects implicitly.

## 10. Goal and coaching-cycle endpoints

### `GET /goal-templates?category=&cursor=&limit=`

Returns promoted versioned goal templates, applicability, metric/evidence
requirements, typical commitment options, and calibration caveats.

### `GET /goals`

Lists goals and current status.

### `POST /goals`

Command. Request selects `goalTemplateVersionId` or a bounded custom outcome,
target time horizon, comparison frame, and account/speed scope. Returns a draft
goal with resolvable metric targets; impossible/uncalibrated promises are
rejected or caveated.

### `GET /goals/{goalId}`

Returns immutable target definition plus mutable lifecycle/current publication.

### `PATCH /goals/{goalId}`

`If-Match` required. Pauses/resumes or edits allowed mutable fields. Changing
target semantics creates a new goal/version rather than rewriting history.

### `POST /goals/{goalId}/cycles`

Command. Creates a coaching cycle with start/end, baseline publication, target
metrics, and plan generation workflow.

### `GET /goals/{goalId}/plan`

Returns ranked requirements/interventions, explanation, schedule, and version.

### `PUT /goals/{goalId}/commitments/{commitmentKey}`

Command with `If-Match`. Request `{ target, cadence, unit, enabled }`. Examples:
games/week, reviewed games/week, practice sessions/week. Commitments are not
quietly inferred from activity.

### `GET /goals/{goalId}/progress`

Returns metric progress, commitment adherence, real-game transfer evidence,
confidence, blockers, and next action.

### `POST /goals/{goalId}/close`

Command. Request `{ outcome: "completed|abandoned|replaced", note? }`. Completion
must satisfy goal evidence rules; otherwise the response distinguishes user
closure from demonstrated target achievement.

## 11. Practice and lesson endpoints

### `GET /practice/queue?kind=&limit=`

Returns due assignments ranked with reason/evidence and entitlement limits.
Maximum 50.

### `GET /practice/assignments/{assignmentId}`

Returns prompt/position, allowed interaction, source finding/intervention, and
version. Solutions remain hidden until attempt/reveal policy allows.

### `POST /practice/assignments/{assignmentId}/attempts`

Command. Request includes stable `clientAttemptId`, answer/move line, timing,
hints/reveals. Server validates. Returns immutable attempt result and schedule
update. Client-supplied “correct” counters are never authoritative.

### `GET /practice/activity?from=&to=&cursor=&limit=`

Returns practice attempts/adherence separately from real-game transfer.

### `GET /practice/transfers?goalId=&concept=&cursor=&limit=`

Returns comparable later-game matches with `positive|negative|inconclusive`,
matching evidence, prior intervention, and confidence.

### `GET /lessons` and `GET /lessons/{slug}`

Returns promoted versioned lesson catalogue/content metadata and user progress.

### `POST /lessons/{slug}/attempts`

Command. Records validated step/lesson completion evidence rather than accepting
arbitrary aggregate progress counters.

## 12. Opening endpoints

### `GET /openings/explorer?accountId=&speed=&color=&since=&family=&position=&cursor=`

Returns the subject's versioned opening read model, coverage, current node,
outgoing transitions, outcome/evaluation/knowledge summaries, and source
publication. Filters bind the cursor.

### `GET /openings/repertoire?color=`

Returns selected families and position choices.

### `PUT /openings/repertoire/positions/{positionKey}`

Command with `If-Match`. Request `{ moveUci, enabled }`; validates legal move and
subject ownership/applicability. Rebuild is an asynchronous internal consequence,
not a public “rebuild everything” endpoint.

### `GET /openings/drills?color=&family=&cursor=&limit=`

Returns opening assignments through the unified practice model.

### `POST /openings/drills/{assignmentId}/attempts`

Alias/typed variant of the practice-attempt contract; one authoritative attempt
path is used internally.

Catalogue import/rebuild endpoints are internal operator commands, not user API.

## 13. Billing endpoints

### `GET /billing/subscription`

Returns safe subscription state, current entitlements, billing period, and
management availability. No payment method details.

### `POST /billing/checkout-sessions`

Command. Request `{ priceKey, interval }`; server maps to allowlisted Stripe
price and environment return URLs. Client does not supply arbitrary URLs.

### `POST /billing/portal-sessions`

Command. Server selects allowlisted return URL. Returns short-lived Stripe URL.

### `POST /billing/webhooks/stripe`

Public only to Stripe; raw-body signature required. Stores/deduplicates event,
handles out-of-order lifecycle events, and queues reconciliation when needed.
Always separates webhook receipt from slow side effects.

## 14. Bounded interactive engine endpoints

Interactive analysis is not the historical-analysis pipeline.

### `POST /positions/evaluations`

Protected, rate/entitlement limited. Request `{ fen, purpose }`. Server validates
standard legal FEN and selects fixed profile/time/nodes. Returns immediate cached
result or `202` workflow. No arbitrary depth/threads/MultiPV parameters.

### `POST /play/sessions`

Command. Request `{ color, levelKey, initialFen? }`; level/profile is server
catalogue. Returns session.

### `POST /play/sessions/{sessionId}/moves`

Command. Request `{ moveUci, clientMoveId }`; validates turn/session/legality,
persists player move, obtains bounded engine reply, and returns new state. This
feature is isolated from evidence unless a future explicit assessment contract
promotes it.

### `DELETE /play/sessions/{sessionId}`

Ends a session idempotently.

## 15. Internal service endpoints

Internal endpoints use `/internal/v1`, private ingress, Google OIDC audience,
service-account allowlists, and no browser CORS.

### `POST /internal/v1/work-items/{workItemId}/execute`

Shared worker entry shape. `attemptToken` and expected kind are validated; each
deployment accepts only its handler allowlist. Returns `204` after authoritative
transition or a retry-classified status.

### `POST /internal/v1/outbox/dispatch`

Ops only. Claims committed outbox rows, creates Cloud Tasks idempotently, marks
dispatch outcome.

### `POST /internal/v1/work-items/recover-leases`

Ops only. Requeues/dead-letters expired items after output reconciliation.

### `POST /internal/v1/syncs/enqueue-due`

Ops only. Creates account sync workflows under provider/account constraints.

### `POST /internal/v1/retention/run`

Ops only. Advances deletion/export/artifact retention workflows.

### `GET /internal/v1/ready`

Private readiness with dependency checks safe for platform health probes.

## 16. Compatibility and deprecation

- Current unversioned prototype endpoints remain only behind a temporary legacy
  adapter while frontend routes migrate.
- No new feature targets legacy tables/routes.
- A v1 additive response field is nonbreaking; removing/renaming/changing meaning
  is breaking.
- Breaking behavior requires a new API version or an explicitly negotiated
  compatibility window and migration.
- Deprecated endpoints emit `Deprecation`/`Sunset` headers and metrics.
- Legacy writes stop only after v1 shadow reads and reconciliation pass.
